use pulldown_cmark::{html, Options, Parser};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Stylesheet embedded into every exported HTML page. Dark theme that
/// mirrors Atlas's readme-view typography so a note reads the same in a
/// browser as it does inside the app.
const STYLESHEET: &str = include_str!("knowledge_export.css");

/// Wrap a rendered body in the full HTML shell with the embedded CSS.
fn html_page(title: &str, body_html: &str, nav: Option<&str>) -> String {
    let nav_html = nav.unwrap_or("");
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<div class="layout">{nav}<main class="content">{body}</main></div>
</body>
</html>
"#,
        title = html_escape(title),
        css = STYLESHEET,
        nav = nav_html,
        body = body_html,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn md_to_html(md: &str) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_SMART_PUNCTUATION);
    let parser = Parser::new_ext(md, opts);
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out
}

fn kb_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".atlas").join("knowledge")
}

fn note_path(project_path: &str, entry_id: &str) -> PathBuf {
    kb_dir(project_path).join(format!("{entry_id}.md"))
}

/// Look up the user-edited title in `_meta.json`, falling back to the
/// entry id basename. Mirrors the client-side `meta.title ?? filename`
/// resolution used by the tree + graph + mention picker.
fn resolve_title(project_path: &str, entry_id: &str) -> String {
    let meta_path = kb_dir(project_path).join("_meta.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(title) = json
                .get(entry_id)
                .and_then(|p| p.get("title"))
                .and_then(|t| t.as_str())
            {
                let t = title.trim();
                if !t.is_empty() {
                    return t.to_string();
                }
            }
        }
    }
    entry_id
        .rsplit('/')
        .next()
        .unwrap_or(entry_id)
        .to_string()
}

#[derive(Debug, Clone)]
struct NoteFile {
    /// Knowledge id (e.g. `folder/note-12345`).
    id: String,
    title: String,
    body_md: String,
}

fn walk_notes(project_path: &str) -> Vec<NoteFile> {
    let root = kb_dir(project_path);
    if !root.exists() {
        return vec![];
    }
    let mut out: Vec<NoteFile> = Vec::new();
    walk(&root, &root, project_path, &mut out);
    out.sort_by_key(|a| a.title.to_lowercase());
    out
}

fn walk(dir: &Path, root: &Path, project_path: &str, out: &mut Vec<NoteFile>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, root, project_path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let id = rel.with_extension("").to_string_lossy().to_string();
        let Ok(body_md) = fs::read_to_string(&path) else { continue };
        let title = resolve_title(project_path, &id);
        out.push(NoteFile { id, title, body_md });
    }
}

