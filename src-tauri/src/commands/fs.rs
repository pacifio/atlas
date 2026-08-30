use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub extension: Option<String>,
}

/// `#[tauri::command]` handlers WITHOUT `async` run on the NSApp main thread.
/// Any meaningful file I/O there freezes the whole app (beachball). All three
/// commands in this module therefore declare `async fn` + dispatch their
/// blocking work through `tokio::task::spawn_blocking`, which puts the syscall
/// on tokio's blocking worker pool and leaves the main thread responsive.

#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || read_directory_sync(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_directory_sync(path: &str) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path().to_string_lossy().to_string();
        let ext = entry
            .path()
            .extension()
            .map(|e| e.to_string_lossy().to_string());

        entries.push(FileEntry {
            name,
            path: file_path,
            is_dir: metadata.is_dir(),
            is_symlink: metadata.is_symlink(),
            size: metadata.len(),
            extension: ext,
        });
    }

    // Sort: directories first, then alphabetical (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read an arbitrary file as standard base64. Used for binary payloads the
/// webview needs as bytes — notably PDFs handed to react-pdf as `{ data }`.
///
/// Why not `convertFileSrc`: the Tauri asset protocol 403s files under the
/// hidden `.atlas/` dir (where research papers live), and PDF.js struggles
/// with blob/asset URLs in WKWebView. Reading bytes through our own command
/// works for every path. The frontend decodes via `atob` → `Uint8Array`.
#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        let bytes = fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// Absolute path of the saved PNG (kept on disk so it can ride along as an
    /// `@file` chip when the agent can't take inline images).
    pub path: String,
    pub mime_type: String,
    /// Standard base64 of the PNG bytes (for inline multimodal attachment).
    pub data_base64: String,
}

