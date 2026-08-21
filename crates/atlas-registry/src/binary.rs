//! Binary-distribution download + verify + extract.
//!
//! Layout: `<app_data>/external-agents/{id}/v_<sha256(version+url)[..16]>/`.
//! The hash covers version AND archive URL so a manifest correction (same
//! version, different asset) never collides with a stale extract. A
//! `.complete` marker gates the fast path; a `.part` file holds the streaming
//! download until the checksum verifies — unverified bytes are never
//! executed when the manifest published a sha256.

use std::io::Write;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};

use crate::cache::sanitize_id;
use crate::error::{RegistryError, Result};
use crate::install_store::ResolvedBinary;
use crate::manifest::BinaryTarget;

const COMPLETE_MARKER: &str = ".complete";

/// Byte-level progress for the marketplace install UI.
pub type ProgressFn = dyn Fn(u64, Option<u64>) + Send + Sync;

pub fn versioned_cache_dir(root: &Path, id: &str, version: &str, archive_url: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(version.as_bytes());
    hasher.update(archive_url.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    root.join(sanitize_id(id)).join(format!("v_{}", &hash[..16]))
}

/// Ensure the target's payload is downloaded + extracted, returning the
/// resolved entry command. Fast path: `.complete` marker present.
pub async fn ensure_binary(
    root: &Path,
    id: &str,
    version: &str,
    target: &BinaryTarget,
    progress: Option<&ProgressFn>,
) -> Result<ResolvedBinary> {
    let dir = versioned_cache_dir(root, id, version, &target.archive);
    if !dir.join(COMPLETE_MARKER).is_file() {
        download_and_extract(&dir, id, target, progress).await?;
        prune_stale_versions(root, id, &dir);
    }
    resolve_entry(&dir, target).map(|(entry_cmd, args)| ResolvedBinary {
        cache_dir: dir.to_string_lossy().into_owned(),
        entry_cmd,
        args,
        env: target.env.clone(),
    })
}

async fn download_and_extract(
    dir: &Path,
    id: &str,
    target: &BinaryTarget,
    progress: Option<&ProgressFn>,
) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let part = dir.join("payload.part");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| RegistryError::Download(e.to_string()))?;
    let resp = client
        .get(&target.archive)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| RegistryError::Download(e.to_string()))?;
    let total = resp.content_length();

    let mut file = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    // Throttle progress to 256 KB steps (plus the final byte count below).
    // The callback becomes a Tauri emit → JSON serialize → webview event →
    // React render; unthrottled it fired per ~16 KB network chunk — ~2,500
    // grid re-renders for a 40 MB binary.
    const PROGRESS_STEP: u64 = 256 * 1024;
    let mut last_reported: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| RegistryError::Download(e.to_string()))?;
        hasher.update(&chunk);
        file.write_all(&chunk)?;
        received += chunk.len() as u64;
        if let Some(progress) = progress {
            if received - last_reported >= PROGRESS_STEP {
                last_reported = received;
                progress(received, total);
            }
        }
    }
    if let Some(progress) = progress {
        if received > last_reported {
            progress(received, total); // final tick — the bar must land on 100%
        }
    }
    file.flush()?;
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if let Some(expected) = &target.sha256 {
        if !expected.eq_ignore_ascii_case(&actual) {
            let _ = std::fs::remove_file(&part);
            return Err(RegistryError::ChecksumMismatch {
                id: id.to_string(),
                expected: expected.clone(),
                actual,
            });
        }
    } else {
        tracing::warn!(
            target: "atlas_registry",
            "binary distribution for {id} published no sha256 — installing unverified"
        );
    }

    let kind = ArchiveKind::sniff(&target.archive);
    let dir_owned = dir.to_path_buf();
    let part_owned = part.clone();
    let cmd = target.cmd.clone();
    tokio::task::spawn_blocking(move || extract(&part_owned, &dir_owned, kind, &cmd))
        .await
        .map_err(|e| RegistryError::Download(format!("extract task failed: {e}")))??;

    let _ = std::fs::remove_file(&part);
    // Marker records the payload hash for post-hoc verification/debugging.
    std::fs::write(dir.join(COMPLETE_MARKER), actual)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ArchiveKind {
    Zip,
    TarGz,
    /// goose ships `.tar.bz2` in the official registry (block/goose releases).
    TarBz2,
    /// An archive format we don't handle — refuse rather than mis-install.
    Unsupported,
    /// URL without a recognized archive extension → the payload IS the binary.
    Raw,
}

impl ArchiveKind {
    fn sniff(url: &str) -> Self {
        let path = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
        if path.ends_with(".zip") {
            Self::Zip
        } else if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
            Self::TarGz
        } else if path.ends_with(".tar.bz2") || path.ends_with(".tbz2") {
            Self::TarBz2
        } else if path.ends_with(".tar.xz") || path.ends_with(".txz") || path.ends_with(".7z") {
            // Fail closed HERE, off the URL. The old guard checked the
            // downloaded payload's filename — a temp name with no extension —
            // so unhandled archives sniffed as Raw and the compressed blob was
            // installed as the "binary" (exactly how goose broke).
            Self::Unsupported
        } else {
            Self::Raw
        }
    }
}

