//! Images for the editor's markdown preview.
//!
//! A README's images fail two different ways in the webview. Remote ones
//! (badges, contributor walls) are refused by the renderer CSP, whose
//! `img-src` names only local origins and two avatar hosts. Relative ones
//! (`docs/shot.png`) resolve against the app's own origin, not the file's
//! folder, and 404. Both come through here instead and go back as a `data:`
//! URL, which the CSP already allows.
//!
//! Widening `img-src` to `https:` was the other option. It would fix the
//! first case only, and let every markdown file the user opens make the
//! webview itself call arbitrary hosts. Fetching from Rust keeps the CSP as
//! it is and holds each request to the same public-host rule as
//! `fetch_readable`.

use std::path::{Path, PathBuf};

use base64::Engine;

use super::knowledge::get_public_url;

/// A data URL is 4/3 the image, crosses IPC whole and lives in the JS heap
/// while the preview is open. A README image past this is not a README image.
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// The image types a preview inlines, by extension. Anything else on disk is
/// refused: this resolves paths the markdown names, and a markdown file is
/// not a reason to hand the renderer `~/.ssh/id_rsa`.
fn image_mime(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            "jpg" | "jpeg" => "image/jpeg",
            "ico" => "image/x-icon",
            "bmp" => "image/bmp",
            _ => return None,
        },
    )
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Where a local `src` points, the way GitHub reads it: relative to the
/// document's folder, or — with a leading `/` — relative to the repository
/// root (the nearest ancestor holding `.git`, else the document's folder).
/// Percent-escapes are decoded and any `?query` / `#fragment` dropped.
fn resolve_local(doc_path: &Path, src: &str) -> Result<PathBuf, String> {
    let doc_dir = doc_path
        .parent()
        .ok_or_else(|| "document has no folder".to_string())?;
    let (base, rel) = match src.strip_prefix('/') {
        Some(rest) => (
            doc_dir
                .ancestors()
                .find(|d| d.join(".git").exists())
                .unwrap_or(doc_dir),
            rest,
        ),
        None => (doc_dir, src),
    };
    // `Url::join` does the decoding, the `..` folding and the query/fragment
    // stripping a hand-rolled join would each get slightly wrong.
    let base_url = url::Url::from_directory_path(base)
        .map_err(|_| "document path is not absolute".to_string())?;
    base_url
        .join(rel)
        .ok()
        .filter(|u| u.scheme() == "file")
        .and_then(|u| u.to_file_path().ok())
        .ok_or_else(|| format!("not a local image path: {src}"))
}

fn read_local(doc_path: &Path, src: &str) -> Result<String, String> {
    let path = resolve_local(doc_path, src)?;
    let mime = image_mime(&path).ok_or_else(|| format!("not an image: {src}"))?;
    let len = std::fs::metadata(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len();
    if len > MAX_IMAGE_BYTES as u64 {
        return Err("image is too large to preview (10 MB max)".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(data_url(mime, &bytes))
}

async fn fetch_remote(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        // `get_public_url` re-checks every hop; an automatic redirect would not.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = get_public_url(&client, url).await?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status().as_u16()));
    }
    // The server's word on the type, not the URL's: badge endpoints
    // (`/api/badge/…`, `/image?repo=…`) carry no extension at all.
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| v.starts_with("image/"))
        .ok_or_else(|| format!("{url}: not an image"))?;
    // Counted as it streams: Content-Length is optional and can lie.
    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Read failed: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("image is too large to preview (10 MB max)".to_string());
        }
    }
    Ok(data_url(&mime, &bytes))
}

/// One image in the markdown preview of `doc_path`, as a `data:` URL. `src`
/// is the attribute exactly as the markdown wrote it: an http(s) URL, or a
/// path relative to the document (or to the repo root, with a leading `/`).
#[tauri::command]
pub async fn markdown_preview_image(doc_path: String, src: String) -> Result<String, String> {
    let src = src.trim();
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return fetch_remote(src).await;
    }
    if src.is_empty() || src.contains("://") || lower.starts_with("data:") {
        return Err(format!("unsupported image source: {src}"));
    }
    let src = src.to_string();
    tokio::task::spawn_blocking(move || read_local(Path::new(&doc_path), &src))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("docs/img")).unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("docs/img/a b.png"), b"png!").unwrap();
        std::fs::write(dir.path().join("assets/logo.svg"), b"<svg/>").unwrap();
        std::fs::write(dir.path().join("docs/secret.txt"), b"no").unwrap();
        dir
    }

    #[test]
    fn relative_paths_resolve_against_the_document() {
        let dir = repo();
        let doc = dir.path().join("docs/README.md");
        let url = read_local(&doc, "img/a%20b.png?raw=true#x").unwrap();
        assert_eq!(url, data_url("image/png", b"png!"));
        let url = read_local(&doc, "./../assets/logo.svg").unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn a_leading_slash_is_the_repository_root() {
        let dir = repo();
        let doc = dir.path().join("docs/README.md");
        assert!(read_local(&doc, "/assets/logo.svg").is_ok());
    }

    #[test]
    fn only_images_are_read() {
        let dir = repo();
        let doc = dir.path().join("docs/README.md");
        assert!(read_local(&doc, "secret.txt").is_err());
        assert!(read_local(&doc, "missing.png").is_err());
    }

    #[tokio::test]
    async fn other_schemes_are_refused() {
        let dir = repo();
        let doc = dir
            .path()
            .join("docs/README.md")
            .to_string_lossy()
            .to_string();
        for src in [
            "",
            "file:///etc/hosts",
            "data:image/png;base64,AA==",
            "ftp://x/y.png",
        ] {
            assert!(
                markdown_preview_image(doc.clone(), src.into())
                    .await
                    .is_err(),
                "{src} must be refused"
            );
        }
    }

    #[tokio::test]
    async fn private_hosts_are_refused() {
        let doc = "/tmp/README.md".to_string();
        for src in [
            "http://127.0.0.1/x.png",
            "http://169.254.169.254/latest",
            "http://[::1]/x.png",
        ] {
            assert!(markdown_preview_image(doc.clone(), src.into())
                .await
                .is_err());
        }
    }
}
