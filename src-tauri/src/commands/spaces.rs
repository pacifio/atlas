//! Realtime Spaces: the bridge between `atlas_comms::spaces` and the renderer.
//!
//! Same trust boundary as `commands::comms` — only Rust holds the Bearer, so
//! the renderer can neither dial the Space socket nor fetch its media. Frames
//! are shuttled opaquely (`atlas:spaces` window events); every codec decision
//! lives in the renderer, mirroring the web client.

use atlas_comms::spaces::{SpaceSummary, SpacesManager};
use tauri::{AppHandle, Manager};

use super::comms::{manager as comms_manager, map_err as map_comms_err, org as org_of};

/// The window event channel, one per subsystem like `atlas:comms`.
pub const SPACES_EVENT: &str = "atlas:spaces";

pub struct SpacesState(pub SpacesManager);

/// Ids reach URLs and filenames; hold them to their server shape so a
/// compromised renderer cannot splice `&`, `/` or `..` into a path or query
/// built around them. (Server ids are ULIDs / UUID-ish tokens.)
fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("bad id".to_string());
    }
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("bad id".to_string());
    }
    Ok(())
}

fn spaces(app: &AppHandle) -> Result<SpacesManager, String> {
    app.try_state::<SpacesState>()
        .map(|s| s.0.clone())
        .ok_or_else(|| "spaces is not ready".to_string())
}

/// The org + managers every command starts from. Spaces piggybacks on the chat
/// manager's active org — one source of truth for "which server org am I".
fn ctx(app: &AppHandle) -> Result<(SpacesManager, atlas_comms::CommsManager, String), String> {
    let sp = spaces(app)?;
    let mgr = comms_manager(app)?;
    let org = org_of(&mgr)?;
    Ok((sp, mgr, org))
}

/// Open (or share) the socket for a conversation's Space.
#[tauri::command(async)]
pub async fn spaces_connect(app: AppHandle, conv_id: String) -> Result<(), String> {
    safe_id(&conv_id)?;
    let (sp, _, org) = ctx(&app)?;
    sp.connect(&org, &conv_id);
    Ok(())
}

#[tauri::command(async)]
pub async fn spaces_disconnect(app: AppHandle, conv_id: String) -> Result<(), String> {
    safe_id(&conv_id)?;
    spaces(&app)?.disconnect(&conv_id);
    Ok(())
}

/// The server's `error.detail.reconnect === true` instruction: drop the socket
/// and redial for fresh slots.
#[tauri::command(async)]
pub async fn spaces_cycle(app: AppHandle, conv_id: String) -> Result<(), String> {
    safe_id(&conv_id)?;
    spaces(&app)?.cycle(&conv_id);
    Ok(())
}

/// Send one JSON control frame, already built against the contract renderer-side.
#[tauri::command(async)]
pub async fn spaces_send_control(
    app: AppHandle,
    conv_id: String,
    frame: String,
) -> Result<(), String> {
    spaces(&app)?.send_control(&conv_id, frame);
    Ok(())
}

/// Send one binary frame (base64). Updates and awareness both ride here.
#[tauri::command(async)]
pub async fn spaces_send_binary(
    app: AppHandle,
    conv_id: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "bad base64".to_string())?;
    spaces(&app)?.send_binary(&conv_id, bytes);
    Ok(())
}

/// The REST pre-flight: creates the Space lazily and maps 401/403/404 to
/// refusals a UI can render — a failed WS handshake cannot say why.
#[tauri::command(async)]
pub async fn spaces_summary(app: AppHandle, conv_id: String) -> Result<SpaceSummary, String> {
    safe_id(&conv_id)?;
    let (_, mgr, org) = ctx(&app)?;
    mgr.rest()
        .space_summary(&org, &conv_id)
        .await
        .map_err(map_comms_err)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMediaUploaded {
    pub content_hash: String,
    pub mime: String,
    pub media_kind: String,
    pub bytes: u64,
}

/// The contract's media allowlist — no SVG, deliberately; that absence is the
/// whole XSS defence for `inline` serving. Mime is derived from the extension
/// because no filename ever crosses the wire.
fn media_mime(path: &std::path::Path) -> Option<(&'static str, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ("image/png", "image"),
        "jpg" | "jpeg" => ("image/jpeg", "image"),
        "gif" => ("image/gif", "image"),
        "webp" => ("image/webp", "image"),
        "mp4" => ("video/mp4", "video"),
        "webm" => ("video/webm", "video"),
        _ => return None,
    })
}

