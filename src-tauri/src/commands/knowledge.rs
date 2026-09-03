use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct KnowledgeEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub source: String, // "note", "paper", "chat", "interaction"
    pub file_path: String,
    pub updated_at: String,
}

/// List all knowledge entries recursively from .atlas/knowledge/
///
/// IMPORTANT: every `#[tauri::command]` in this module is declared `async`
/// and dispatches its I/O through `tokio::task::spawn_blocking`. Sync
/// commands run on the NSApp main thread; doing real filesystem work there
/// freezes the entire app while the syscall blocks. Boot cascade members
/// (`list_knowledge`, `load_editor_state`) were the chief offenders.
#[tauri::command]
pub async fn list_knowledge(project_path: String) -> Result<Vec<KnowledgeEntry>, String> {
    tokio::task::spawn_blocking(move || list_knowledge_sync(&project_path))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn list_knowledge_sync(project_path: &str) -> Result<Vec<KnowledgeEntry>, String> {
    let kb_dir = Path::new(project_path).join(".atlas").join("knowledge");
    if !kb_dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = Vec::new();
    walk_knowledge(&kb_dir, &kb_dir, &mut entries);
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(entries)
}

fn walk_knowledge(dir: &Path, root: &Path, entries: &mut Vec<KnowledgeEntry>) {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    for entry in read.flatten() {
        let path = entry.path();

        if path.is_dir() {
            walk_knowledge(&path, root, entries);
            continue;
        }

        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Use relative path (without .md) as the ID so nested notes work
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let id = rel.with_extension("").to_string_lossy().to_string();

        let filename = path.file_stem().unwrap_or_default().to_string_lossy().to_string();

        // Use only the filename as the wire-side title fallback. The
        // user-edited page-header title lives in `_meta.json` and is
        // merged client-side; deriving a title from the first `#` line
        // here meant the tree label drifted to the body's first heading
        // (often a content paragraph after a markdown auto-shortcut),
        // which was confusing and inconsistent with the page header.
        let title = filename.clone();

        let source = if filename.starts_with("paper-") { "paper" }
            else if filename.starts_with("chat-") { "chat" }
            else { "note" };

        let updated_at = fs::metadata(&path).ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339()).unwrap_or_default()
            }).unwrap_or_default();

        entries.push(KnowledgeEntry {
            id,
            title,
            content,
            source: source.to_string(),
            file_path: path.to_string_lossy().to_string(),
            updated_at,
        });
    }
}

/// Save a knowledge note (supports nested paths like "Adib/note-123")
#[tauri::command]
pub async fn save_knowledge_note(
    project_path: String,
    id: String,
    content: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let kb_dir = Path::new(&project_path).join(".atlas").join("knowledge");
        let filepath = kb_dir.join(format!("{id}.md"));
        if let Some(parent) = filepath.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&filepath, &content).map_err(|e| e.to_string())?;
        Ok(filepath.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize, Default)]
pub struct KbImportResult {
    pub notes_imported: usize,
    pub files_copied: usize,
}

/// A destination path that doesn't clobber an existing file — appends `-1`,
/// `-2`, … before the extension. Import must never overwrite existing notes.
fn unique_dest(dest: &Path) -> std::path::PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|e| e.to_string_lossy().to_string());
    let parent = dest.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
    for n in 1.. {
        let name = match &ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Recursively copy `src` (relative to `rel` under `kb`) into the KB dir. `.md`
/// files become notes; other files (images, code, attachments) are copied so an
/// imported vault stays intact. Hidden entries (`.obsidian`, `.git`, …) skipped.
fn import_path(src: &Path, rel: &Path, kb: &Path, res: &mut KbImportResult) -> Result<(), String> {
    if src.is_dir() {
        for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            import_path(&entry.path(), &rel.join(&name), kb, res)?;
        }
        Ok(())
    } else if src.is_file() {
        let dest = unique_dest(&kb.join(rel));
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(src, &dest).map_err(|e| e.to_string())?;
        let is_md = src
            .extension()
            .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
            .unwrap_or(false);
        if is_md {
            res.notes_imported += 1;
        } else {
            res.files_copied += 1;
        }
        Ok(())
    } else {
        Ok(())
    }
}

