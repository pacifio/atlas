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
        // Sanity ceiling, not a policy: this feeds PDFs and pasted images, so
        // it has to accept real documents — but a base64 string is 4/3 the
        // file and every byte crosses IPC and lives in the JS heap. Above
        // this, the asset protocol is the right transport.
        const MAX_INLINE_BYTES: u64 = 50 * 1024 * 1024;
        let meta = fs::metadata(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
        if meta.len() > MAX_INLINE_BYTES {
            return Err(format!(
                "file is too large to inline ({} MB; 50 MB max)",
                meta.len() / (1024 * 1024)
            ));
        }
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
            Some(p) => atlas_profile::dir_in(Path::new(p)).join("screenshots"),
            None => std::env::temp_dir(),
        };
        let _ = fs::create_dir_all(&dir);
        let out = dir.join(format!("atlas_shot_{ts}.png"));

        // `-x` silences the shutter sound; `-t png` fixes the format.
        let mut cmd = atlas_process::command("/usr/sbin/screencapture");
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
        let mut f = fs::File::open(&path).map_err(|e| format!("Failed to open {path}: {e}"))?;
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

/// Grant the asset protocol read access to a directory (recursive), so the
/// media viewer can serve images/video/audio from it via `convertFileSrc`.
///
/// BOUNDED: the old version passed the renderer's string straight to
/// `allow_directory`, so `asset_allow_dir("/")` made the entire filesystem
/// readable over `asset://` for the rest of the session. A grant now has to
/// be either (a) under a known project root — the project-open case, external
/// volumes included — or (b) a *visible* directory under `$HOME` (the
/// "@-mention a screenshot on the Desktop" case). Hidden directories
/// (`~/.ssh`, `~/.aws`), `~/Library`, and system roots are refused.
#[tauri::command]
pub fn asset_allow_dir(
    path: String,
    app: tauri::AppHandle,
    app_state: tauri::State<'_, crate::AppStateHandle>,
) -> Result<(), String> {
    use tauri::Manager;
    let requested = std::path::Path::new(&path);
    if !requested.is_absolute() {
        return Err("asset grant must be an absolute path".into());
    }
    let canonical = dunce::canonicalize(requested)
        .map_err(|e| format!("cannot grant a directory that does not resolve: {e}"))?;

    let project_roots: Vec<std::path::PathBuf> = {
        let state = app_state.lock();
        state
            .workspaces
            .iter()
            .map(|w| std::path::PathBuf::from(&w.path))
            .collect()
    };
    if !asset_grant_allowed(&canonical, &project_roots, dirs::home_dir().as_deref()) {
        return Err("that directory is outside what the media viewer may serve".into());
    }

    app.asset_protocol_scope()
        .allow_directory(&canonical, true)
        .map_err(|e| e.to_string())
}