fn extract(payload: &Path, dir: &Path, kind: ArchiveKind, cmd: &str) -> Result<()> {
    match kind {
        ArchiveKind::Unsupported => {
            return Err(RegistryError::UnsupportedArchiveFormat(
                payload.to_string_lossy().to_string(),
            ));
        }
        ArchiveKind::Zip => {
            let file = std::fs::File::open(payload)?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| RegistryError::Download(format!("bad zip: {e}")))?;
            archive
                .extract(dir)
                .map_err(|e| RegistryError::Download(format!("zip extract: {e}")))?;
        }
        ArchiveKind::TarGz => {
            let file = std::fs::File::open(payload)?;
            let gz = flate2::read::GzDecoder::new(file);
            let mut archive = tar::Archive::new(gz);
            archive.unpack(dir)?;
        }
        ArchiveKind::TarBz2 => {
            let file = std::fs::File::open(payload)?;
            let bz = bzip2::read::BzDecoder::new(file);
            let mut archive = tar::Archive::new(bz);
            archive.unpack(dir)?;
        }
        ArchiveKind::Raw => {
            // The payload is the executable itself; name it after `cmd`'s
            // basename (`./amp-acp` → `amp-acp`).
            let name = cmd.trim_start_matches("./");
            let name = if name.is_empty() { "agent" } else { name };
            let dest = dir.join(name);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(payload, &dest)?;
        }
    }
    // Make the entry executable (archives don't always preserve mode bits,
    // and the raw path never has them).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let entry = dir.join(cmd.trim_start_matches("./"));
        if entry.is_file() {
            let _ = std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

/// Map the manifest's `cmd` to an absolute entry command. `"node"` is passed
/// through — the spawn layer resolves the Node toolchain (managed install
/// wins); anything else must be a `./relative` path inside the extract dir.
fn resolve_entry(dir: &Path, target: &BinaryTarget) -> Result<(String, Vec<String>)> {
    if target.cmd == "node" {
        // Args are script paths relative to the extract dir.
        let args = target
            .args
            .iter()
            .map(|a| {
                if a.starts_with("./") || !a.starts_with('/') && a.ends_with(".js") {
                    dir.join(a.trim_start_matches("./")).to_string_lossy().into_owned()
                } else {
                    a.clone()
                }
            })
            .collect();
        return Ok(("node".to_string(), args));
    }
    if !target.cmd.starts_with("./") {
        return Err(RegistryError::Download(format!(
            "registry binary cmd must be \"node\" or a ./relative path, got {:?}",
            target.cmd
        )));
    }
    let entry = dir.join(target.cmd.trim_start_matches("./"));
    if !entry.is_file() {
        return Err(RegistryError::Download(format!(
            "entry {:?} missing after extract",
            entry
        )));
    }
    Ok((entry.to_string_lossy().into_owned(), target.args.clone()))
}

/// Remove older version dirs for this agent, keeping the current one.
fn prune_stale_versions(root: &Path, id: &str, keep: &Path) {
    let agent_dir = root.join(sanitize_id(id));
    let Ok(entries) = std::fs::read_dir(&agent_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path != keep && path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("v_")) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_kind_sniffs_by_extension_ignoring_query() {
        assert_eq!(ArchiveKind::sniff("https://x/y.zip?token=1"), ArchiveKind::Zip);
        assert_eq!(ArchiveKind::sniff("https://x/y.tar.gz"), ArchiveKind::TarGz);
        assert_eq!(ArchiveKind::sniff("https://x/y.tgz"), ArchiveKind::TarGz);
        assert_eq!(ArchiveKind::sniff("https://x/amp-acp"), ArchiveKind::Raw);
        // goose's real distribution URL — must extract, not install the blob.
        assert_eq!(
            ArchiveKind::sniff(
                "https://github.com/block/goose/releases/download/v1.46.0/goose-aarch64-apple-darwin.tar.bz2"
            ),
            ArchiveKind::TarBz2
        );
        // Unhandled formats fail closed AT SNIFF (off the URL): the payload's
        // temp filename carries no extension, so a payload-side guard never
        // fired and the compressed blob installed as the "binary".
        assert_eq!(ArchiveKind::sniff("https://x/y.tar.xz"), ArchiveKind::Unsupported);
        assert_eq!(ArchiveKind::sniff("https://x/y.7z"), ArchiveKind::Unsupported);
    }

    #[test]
    fn version_dir_changes_with_url() {
        let root = Path::new("/tmp/x");
        let a = versioned_cache_dir(root, "amp", "1.0.0", "https://a/one.tar.gz");
        let b = versioned_cache_dir(root, "amp", "1.0.0", "https://a/two.tar.gz");
        assert_ne!(a, b);
    }
}