/// Import external `.md` files and/or folders (e.g. an Obsidian vault) into the
/// project KB at `.atlas/knowledge/`, preserving folder structure. Folder
/// sources are namespaced under their own name so the vault layout is kept.
#[tauri::command]
pub async fn import_into_knowledge(
    project_path: String,
    sources: Vec<String>,
) -> Result<KbImportResult, String> {
    tokio::task::spawn_blocking(move || -> Result<KbImportResult, String> {
        let kb = Path::new(&project_path).join(".atlas").join("knowledge");
        fs::create_dir_all(&kb).map_err(|e| e.to_string())?;
        let mut res = KbImportResult::default();
        for src in &sources {
            let p = Path::new(src);
            let Some(name) = p.file_name() else { continue };
            import_path(p, Path::new(name), &kb, &mut res)?;
        }
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a knowledge note
#[tauri::command]
pub async fn delete_knowledge_note(
    project_path: String,
    id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let filepath = Path::new(&project_path)
            .join(".atlas")
            .join("knowledge")
            .join(format!("{id}.md"));
        if filepath.exists() {
            fs::remove_file(&filepath).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a directory inside .atlas/knowledge/
#[tauri::command]
pub async fn create_knowledge_dir(project_path: String, dir_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = Path::new(&project_path)
            .join(".atlas")
            .join("knowledge")
            .join(&dir_name);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a chosen image into `<project>/.atlas/knowledge/covers/` so the
/// cover ships with the project and survives moves. Returns the new
/// path relative to `.atlas/knowledge/` (e.g. `covers/<entryId>.jpg`)
/// suitable for storing in `_meta.json::pages[id].cover`.
#[tauri::command]
pub async fn knowledge_cover_upload(
    project_path: String,
    entry_id: String,
    src_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let src = Path::new(&src_path);
        if !src.exists() {
            return Err("source file not found".to_string());
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_lowercase();
        // Flatten the entry id so a nested note (`folder/note-123`) still
        // gets a flat filename safe for the covers directory.
        let safe_name = entry_id.replace('/', "__");
        let rel = format!("covers/{safe_name}.{ext}");
        let dest = Path::new(&project_path)
            .join(".atlas")
            .join("knowledge")
            .join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(src, &dest).map_err(|e| e.to_string())?;
        Ok(rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a cover image and return it as a `data:` URL (base64). Covers live
/// under the hidden `.atlas/` directory, which Tauri's asset-protocol scope
/// won't serve (the webview 403s the `asset://` request). A data URL embeds
/// the bytes directly so the cover renders identically in dev and bundled
/// builds without depending on the asset protocol or its scope globs.
/// Gradient refs (`gradient:*`) are returned untouched — they're CSS, not files.
#[tauri::command]
pub async fn knowledge_cover_data_url(
    project_path: String,
    cover: String,
) -> Result<String, String> {
    use base64::Engine;
    if cover.starts_with("gradient:") {
        return Ok(cover);
    }
    tokio::task::spawn_blocking(move || {
        let abs = Path::new(&project_path)
            .join(".atlas")
            .join("knowledge")
            .join(&cover);
        let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
        let mime = match abs
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("svg") => "image/svg+xml",
            Some("avif") => "image/avif",
            _ => "image/jpeg",
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{mime};base64,{b64}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append an interaction log entry for context building
#[tauri::command]
pub async fn log_interaction(
    project_path: String,
    interaction_type: String,
    summary: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let atlas_dir = Path::new(&project_path).join(".atlas");
        fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;

        let log_path = atlas_dir.join("interactions.jsonl");
        let entry = serde_json::json!({
            "type": interaction_type,
            "summary": summary,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        let mut line = serde_json::to_string(&entry).unwrap_or_default();
        line.push('\n');

        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(line.as_bytes())
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save editor state (open tabs, active file) per project
#[tauri::command]
pub async fn save_editor_state(
    project_path: String,
    state_json: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let atlas_dir = Path::new(&project_path).join(".atlas");
        fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;
        let state_path = atlas_dir.join("editor-state.json");
        fs::write(&state_path, &state_json).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load editor state for a project
#[tauri::command]
pub async fn load_editor_state(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let state_path = Path::new(&project_path).join(".atlas").join("editor-state.json");
        if state_path.exists() {
            fs::read_to_string(&state_path).map_err(|e| e.to_string())
        } else {
            Ok("{}".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch a URL and return text-only sanitized HTML (no media, no external CSS)
#[tauri::command]
pub async fn fetch_readable(url: String) -> Result<ReadableContent, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .unwrap_or_default();

    let response = client.get(&url).send().await
        .map_err(|e| format!("Fetch failed: {e}"))?;

    let final_url = response.url().to_string();
    let html = response.text().await
        .map_err(|e| format!("Read failed: {e}"))?;

    let title = extract_html_title(&html).unwrap_or_else(|| url.clone());
    let sanitized = sanitize_html(&html, &final_url);

    Ok(ReadableContent {
        title,
        url: final_url,
        html: sanitized,
    })
}

#[derive(Debug, serde::Serialize)]
pub struct ReadableContent {
    pub title: String,
    pub url: String,
    pub html: String,
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let gt = html[start..].find('>')? + start + 1;
    let end = lower[gt..].find("</title")? + gt;
    Some(html[gt..end].trim().to_string())
}

fn strip_style_attributes(html: &str) -> String {
    // Use regex-like find/replace on the string level (safe for multi-byte UTF-8)
    let mut result = html.to_string();
    loop {
        let lower = result.to_lowercase();
        // Find style=" or style='
        let pos = if let Some(p) = lower.find("style=\"") {
            Some((p, '"', 7))
        } else { lower.find("style='").map(|p| (p, '\'', 7)) };

        if let Some((start, quote, offset)) = pos {
            if let Some(end) = result[start + offset..].find(quote) {
                // Remove style="..." including trailing space
                let remove_end = start + offset + end + 1;
                let remove_end = if result.as_bytes().get(remove_end) == Some(&b' ') { remove_end + 1 } else { remove_end };
                result = format!("{}{}", &result[..start], &result[remove_end..]);
                continue;
            }
        }
        break;
    }
    result
}

/// Sanitize HTML: remove dangerous tags, media, styles. Resolve link URLs. Text-only content.
fn sanitize_html(html: &str, base_url: &str) -> String {
    let lower = html.to_lowercase();

    let body = find_body(html, &lower).unwrap_or_else(|| html.to_string());

    // Remove: scripts, styles, media, interactive, nav chrome
    let cleaned = remove_tags(&body, &[
        "script", "style", "noscript", "iframe", "object", "embed", "form",
        "img", "video", "audio", "picture", "figure", "canvas", "svg",
        "nav", "footer", "aside", "dialog", "template",
    ]);

    // Strip inline event handlers (onclick, onerror, onload, ...). The tags
    // above are gone, but a surviving element such as <p onclick="..."> still
    // runs script in the main webview — CSP is null (tauri.conf.json), so
    // nothing else downstream of this function stops it.
    let no_handlers = strip_event_handler_attributes(&cleaned);

    // Resolve relative URLs in href attributes so links work
    let base = base_url.trim_end_matches(|c: char| c != '/').to_string();
    let origin = extract_origin(base_url);
    let resolved = resolve_urls(&no_handlers, &base, &origin);

    // Strip all inline style attributes
    strip_style_attributes(&resolved)
}

/// Strip every `on*` event-handler attribute (`onclick`, `onerror`, `onload`,
/// …) — inline-JS surface that `remove_tags`/`strip_style_attributes` do not
/// touch. Matched by the `on` prefix rather than an enumerated list of names:
/// browsers keep adding handler names, and any fixed list is a standing
/// bypass waiting for the next one. Handles quoted (`"..."`/`'...'`) and bare
/// unquoted values (`onclick=alert(1)` is tolerated, sloppy-but-valid, HTML
/// and still executes).
///
/// String-level, like `strip_style_attributes` above (no HTML parser in this
/// file) — safe on multi-byte UTF-8 since the copy path advances by whole
/// `char`s, not bytes.
fn strip_event_handler_attributes(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut result = String::with_capacity(html.len());
    let mut i = 0;

    while i < bytes.len() {
        if let Some(after_value) = event_handler_attr_end(bytes, i) {
            i = after_value;
            // Drop one attribute-separating space too, so the removal does
            // not leave a double space behind (`<p  onclick="x" id="y">`).
            if bytes.get(i) == Some(&b' ') {
                i += 1;
            }
            continue;
        }
        match html[i..].chars().next() {
            Some(ch) => {
                result.push(ch);
                i += ch.len_utf8();
            }
            None => break,
        }
    }

    result
}

/// If an `on<name>=<value>` attribute starts at byte offset `i`, the offset
/// just past its value; `None` otherwise.
///
/// An attribute boundary, not free text, is required before `on`: the
/// preceding byte must not be alphanumeric, so `"button"` and `"phenomenon"`
/// are left alone (`t`/`n` before their trailing `on` are letters) while
/// `<p onclick=` and `<p data-onclick=` both match — the latter is not a
/// real DOM event handler, but stripping an inert custom attribute is a
/// content nit, not a bypass, so this errs toward removing rather than
/// enumerating what "real" means.
fn event_handler_attr_end(bytes: &[u8], i: usize) -> Option<usize> {
    let is_on = matches!(bytes.get(i), Some(b'o' | b'O')) && matches!(bytes.get(i + 1), Some(b'n' | b'N'));
    if !is_on {
        return None;
    }
    if !matches!(bytes.get(i + 2), Some(c) if c.is_ascii_alphabetic()) {
        return None; // bare "on"/"on1" is not a handler name
    }
    if let Some(prev) = i.checked_sub(1).and_then(|p| bytes.get(p)) {
        if prev.is_ascii_alphanumeric() {
            return None;
        }
    }

    let mut j = i + 2;
    while matches!(bytes.get(j), Some(c) if c.is_ascii_alphanumeric()) {
        j += 1;
    }
    while matches!(bytes.get(j), Some(c) if c.is_ascii_whitespace()) {
        j += 1;
    }
    if bytes.get(j) != Some(&b'=') {
        return None;
    }
    j += 1;
    while matches!(bytes.get(j), Some(c) if c.is_ascii_whitespace()) {
        j += 1;
    }

    match bytes.get(j) {
        Some(b'"') => {
            j += 1;
            while matches!(bytes.get(j), Some(c) if *c != b'"') {
                j += 1;
            }
            Some((j + 1).min(bytes.len()))
        }
        Some(b'\'') => {
            j += 1;
            while matches!(bytes.get(j), Some(c) if *c != b'\'') {
                j += 1;
            }
            Some((j + 1).min(bytes.len()))
        }
        _ => {
            // Unquoted — runs to the next whitespace or tag close.
            while matches!(bytes.get(j), Some(c) if !c.is_ascii_whitespace() && *c != b'>') {
                j += 1;
            }
            Some(j)
        }
    }
}

fn remove_tags(html: &str, tags: &[&str]) -> String {
    let mut result = html.to_string();
    for tag in tags {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let rl = result.to_lowercase();
            if let Some(start) = rl.find(&open) {
                if let Some(end) = rl[start..].find(&close) {
                    result = format!("{}{}", &result[..start], &result[start + end + close.len()..]);
                    continue;
                } else {
                    // Self-closing or unclosed — remove just the tag
                    if let Some(gt) = rl[start..].find('>') {
                        result = format!("{}{}", &result[..start], &result[start + gt + 1..]);
                        continue;
                    }
                }
            }
            break;
        }
    }
    result
}

fn extract_origin(url: &str) -> String {
    // https://example.com/path -> https://example.com
    if let Some(idx) = url.find("://") {
        let after = &url[idx + 3..];
        if let Some(slash) = after.find('/') {
            return url[..idx + 3 + slash].to_string();
        }
        return url.to_string();
    }
    url.to_string()
}

fn resolve_urls(html: &str, base: &str, origin: &str) -> String {
    let mut result = html.to_string();

    // Resolve href="..." and src="..."
    for attr in &["href=\"", "src=\"", "href='", "src='"] {
        let quote = if attr.ends_with('"') { '"' } else { '\'' };
        let mut offset = 0;
        loop {
            let lower = result[offset..].to_lowercase();
            if let Some(start) = lower.find(attr) {
                let abs_start = offset + start + attr.len();
                if let Some(end) = result[abs_start..].find(quote) {
                    let url_val = &result[abs_start..abs_start + end];
                    let resolved = if url_val.starts_with("http://") || url_val.starts_with("https://") || url_val.starts_with("data:") || url_val.starts_with("mailto:") || url_val.starts_with('#') {
                        url_val.to_string()
                    } else if url_val.starts_with("//") {
                        format!("https:{url_val}")
                    } else if url_val.starts_with('/') {
                        format!("{origin}{url_val}")
                    } else {
                        format!("{base}/{url_val}")
                    };
                    if resolved != url_val {
                        result = format!("{}{}{}", &result[..abs_start], resolved, &result[abs_start + end..]);
                    }
                    offset = abs_start + resolved.len() + 1;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }

    result
}

fn find_body(html: &str, lower: &str) -> Option<String> {
    let start = lower.find("<body")?.checked_add(5)?;
    let gt = html[start..].find('>')? + start + 1;
    let end = lower[gt..].find("</body")? + gt;
    Some(html[gt..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_quoted_onclick_handler() {
        // The space between `<p` and `onclick` was copied through before the
        // scanner ever saw "onclick" coming, so it is not this function's to
        // remove — the attribute itself is gone, which is what matters;
        // `<p >` and `<p>` parse identically.
        assert_eq!(
            strip_event_handler_attributes(r#"<p onclick="alert(1)">hi</p>"#),
            "<p >hi</p>"
        );
    }

    #[test]
    fn strips_a_single_quoted_and_an_unquoted_handler() {
        // The unquoted case is the real bypass risk: sloppy-but-valid HTML
        // that a quote-only scanner would leave running.
        assert_eq!(
            strip_event_handler_attributes(r#"<img src='x' onerror='alert(1)' onload=alert(2)>"#),
            "<img src='x' >"
        );
    }

    #[test]
    fn survives_a_handler_that_is_never_closed() {
        // Malformed markup must not panic or hang the scanner — it can fail
        // to strip, but it must return.
        let input = r#"<p onclick="alert(1)"#;
        let _ = strip_event_handler_attributes(input);
    }

    #[test]
    fn a_word_that_merely_contains_on_is_left_alone() {
        // "button" and "phenomenon" both contain "on" — must not be treated
        // as an attribute boundary just because a scan finds the substring.
        let input = "<button>the phenomenon continues</button>";
        assert_eq!(strip_event_handler_attributes(input), input);
    }

    #[test]
    fn ordinary_attributes_and_multibyte_text_survive() {
        let input = "<p id=\"café\" data-x=\"1\">café</p>";
        assert_eq!(strip_event_handler_attributes(input), input);
    }

    #[test]
    fn sanitize_html_removes_a_handler_that_remove_tags_would_leave_behind() {
        // remove_tags only drops whole dangerous elements (script, iframe,
        // ...); a plain <p> with an inline handler sailed through untouched
        // before this fix — this is the exact reported gap.
        let html = "<html><body><p onclick=\"fetch('https://evil.example/x')\">hi</p></body></html>";
        let sanitized = sanitize_html(html, "https://example.com/");
        assert!(!sanitized.to_lowercase().contains("onclick"));
        assert!(sanitized.contains("hi"));
    }
}