/// The asset-grant policy, pure so it is testable: a canonical directory may
/// be granted when it sits under a known project root, or when it is a
/// VISIBLE directory under `$HOME` — hidden dirs (`~/.ssh`), `~/Library`, and
/// `$HOME` itself are refused, and anything else (system roots, other users)
/// falls through to refusal.
fn asset_grant_allowed(
    canonical: &std::path::Path,
    project_roots: &[std::path::PathBuf],
    home: Option<&std::path::Path>,
) -> bool {
    let under_project = project_roots.iter().any(|root| {
        let root = dunce::canonicalize(root).unwrap_or_else(|_| root.clone());
        canonical.starts_with(&root)
    });
    if under_project {
        return true;
    }
    home.is_some_and(|home| {
        let Ok(rel) = canonical.strip_prefix(home) else {
            return false;
        };
        match rel.components().next() {
            // `$HOME` itself would grant every dotfile below it.
            None => false,
            Some(std::path::Component::Normal(first)) => {
                let first = first.to_string_lossy();
                !first.starts_with('.') && first != "Library"
            }
            Some(_) => false,
        }
    })
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

/// Split a `$TERMINAL` value into the program and its arguments
/// (`"wezterm start"` → `wezterm`, `["start"]`). Whitespace-split, not
/// shell-parsed: a program path containing spaces is not supported.
/// `None` when the value is blank.
#[cfg(any(target_os = "linux", test))]
fn parse_terminal_env(value: &str) -> Option<(&str, Vec<&str>)> {
    let mut parts = value.split_whitespace();
    let bin = parts.next()?;
    Some((bin, parts.collect()))
}

/// Open a folder in the system terminal.
/// Supported on macOS and Linux.
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
        #[cfg(target_os = "linux")]
        {
            use std::process::Command;
            let target_path = std::path::Path::new(&path);
            let target_dir = if target_path.is_dir() {
                target_path
            } else if let Some(parent) = target_path.parent() {
                parent
            } else {
                target_path
            };
            let dir_str = target_dir.to_string_lossy();

            // The user's own choice, when the environment names one, before guessing.
            if let Some((bin, args)) = std::env::var("TERMINAL")
                .ok()
                .as_deref()
                .and_then(parse_terminal_env)
            {
                if Command::new(bin)
                    .args(&args)
                    .current_dir(target_dir)
                    .spawn()
                    .is_ok()
                {
                    return Ok(());
                }
            }

            // Modern desktop spec, common desktop terminals, and popular standalone emulators.
            let terminals: &[(&str, &[&str])] = &[
                ("xdg-terminal-exec", &[]),
                ("x-terminal-emulator", &[]),
                ("ptyxis", &["--working-directory", &dir_str]),
                ("gnome-terminal", &["--working-directory", &dir_str]),
                ("kitty", &["--directory", &dir_str]),
                ("foot", &["--working-directory", &dir_str]),
                ("alacritty", &["--working-directory", &dir_str]),
                ("ghostty", &["--working-directory", &dir_str]),
                ("wezterm", &["start", "--cwd", &dir_str]),
                ("konsole", &["--workdir", &dir_str]),
                ("xfce4-terminal", &["--working-directory", &dir_str]),
                ("xterm", &[]),
            ];

            for (term, args) in terminals {
                if Command::new(term)
                    .args(*args)
                    .current_dir(target_dir)
                    .spawn()
                    .is_ok()
                {
                    return Ok(());
                }
            }
            Err("No supported terminal emulator found".to_string())
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum EnsureAtlasGitignoreResult {
    /// `.git` wasn't present — we don't manage ignore files for non-git
    /// projects (no value to the user).
    NotGitRepo,
    /// The ignore file already contained an entry that matches Atlas's
    /// directory — nothing changed.
    AlreadyPresent,
    /// The ignore file existed but didn't list the directory; we appended.
    Added,
    /// No ignore file existed; we created one with just the directory.
    Created,
}

/// Atlas's state directory as an ignore line: `.atlas/`, or `.atlas-dev/`
/// under the dev profile (`atlas-profile`). Each profile ignores only its own
/// directory, and leaves the other profile's line alone.
fn gitignore_pattern(dir_name: &str) -> String {
    format!("{dir_name}/")
}

/// Idempotent: keeps Atlas's own state directory out of the project's version
/// control. Safe to call on every project open.
///
/// The default profile lists `.atlas/` in the project's `.gitignore`:
///   1. No `.git` → nothing to do.
///   2. `.gitignore` missing → create it with just `.atlas/`.
///   3. `.gitignore` present, doesn't list `.atlas/` (in any common
///      form) → append.
///   4. `.gitignore` present and already lists it → no-op.
///
/// The dev profile (`bun run dev:app`) must not edit a tracked file in every
/// repository a contributor opens, so it lists `.atlas-dev/` in the
/// repository's `info/exclude` instead — the same ignore semantics, but local
/// to the clone and never committed. Already listed in `.gitignore` (as in
/// Atlas's own repo) counts too.
///
/// Off the main thread (it touches the filesystem).
#[tauri::command]
pub async fn ensure_atlas_gitignore(
    project_path: String,
) -> Result<EnsureAtlasGitignoreResult, String> {
    tokio::task::spawn_blocking(move || {
        ensure_atlas_ignored(Path::new(&project_path), atlas_profile::current())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ensure_atlas_ignored(
    root: &Path,
    profile: atlas_profile::Profile,
) -> Result<EnsureAtlasGitignoreResult, String> {
    if !root.join(".git").exists() {
        return Ok(EnsureAtlasGitignoreResult::NotGitRepo);
    }
    let dir_name = profile.dir_name();
    let gitignore = root.join(".gitignore");
    if !profile.is_dev() {
        return ensure_listed(&gitignore, dir_name);
    }
    if fs::read_to_string(&gitignore).is_ok_and(|g| atlas_pattern_present(&g, dir_name)) {
        return Ok(EnsureAtlasGitignoreResult::AlreadyPresent);
    }
    let exclude = git_common_dir(root)?.join("info").join("exclude");
    if let Some(info) = exclude.parent() {
        fs::create_dir_all(info)
            .map_err(|e| format!("could not create {}: {e}", info.display()))?;
    }
    ensure_listed(&exclude, dir_name)
}

/// The repository's common git directory, where `info/exclude` lives.
///
/// - `<root>/.git` is a directory: that directory.
/// - `<root>/.git` is a file (a linked worktree, a submodule): it reads
///   `gitdir: <path>`, relative to `root` when not absolute. A linked
///   worktree's gitdir (`<main>/.git/worktrees/<name>`) also holds a
///   `commondir` file naming the shared directory (relative to the gitdir),
///   and git reads `info/exclude` from there, not from the per-worktree dir.
fn git_common_dir(root: &Path) -> Result<std::path::PathBuf, String> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git);
    }
    let pointer = fs::read_to_string(&dot_git)
        .map_err(|e| format!("could not read {}: {e}", dot_git.display()))?;
    let target = pointer
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| format!("{} has no `gitdir:` line", dot_git.display()))?;
    let git_dir = root.join(target);
    let common = match fs::read_to_string(git_dir.join("commondir")) {
        Ok(common) if !common.trim().is_empty() => git_dir.join(common.trim()),
        _ => git_dir,
    };
    // Never invent a git directory: `info/` is created inside it, not it.
    if !common.is_dir() {
        return Err(format!("git directory {} does not exist", common.display()));
    }
    Ok(common)
}

/// Make sure `file` lists `<dir_name>/`: create it with just that line, or
/// append the line, unless an equivalent one is already there.
fn ensure_listed(file: &Path, dir_name: &str) -> Result<EnsureAtlasGitignoreResult, String> {
    let pattern = gitignore_pattern(dir_name);
    let shown = file.display();

    if !file.exists() {
        fs::write(file, format!("{pattern}\n"))
            .map_err(|e| format!("could not create {shown}: {e}"))?;
        tracing::info!(target: "atlas::gitignore", "created {shown} with {pattern}");
        return Ok(EnsureAtlasGitignoreResult::Created);
    }

    let existing = fs::read_to_string(file).map_err(|e| format!("could not read {shown}: {e}"))?;

    if atlas_pattern_present(&existing, dir_name) {
        return Ok(EnsureAtlasGitignoreResult::AlreadyPresent);
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&pattern);
    next.push('\n');

    fs::write(file, next).map_err(|e| format!("could not write {shown}: {e}"))?;
    tracing::info!(target: "atlas::gitignore", "appended {pattern} to {shown}");
    Ok(EnsureAtlasGitignoreResult::Added)
}

/// True if any line in `.gitignore` already matches `<dir_name>/` (`.atlas/`)
/// in any of the equivalent forms users commonly write (`.atlas`, `.atlas/`,
/// `/.atlas`, `/.atlas/`). Comment lines (`#…`) and blank lines are skipped;
/// trailing whitespace is ignored.
fn atlas_pattern_present(contents: &str, dir_name: &str) -> bool {
    contents.lines().any(|raw| {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }
        let line = line.strip_prefix('/').unwrap_or(line);
        let line = line.strip_suffix('/').unwrap_or(line);
        line == dir_name
    })
}