/// Capture a macOS screenshot via the native `screencapture` CLI (the same
/// approach BetterShot / Snipp use for reliability). `mode`:
///   - "region" → `-i` interactive selection (drag a region, or Space for a
///     window); returns `Ok(None)` if the user cancels (Esc → no file written).
///   - "full"   → the whole desktop.
/// The PNG is written under `<project>/.atlas/screenshots` (or the temp dir when
/// no project is open) and also returned as base64. Requires macOS Screen
/// Recording permission (macOS prompts on first use).
#[tauri::command]
pub async fn capture_screenshot(
    mode: String,
    project_path: Option<String>,
) -> Result<Option<CaptureResult>, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;

        let interactive = mode == "region";
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();

        let dir = match project_path.as_deref() {
            Some(p) => Path::new(p).join(".atlas").join("screenshots"),
            None => std::env::temp_dir(),
        };
        let _ = fs::create_dir_all(&dir);
        let out = dir.join(format!("atlas_shot_{ts}.png"));

        // `-x` silences the shutter sound; `-t png` fixes the format.
        let mut cmd = std::process::Command::new("/usr/sbin/screencapture");
        if interactive {
            cmd.arg("-i");
        }
        cmd.args(["-x", "-t", "png"]).arg(&out);

        // Blocks until the capture (or interactive selection) finishes.
        cmd.status()
            .map_err(|e| format!("Failed to run screencapture: {e}"))?;
        // No file written → the user cancelled (Esc), or permission isn't granted
        // yet (macOS shows its own prompt). Either way, treat it as a silent
        // no-op rather than a spurious error.
        if !out.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&out).map_err(|e| format!("Failed to read screenshot: {e}"))?;
        if bytes.is_empty() {
            let _ = fs::remove_file(&out);
            return Ok(None);
        }
        Ok(Some(CaptureResult {
            path: out.to_string_lossy().to_string(),
            mime_type: "image/png".to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Heuristic: does this file look like UTF-8/ASCII text rather than binary?
/// Reads only a capped prefix (8 KB) and applies the classic "a NUL byte means
/// binary" rule that `git` uses, plus a UTF-8 validity check on the prefix.
///
/// Used as a fallback when a file's name/extension isn't in the known-text
/// allowlist (e.g. `.env.local`, `.env.production`, or any odd text file) so it
/// still opens in the editor instead of the unsupported-file view, without
/// risking dumping real binary into CodeMirror.
#[tauri::command]
pub async fn is_text_file(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut f =
            fs::File::open(&path).map_err(|e| format!("Failed to open {path}: {e}"))?;
        let mut buf = [0u8; 8192];
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let slice = &buf[..n];
        // Empty file → treat as text (an empty editor is fine).
        if slice.is_empty() {
            return Ok(true);
        }
        // A NUL byte in the prefix is the standard binary signal.
        if slice.contains(&0) {
            return Ok(false);
        }
        // Otherwise require the prefix to be valid UTF-8 — but tolerate an
        // incomplete final multibyte char caused by the 8 KB cut (that's
        // `error_len() == None`, i.e. "unexpected end", not an invalid byte).
        match std::str::from_utf8(slice) {
            Ok(_) => Ok(true),
            Err(e) => Ok(e.error_len().is_none() && e.valid_up_to() > 0),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Grant the asset protocol read access to a project directory (recursive), so
/// the media viewer can serve images/video/audio from it via `convertFileSrc`.
/// The static scope (tauri.conf.json) is intentionally narrow ($HOME) rather
/// than `**`; this adds the open project's tree at runtime so projects on
/// external volumes (outside $HOME) also work without serving the whole disk.
#[tauri::command]
pub fn asset_allow_dir(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())
}

/// File modification time as unix milliseconds (0 if the file is missing).
/// Used as a cache-buster for the media viewer: the Tauri asset URL is keyed by
/// path, so the webview would otherwise serve a stale image after a file at the
/// same path is deleted and recreated.
#[tauri::command]
pub async fn file_mtime_ms(path: String) -> Result<i64, String> {
    tokio::task::spawn_blocking(move || {
        Ok(fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        fs::write(&path, &content).map_err(|e| format!("Failed to write {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a binary file from standard base64. Counterpart of `read_file_base64`
/// — used to save a PDF with annotations baked in (pdf-lib produces new bytes
/// the frontend hands back as base64).
#[tauri::command]
pub async fn write_file_base64(path: String, contents: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(contents.as_bytes())
            .map_err(|e| format!("bad base64: {e}"))?;
        fs::write(&path, &bytes).map_err(|e| format!("Failed to write {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ── File-tree context-menu fs operations ────────────────────────────
 * Every command below is `async` + dispatches blocking I/O via
 * `tokio::task::spawn_blocking` — same rationale as `read_directory`:
 * sync `#[tauri::command]` handlers freeze the NSApp main thread.
 */

#[tauri::command]
pub async fn fs_create_file(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if p.exists() {
            return Err(format!("Already exists: {path}"));
        }
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(p, "").map_err(|e| format!("Failed to create {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if p.exists() {
            return Err(format!("Already exists: {path}"));
        }
        fs::create_dir_all(p).map_err(|e| format!("Failed to mkdir {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dst = Path::new(&to);
        if dst.exists() {
            return Err(format!("Target already exists: {to}"));
        }
        fs::rename(&from, &to).map_err(|e| format!("Failed to rename: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_delete(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.exists() {
            return Ok(());
        }
        let meta = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            fs::remove_dir_all(p).map_err(|e| format!("Failed to delete dir: {e}"))
        } else {
            fs::remove_file(p).map_err(|e| format!("Failed to delete file: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_copy(from: String, to: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let src = Path::new(&from);
        let dst = Path::new(&to);
        if dst.exists() {
            return Err(format!("Target already exists: {to}"));
        }
        if src.is_dir() {
            copy_dir_recursive(src, dst)
        } else {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(src, dst)
                .map(|_| ())
                .map_err(|e| format!("Failed to copy: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Produce `<stem> copy<.ext>`, `<stem> copy 2<.ext>`, … picking the
/// first variant that doesn't already exist in the same directory.
/// Returns the new path string.
#[tauri::command]
pub async fn fs_duplicate(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let src = Path::new(&path);
        if !src.exists() {
            return Err(format!("Not found: {path}"));
        }
        let parent = src.parent().ok_or("No parent dir")?;
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = src.extension().map(|e| e.to_string_lossy().to_string());

        for n in 1..1000 {
            let name = match (n, &ext) {
                (1, Some(e)) => format!("{stem} copy.{e}"),
                (1, None) => format!("{stem} copy"),
                (n, Some(e)) => format!("{stem} copy {n}.{e}"),
                (n, None) => format!("{stem} copy {n}"),
            };
            let candidate = parent.join(&name);
            if !candidate.exists() {
                if src.is_dir() {
                    copy_dir_recursive(src, &candidate)?;
                } else {
                    fs::copy(src, &candidate).map_err(|e| e.to_string())?;
                }
                return Ok(candidate.to_string_lossy().to_string());
            }
        }
        Err("Too many duplicates".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a folder in the system terminal. macOS only for now —
/// returns `Err("unsupported")` on other platforms so the frontend
/// can show a sensible toast.
#[tauri::command]
pub async fn fs_open_in_terminal(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            Command::new("open")
                .args(["-a", "Terminal", &path])
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to open Terminal: {e}"))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            Err::<(), String>("unsupported".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append an arbitrary pattern to the project's `.gitignore`, sharing
/// the dedupe logic with `ensure_atlas_gitignore`. Idempotent.
#[tauri::command]
pub async fn fs_add_to_gitignore(project_path: String, pattern: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || append_to_gitignore_sync(&project_path, &pattern))
        .await
        .map_err(|e| e.to_string())?
}

fn append_to_gitignore_sync(project_path: &str, pattern: &str) -> Result<(), String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("Empty gitignore pattern".to_string());
    }
    let root = Path::new(project_path);
    let gitignore = root.join(".gitignore");

    if !gitignore.exists() {
        fs::write(&gitignore, format!("{trimmed}\n"))
            .map_err(|e| format!("could not create .gitignore: {e}"))?;
        return Ok(());
    }

    let existing =
        fs::read_to_string(&gitignore).map_err(|e| format!("could not read .gitignore: {e}"))?;
    if pattern_present(&existing, trimmed) {
        return Ok(());
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(trimmed);
    next.push('\n');
    fs::write(&gitignore, next).map_err(|e| format!("could not write .gitignore: {e}"))?;
    Ok(())
}

/// True if any uncommented, non-blank line in the gitignore equals
/// `pattern` (after trimming). Used by both the bootstrap `.atlas/`
/// flow and the user-driven `fs_add_to_gitignore` action.
fn pattern_present(contents: &str, pattern: &str) -> bool {
    contents.lines().any(|raw| {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }
        line == pattern
    })
}

/// Outcome of an `ensure_atlas_gitignore` run. Mostly for logging /
/// telemetry — the frontend doesn't act on the variant.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum EnsureAtlasGitignoreResult {
    /// `.git` directory wasn't present — we don't manage `.gitignore` for
    /// non-git projects (no value to the user).
    NotGitRepo,
    /// `.gitignore` already contained an entry that matches `.atlas/` —
    /// nothing changed.
    AlreadyPresent,
    /// `.gitignore` existed but didn't list `.atlas/`; we appended.
    Added,
    /// No `.gitignore` existed; we created one with just `.atlas/`.
    Created,
}

const ATLAS_GITIGNORE_PATTERN: &str = ".atlas/";

/// Idempotent: makes sure the project's `.gitignore` contains `.atlas/`
/// (Atlas's own state directory). Safe to call on every project open.
///
/// Logic per the user-facing setting:
///   1. No `.git` → nothing to do.
///   2. `.gitignore` missing → create it with just `.atlas/`.
///   3. `.gitignore` present, doesn't list `.atlas/` (in any common
///      form) → append.
///   4. `.gitignore` present and already lists it → no-op.
///
/// Off the main thread (it touches the filesystem).
#[tauri::command]
pub async fn ensure_atlas_gitignore(
    project_path: String,
) -> Result<EnsureAtlasGitignoreResult, String> {
    tokio::task::spawn_blocking(move || ensure_atlas_gitignore_sync(&project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn ensure_atlas_gitignore_sync(
    project_path: &str,
) -> Result<EnsureAtlasGitignoreResult, String> {
    let root = Path::new(project_path);
    if !root.join(".git").exists() {
        return Ok(EnsureAtlasGitignoreResult::NotGitRepo);
    }

    let gitignore = root.join(".gitignore");

    if !gitignore.exists() {
        fs::write(&gitignore, format!("{ATLAS_GITIGNORE_PATTERN}\n"))
            .map_err(|e| format!("could not create .gitignore: {e}"))?;
        tracing::info!(
            target: "atlas::gitignore",
            "created {} with {}",
            gitignore.display(),
            ATLAS_GITIGNORE_PATTERN
        );
        return Ok(EnsureAtlasGitignoreResult::Created);
    }

    let existing =
        fs::read_to_string(&gitignore).map_err(|e| format!("could not read .gitignore: {e}"))?;

    if atlas_pattern_present(&existing) {
        return Ok(EnsureAtlasGitignoreResult::AlreadyPresent);
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(ATLAS_GITIGNORE_PATTERN);
    next.push('\n');

    fs::write(&gitignore, next).map_err(|e| format!("could not write .gitignore: {e}"))?;
    tracing::info!(
        target: "atlas::gitignore",
        "appended {} to {}",
        ATLAS_GITIGNORE_PATTERN,
        gitignore.display()
    );
    Ok(EnsureAtlasGitignoreResult::Added)
}

/// True if any line in `.gitignore` already matches `.atlas/` in any of
/// the equivalent forms users commonly write. Comment lines (`#…`) and
/// blank lines are skipped; trailing whitespace is ignored.
fn atlas_pattern_present(contents: &str) -> bool {
    contents.lines().any(|raw| {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }
        matches!(line, ".atlas" | ".atlas/" | "/.atlas" | "/.atlas/")
    })
}