#[tauri::command]
pub async fn knowledge_export_note_md(
    project_path: String,
    entry_id: String,
    target_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let src = note_path(&project_path, &entry_id);
        let body = fs::read_to_string(&src).map_err(|e| e.to_string())?;
        fs::write(&target_path, body).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_export_note_html(
    project_path: String,
    entry_id: String,
    target_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let src = note_path(&project_path, &entry_id);
        let md = fs::read_to_string(&src).map_err(|e| e.to_string())?;
        let title = resolve_title(&project_path, &entry_id);
        let body_html = md_to_html(&md);
        let page = html_page(&title, &body_html, None);
        fs::write(&target_path, page).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_export_workspace_md(
    project_path: String,
    target_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let notes = walk_notes(&project_path);
        let mut combined = String::new();
        for (i, n) in notes.iter().enumerate() {
            if i > 0 {
                combined.push_str("\n\n---\n\n");
            }
            combined.push_str(&format!("# {}\n\n", n.title));
            combined.push_str(n.body_md.trim());
            combined.push('\n');
        }
        fs::write(&target_path, combined).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a multi-file HTML site for the entire knowledge workspace. The
/// target is a directory; an `index.html` and a flat `notes/<slug>.html`
/// tree are written underneath it.
#[tauri::command]
pub async fn knowledge_export_workspace_html(
    project_path: String,
    target_dir: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let root = PathBuf::from(&target_dir);
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let notes = walk_notes(&project_path);
        let nav = build_nav(&notes, "");
        for n in &notes {
            let body_html = md_to_html(&n.body_md);
            let page = html_page(&n.title, &body_html, Some(&build_nav(&notes, &n.id)));
            let out_path = root.join(format!("{}.html", slugify(&n.id)));
            fs::write(&out_path, page).map_err(|e| e.to_string())?;
        }
        let index_body = if notes.is_empty() {
            "<p>No notes in this workspace yet.</p>".to_string()
        } else {
            format!(
                "<h1>Knowledge</h1><p>{} note{} exported.</p>",
                notes.len(),
                if notes.len() == 1 { "" } else { "s" }
            )
        };
        let index = html_page("Knowledge", &index_body, Some(&nav));
        fs::write(root.join("index.html"), index).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn slugify(id: &str) -> String {
    id.replace('/', "__")
}

/// Build the sidebar nav. All pages live flat at the web root so the
/// same links work from `index.html` and from any note page — no
/// `../`/`notes/` prefix juggling.
fn build_nav(notes: &[NoteFile], active_id: &str) -> String {
    let mut out = String::from(r#"<nav class="sidebar"><div class="brand">Knowledge</div><ul>"#);
    out.push_str(&format!(
        r#"<li><a href="index.html" class="{cls}">Home</a></li>"#,
        cls = if active_id.is_empty() { "active" } else { "" }
    ));
    for n in notes {
        let cls = if n.id == active_id { "active" } else { "" };
        out.push_str(&format!(
            r#"<li><a href="{slug}.html" class="{cls}">{title}</a></li>"#,
            slug = slugify(&n.id),
            cls = cls,
            title = html_escape(&n.title),
        ));
    }
    out.push_str("</ul></nav>");
    out
}

#[derive(Debug, Serialize)]
pub struct ServerExportResult {
    /// Final absolute path of the produced binary.
    pub binary_path: String,
    pub note_count: usize,
}

/// Build a self-contained static-server binary that embeds every note as
/// HTML. The flow:
///   1. Render every note + an index into `<temp>/web/`.
///   2. Run `cargo build --release -p atlas-kb-server` with
///      `ATLAS_KB_WEB` pointing at that temp dir — the `atlas-kb-server`
///      crate's `build.rs` copies it into `OUT_DIR` so `include_dir!`
///      embeds the content into the produced binary.
///   3. Copy the produced binary to `target_path`.
///
/// Requires `cargo` to be on PATH. First build is ~30-60s; subsequent
/// re-exports are seconds thanks to incremental compilation.
#[tauri::command]
pub async fn knowledge_export_server(
    project_path: String,
    target_path: String,
) -> Result<ServerExportResult, String> {
    tokio::task::spawn_blocking(move || -> Result<ServerExportResult, String> {
        // 1. Render the HTML site into a fresh tmp dir.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let web_dir = std::env::temp_dir().join(format!("atlas-kb-web-{stamp}"));
        let _ = fs::remove_dir_all(&web_dir);
        fs::create_dir_all(&web_dir).map_err(|e| e.to_string())?;

        let notes = walk_notes(&project_path);
        for n in &notes {
            let body_html = md_to_html(&n.body_md);
            let page = html_page(&n.title, &body_html, Some(&build_nav(&notes, &n.id)));
            let out_path = web_dir.join(format!("{}.html", slugify(&n.id)));
            fs::write(&out_path, page).map_err(|e| e.to_string())?;
        }
        let index_body = format!(
            "<h1>Knowledge</h1><p>{} note{} embedded.</p>",
            notes.len(),
            if notes.len() == 1 { "" } else { "s" }
        );
        let index_page = html_page("Knowledge", &index_body, Some(&build_nav(&notes, "")));
        fs::write(web_dir.join("index.html"), index_page).map_err(|e| e.to_string())?;

        // 2. Locate the atlas-kb-server crate, relative to src-tauri.
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let server_manifest = manifest_dir
            .parent()
            .ok_or("can't locate crates dir")?
            .join("crates/atlas-kb-server/Cargo.toml");
        if !server_manifest.exists() {
            return Err(format!(
                "atlas-kb-server crate missing at {}",
                server_manifest.display()
            ));
        }

        // Dedicated target dir so this doesn't conflict with the main
        // Atlas build's incremental cache.
        let target_dir = std::env::temp_dir().join("atlas-kb-server-target");

        let output = std::process::Command::new("cargo")
            .args([
                "build",
                "--release",
                "--manifest-path",
            ])
            .arg(&server_manifest)
            .arg("--target-dir")
            .arg(&target_dir)
            .env("ATLAS_KB_WEB", &web_dir)
            .output()
            .map_err(|e| format!("failed to spawn cargo (is it on PATH?): {e}"))?;

        if !output.status.success() {
            return Err(format!(
                "cargo build failed:\n{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        // 3. Copy the built binary to the user's chosen path.
        let bin_name = if cfg!(windows) { "atlas-kb-server.exe" } else { "atlas-kb-server" };
        let built = target_dir.join("release").join(bin_name);
        if !built.exists() {
            return Err(format!("built binary missing at {}", built.display()));
        }
        fs::copy(&built, &target_path).map_err(|e| e.to_string())?;

        // Ensure exec bit on unix — fs::copy preserves perms but the
        // user's umask might mask things; set explicitly.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&target_path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&target_path, perms);
        }

        // Clean up the temp web dir; the binary already embeds its contents.
        let _ = fs::remove_dir_all(&web_dir);

        Ok(ServerExportResult {
            binary_path: target_path,
            note_count: notes.len(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