#[cfg(test)]
mod gitignore_tests {
    use super::{atlas_pattern_present, gitignore_pattern};

    #[test]
    fn every_common_spelling_of_the_directory_counts() {
        for line in [".atlas", ".atlas/", "/.atlas", "/.atlas/", "  .atlas/  "] {
            let contents = format!("node_modules\n{line}\n");
            assert!(atlas_pattern_present(&contents, ".atlas"), "{line:?}");
        }
        assert!(!atlas_pattern_present("# .atlas/\n\n", ".atlas"));
        assert!(!atlas_pattern_present(".atlas-old/\n", ".atlas"));
        assert!(!atlas_pattern_present("//.atlas//\n", ".atlas"));
        assert_eq!(gitignore_pattern(".atlas"), ".atlas/");
    }

    /// The dev profile looks for, and adds, its own directory only: the
    /// released app's `.atlas/` line does not cover `.atlas-dev/`.
    #[test]
    fn each_profile_matches_only_its_own_directory() {
        assert!(!atlas_pattern_present(".atlas/\n", ".atlas-dev"));
        assert!(atlas_pattern_present(
            ".atlas/\n.atlas-dev/\n",
            ".atlas-dev"
        ));
        assert!(!atlas_pattern_present(".atlas-dev/\n", ".atlas"));
        assert_eq!(gitignore_pattern(".atlas-dev"), ".atlas-dev/");
    }
}

