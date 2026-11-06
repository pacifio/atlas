//! A project's own icon, found in its tree: the favicon or app icon a web or
//! desktop project already ships. The sidebar, the palette and the project
//! picker show it in place of the monogram.
//!
//! The search, in order: well-known icon files (`favicon.svg`,
//! `public/favicon.ico`, `app/icon.png`, …), then the `<link rel="icon">`
//! (or a `{ rel: "icon", href }` route-head object) in the project's HTML
//! entry or root route, resolved against `public/` and the root. Nothing is
//! read outside the project. The answer is a `data:` URL, so the webview
//! needs no file-system scope for it, and it is cached per project: found
//! icons for ten minutes, misses for one, so a favicon added mid-session
//! shows up without a restart.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use parking_lot::Mutex;

const POSITIVE_TTL: Duration = Duration::from_secs(10 * 60);
const NEGATIVE_TTL: Duration = Duration::from_secs(60);
/// A favicon is a few KB; anything this large is not one.
const MAX_ICON_BYTES: u64 = 512 * 1024;
/// HTML and route sources are scanned only this far.
const MAX_SOURCE_BYTES: u64 = 256 * 1024;

const ICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
];

const ICON_SOURCE_FILES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

struct Cached {
    icon: Option<String>,
    at: Instant,
}

static CACHE: Mutex<Option<HashMap<PathBuf, Cached>>> = Mutex::new(None);

/// The project's icon as a `data:` URL, or `null` when it ships none.
#[tauri::command]
pub async fn project_icon(project_path: String) -> Result<Option<String>, String> {
    let root = PathBuf::from(project_path);
    if let Some(hit) = cached(&root) {
        return Ok(hit);
    }
    let lookup = root.clone();
    let icon = tokio::task::spawn_blocking(move || find_icon(&lookup))
        .await
        .map_err(|e| e.to_string())?;
    CACHE.lock().get_or_insert_with(HashMap::new).insert(
        root,
        Cached {
            icon: icon.clone(),
            at: Instant::now(),
        },
    );
    Ok(icon)
}

fn cached(root: &Path) -> Option<Option<String>> {
    let guard = CACHE.lock();
    let entry = guard.as_ref()?.get(root)?;
    let ttl = if entry.icon.is_some() {
        POSITIVE_TTL
    } else {
        NEGATIVE_TTL
    };
    (entry.at.elapsed() < ttl).then(|| entry.icon.clone())
}

fn find_icon(root: &Path) -> Option<String> {
    if !root.is_dir() {
        return None;
    }
    if let Some(found) = ICON_CANDIDATES
        .iter()
        .find_map(|rel| existing_file(root, rel))
    {
        return data_url(&found);
    }
    ICON_SOURCE_FILES.iter().find_map(|rel| {
        let source = existing_file(root, rel)?;
        let text = read_capped(&source, MAX_SOURCE_BYTES)?;
        let href = extract_icon_href(&text)?;
        let clean = href.trim_start_matches('/');
        let found = existing_file(root, &format!("public/{clean}"))
            .or_else(|| existing_file(root, clean))?;
        data_url(&found)
    })
}

/// `rel` under `root`, when it is a file and stays inside the project.
fn existing_file(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return None;
    }
    let path = root.join(rel);
    path.is_file().then_some(path)
}

fn read_capped(path: &Path, cap: u64) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(cap)
        .read_to_end(&mut buf)
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn mime_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    })
}

fn data_url(path: &Path) -> Option<String> {
    let mime = mime_for(path)?;
    if std::fs::metadata(path).ok()?.len() > MAX_ICON_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// The icon `href` in an HTML entry (`<link rel="icon" href="…">`) or a
/// route head object (`{ rel: "icon", href: "…" }`). A query string is
/// dropped; the first match wins.
fn extract_icon_href(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let mut from = 0;
    while let Some(start) = lower[from..].find("<link") {
        let start = from + start;
        let end = lower[start..].find('>').map_or(lower.len(), |e| start + e);
        let tag = &source[start..end];
        if is_icon_rel(&tag.to_ascii_lowercase()) {
            if let Some(href) = attr_value(tag, "href") {
                return Some(href);
            }
        }
        from = end;
    }
    // Brace-free runs, so one object's `rel` never pairs with another's href.
    source.split(['{', '}']).find_map(|run| {
        let lower = run.to_ascii_lowercase();
        if !is_icon_rel(&lower) {
            return None;
        }
        attr_value(run, "href")
    })
}

fn is_icon_rel(lower: &str) -> bool {
    ["icon", "shortcut icon"].iter().any(|rel| {
        ["=\"", "='", ": \"", ": '", ":\"", ":'"]
            .iter()
            .any(|sep| lower.contains(&format!("rel{sep}{rel}{}", &sep[sep.len() - 1..])))
    })
}

/// The quoted value after `name=` or `name:` in `text`, without its query.
fn attr_value(text: &str, name: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let i = from + i;
        from = i + name.len();
        // A whole word: not the tail of `data-href`.
        let before = lower[..i].chars().last();
        if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            continue;
        }
        let rest = text[from..].trim_start();
        let Some(rest) = rest.strip_prefix(['=', ':']) else {
            continue;
        };
        let rest = rest.trim_start();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let value = &rest[1..];
        let value = &value[..value.find(quote)?];
        let value = value.split('?').next().unwrap_or_default();
        if !value.is_empty() && !value.starts_with("data:") && !value.contains("://") {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_link_icon_in_html() {
        let html = r#"<head><link rel="stylesheet" href="a.css"><link rel="icon" type="image/svg+xml" href="/logo.svg?v=2"></head>"#;
        assert_eq!(extract_icon_href(html).as_deref(), Some("/logo.svg"));
    }

    #[test]
    fn finds_href_before_rel() {
        let html = r#"<link href='/fav.png' rel='shortcut icon'>"#;
        assert_eq!(extract_icon_href(html).as_deref(), Some("/fav.png"));
    }

    #[test]
    fn finds_a_route_head_object() {
        let src =
            r#"links: [{ rel: "stylesheet", href: css }, { rel: "icon", href: "/favicon.ico" }]"#;
        assert_eq!(extract_icon_href(src).as_deref(), Some("/favicon.ico"));
    }

    #[test]
    fn ignores_remote_icons() {
        let html = r#"<link rel="icon" href="https://cdn.example.com/x.png">"#;
        assert_eq!(extract_icon_href(html), None);
    }

    #[test]
    fn prefers_well_known_files_and_stays_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("public")).unwrap();
        std::fs::write(dir.path().join("public/favicon.svg"), "<svg/>").unwrap();
        std::fs::write(
            dir.path().join("index.html"),
            r#"<link rel="icon" href="/other.png">"#,
        )
        .unwrap();
        let icon = find_icon(dir.path()).unwrap();
        assert!(icon.starts_with("data:image/svg+xml;base64,"));
        assert!(existing_file(dir.path(), "../etc/passwd").is_none());
    }

    #[test]
    fn follows_the_html_link_into_public() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("public")).unwrap();
        std::fs::write(
            dir.path().join("public/brand.png"),
            [0x89, b'P', b'N', b'G'],
        )
        .unwrap();
        std::fs::write(
            dir.path().join("index.html"),
            r#"<link rel="icon" href="/brand.png">"#,
        )
        .unwrap();
        assert!(find_icon(dir.path())
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn none_without_an_icon() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_icon(dir.path()), None);
    }
}