const SPACE_MEDIA_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Hash → reserve → deliver. `stored: true` on the reservation is dedup and
/// skips the PUT entirely. The caller adds the canvas node only after this
/// resolves — an upload failure must never leave a broken node in the doc.
#[tauri::command(async)]
pub async fn spaces_media_upload(
    app: AppHandle,
    conv_id: String,
    path: String,
) -> Result<SpaceMediaUploaded, String> {
    safe_id(&conv_id)?;
    let (_, mgr, org) = ctx(&app)?;
    let file = std::path::PathBuf::from(&path);
    let Some((mime, kind)) = media_mime(&file) else {
        return Err("unsupported media type".to_string());
    };
    // Size gate BEFORE the read: a 4GB .mp4 must be refused from metadata,
    // not loaded into RAM to be measured.
    let size_on_disk = tokio::fs::metadata(&file).await.map_err(|e| e.to_string())?.len();
    if size_on_disk > SPACE_MEDIA_MAX_BYTES {
        return Err("file is larger than the 64 MiB media limit".to_string());
    }
    let bytes = tokio::fs::read(&file).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SPACE_MEDIA_MAX_BYTES {
        return Err("file is larger than the 64 MiB media limit".to_string());
    }

    // Lowercase hex SHA-256 — the object's identity and the R2 write check.
    let content_hash = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    };

    let size = bytes.len() as u64;
    let reserved = mgr
        .rest()
        .space_media_reserve(&org, &conv_id, &content_hash, mime, size)
        .await
        .map_err(map_comms_err)?;
    if !reserved.stored {
        mgr.rest()
            .space_media_put(&org, &conv_id, &content_hash, mime, bytes)
            .await
            .map_err(map_comms_err)?;
    }

    Ok(SpaceMediaUploaded {
        content_hash,
        mime: mime.to_string(),
        media_kind: kind.to_string(),
        bytes: size,
    })
}

/// Ensure a media object is in the local cache and return its absolute path
/// for `convertFileSrc`. Cached by hash — the object is immutable, so the
/// web's ticket-renewal dance does not apply here.
#[tauri::command(async)]
pub async fn spaces_media_fetch(
    app: AppHandle,
    conv_id: String,
    content_hash: String,
    mime: String,
) -> Result<String, String> {
    safe_id(&conv_id)?;
    // The hash is the filename; hold it to its contract shape so it can never
    // be a path.
    if content_hash.len() != 64 || !content_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("bad content hash".to_string());
    }
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("spaces-media");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{content_hash}.{ext}"));
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }

    let (_, mgr, org) = ctx(&app)?;
    let bytes = mgr
        .rest()
        .space_media_download(&org, &conv_id, &content_hash)
        .await
        .map_err(map_comms_err)?;
    // The hash IS the object's identity, and this cache is immutable by
    // name — verify before the bytes become permanent, or a misbehaving
    // server poisons that hash's slot forever.
    let actual = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    };
    if actual != content_hash {
        return Err("media bytes did not match their content hash".to_string());
    }
    let tmp = dir.join(format!(".{content_hash}.part"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_mime_allowlist_matches_contract() {
        use std::path::Path;
        assert_eq!(media_mime(Path::new("a.PNG")), Some(("image/png", "image")));
        assert_eq!(media_mime(Path::new("a.jpeg")), Some(("image/jpeg", "image")));
        assert_eq!(media_mime(Path::new("a.webm")), Some(("video/webm", "video")));
        // SVG's absence is the defence, not an oversight.
        assert_eq!(media_mime(Path::new("a.svg")), None);
        assert_eq!(media_mime(Path::new("noext")), None);
    }
}