/// `ensure_atlas_ignored` against real directories, under both profiles.
#[cfg(test)]
mod ignore_file_tests {
    use super::{ensure_atlas_ignored, EnsureAtlasGitignoreResult as R};
    use atlas_profile::Profile;
    use std::fs;
    use std::path::Path;

    fn read(p: impl AsRef<Path>) -> String {
        fs::read_to_string(p).unwrap()
    }

    /// A plain clone: `<root>/.git/` is a directory, with no `info/` yet.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        dir
    }

    #[test]
    fn neither_profile_touches_a_project_without_git() {
        let dir = tempfile::tempdir().unwrap();
        for p in [Profile::Default, Profile::Dev] {
            assert_eq!(ensure_atlas_ignored(dir.path(), p), Ok(R::NotGitRepo));
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_default_profile_creates_then_appends_to_gitignore() {
        let dir = repo();
        let root = dir.path();
        assert_eq!(ensure_atlas_ignored(root, Profile::Default), Ok(R::Created));
        assert_eq!(read(root.join(".gitignore")), ".atlas/\n");
        assert_eq!(
            ensure_atlas_ignored(root, Profile::Default),
            Ok(R::AlreadyPresent)
        );

        fs::write(root.join(".gitignore"), "node_modules").unwrap();
        assert_eq!(ensure_atlas_ignored(root, Profile::Default), Ok(R::Added));
        assert_eq!(read(root.join(".gitignore")), "node_modules\n.atlas/\n");
        assert!(
            !root.join(".git/info").exists(),
            "the default profile leaves .git alone"
        );
    }

    #[test]
    fn the_dev_profile_never_edits_gitignore() {
        let dir = repo();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "node_modules\n").unwrap();

        // `info/` is missing in a fresh `.git`: created, then the line.
        assert_eq!(ensure_atlas_ignored(root, Profile::Dev), Ok(R::Created));
        assert_eq!(read(root.join(".git/info/exclude")), ".atlas-dev/\n");
        assert_eq!(read(root.join(".gitignore")), "node_modules\n");

        // Idempotent.
        assert_eq!(
            ensure_atlas_ignored(root, Profile::Dev),
            Ok(R::AlreadyPresent)
        );
        assert_eq!(read(root.join(".git/info/exclude")), ".atlas-dev/\n");

        // Appends to git's own template content, keeping it.
        fs::write(
            root.join(".git/info/exclude"),
            "# git ls-files --others\n*.swp",
        )
        .unwrap();
        assert_eq!(ensure_atlas_ignored(root, Profile::Dev), Ok(R::Added));
        assert_eq!(
            read(root.join(".git/info/exclude")),
            "# git ls-files --others\n*.swp\n.atlas-dev/\n"
        );
        assert_eq!(read(root.join(".gitignore")), "node_modules\n");
    }

    #[test]
    fn the_dev_profile_without_a_gitignore_does_not_create_one() {
        let dir = repo();
        let root = dir.path();
        assert_eq!(ensure_atlas_ignored(root, Profile::Dev), Ok(R::Created));
        assert!(!root.join(".gitignore").exists());
    }

    /// Atlas's own repo already ignores `.atlas-dev/`: nothing more to do.
    #[test]
    fn the_dev_profile_accepts_a_gitignore_that_already_lists_it() {
        let dir = repo();
        let root = dir.path();
        fs::write(root.join(".gitignore"), ".atlas/\n.atlas-dev/\n").unwrap();
        assert_eq!(
            ensure_atlas_ignored(root, Profile::Dev),
            Ok(R::AlreadyPresent)
        );
        assert!(!root.join(".git/info").exists());
    }

    /// A linked worktree: `.git` is a file pointing at
    /// `<main>/.git/worktrees/<name>`, whose `commondir` names the shared
    /// `<main>/.git` — where git reads `info/exclude` from.
    #[test]
    fn the_dev_profile_follows_a_linked_worktree_to_the_common_dir() {
        let main = repo();
        let wt_git = main.path().join(".git/worktrees/feature");
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let wt = tempfile::tempdir().unwrap();
        fs::write(
            wt.path().join(".git"),
            format!("gitdir: {}\n", wt_git.display()),
        )
        .unwrap();

        assert_eq!(
            ensure_atlas_ignored(wt.path(), Profile::Dev),
            Ok(R::Created)
        );
        assert_eq!(read(main.path().join(".git/info/exclude")), ".atlas-dev/\n");
        assert!(!wt_git.join("info").exists());
        assert!(!wt.path().join(".gitignore").exists());
        assert_eq!(
            ensure_atlas_ignored(wt.path(), Profile::Dev),
            Ok(R::AlreadyPresent)
        );
    }

    /// A submodule: `.git` is a file with a relative `gitdir:` and no
    /// `commondir`, so `info/exclude` lives in the pointed-at directory.
    #[test]
    fn the_dev_profile_follows_a_relative_gitdir() {
        let parent = tempfile::tempdir().unwrap();
        let module_git = parent.path().join(".git/modules/sub");
        fs::create_dir_all(&module_git).unwrap();
        let sub = parent.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();

        assert_eq!(ensure_atlas_ignored(&sub, Profile::Dev), Ok(R::Created));
        assert_eq!(read(module_git.join("info/exclude")), ".atlas-dev/\n");
    }

    /// A `.git` file pointing nowhere is an error, not a new directory.
    #[test]
    fn the_dev_profile_does_not_invent_a_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".git"), "gitdir: missing/dir\n").unwrap();
        assert!(ensure_atlas_ignored(dir.path(), Profile::Dev).is_err());
        assert!(!dir.path().join("missing").exists());
    }
}

#[cfg(test)]
mod inline_cap_tests {
    use super::read_file_base64;

    #[tokio::test]
    async fn the_inline_ceiling_holds() {
        let dir = std::env::temp_dir().join(format!("atlas-b64-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let small = dir.join("small.pdf");
        std::fs::write(&small, b"pdf bytes").unwrap();
        assert!(read_file_base64(small.to_string_lossy().into())
            .await
            .is_ok());

        // 51MB: a real document ceiling, not a policy about content.
        let big = dir.join("big.bin");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(51 * 1024 * 1024).unwrap();
        let err = read_file_base64(big.to_string_lossy().into())
            .await
            .unwrap_err();
        assert!(err.contains("too large"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod asset_grant_tests {
    use super::asset_grant_allowed;
    use std::path::{Path, PathBuf};

    #[test]
    fn the_grant_policy_table() {
        let home = Path::new("/Users/me");
        let ws = vec![PathBuf::from("/Volumes/ext/project")];

        // Visible home dirs and project roots pass.
        for ok in [
            "/Users/me/Desktop/shots",
            "/Users/me/Documents",
            "/Volumes/ext/project/media",
        ] {
            assert!(asset_grant_allowed(Path::new(ok), &ws, Some(home)), "{ok}");
        }
        // The audit shapes: root grant, hidden dirs, Library, home itself,
        // system paths, another user's tree.
        for bad in [
            "/",
            "/Users/me",
            "/Users/me/.ssh",
            "/Users/me/.aws/credentials",
            "/Users/me/Library/Keychains",
            "/etc",
            "/Users/other/Desktop",
        ] {
            assert!(
                !asset_grant_allowed(Path::new(bad), &ws, Some(home)),
                "{bad}"
            );
        }
    }
}

#[cfg(test)]
mod terminal_env_tests {
    use super::parse_terminal_env;

    #[test]
    fn terminal_env_splits_program_from_arguments() {
        assert_eq!(parse_terminal_env("foot"), Some(("foot", vec![])));
        assert_eq!(
            parse_terminal_env("  wezterm start  "),
            Some(("wezterm", vec!["start"]))
        );
        assert_eq!(
            parse_terminal_env("foot --app-id=term"),
            Some(("foot", vec!["--app-id=term"]))
        );
        assert_eq!(parse_terminal_env(""), None);
        assert_eq!(parse_terminal_env("   "), None);
    }
}
