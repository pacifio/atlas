//! The activity log's on-disk half.
//!
//! Two files, and the split matters. A **project** log lives inside the project
//! (`<project>/.atlas/logs.jsonl`), so it is already scoped to exactly one
//! Organisation by construction — a project belongs to one. The **pinned** log
//! is the one that was global: a single `~/.atlas/log/pinned.jsonl` mixing every
//! org's kept entries into one list, which is what made the console a global
//! surface in an app whose every other surface is per-org.
//!
//! It is now `~/.atlas/log/orgs/<org>/pinned.jsonl`, with the legacy file
//! adopted by the first org that asks for it (see [`pinned_path`]) so nothing
//! anyone pinned before this change is lost.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Directory holding one org's log files.
fn org_log_dir(org: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let root = home.join(".atlas").join("log");
    // An org id is a UUID we minted, but it arrives from the renderer — so
    // treat it as untrusted and refuse anything that could climb out of the log
    // directory rather than trusting the caller.
    if org.is_empty() || org.contains(['/', '\\']) || org.contains("..") {
        return Err("invalid organisation id".into());
    }
    Ok(root.join("orgs").join(org))
}

/// Where the pre-org global pinned log lived.
fn legacy_pinned_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".atlas").join("log").join("pinned.jsonl"))
}

/// This org's pinned log, adopting the legacy global file if it has not been
/// claimed yet.
///
/// The adoption is a **move**, not a copy, and it is first-come: whichever org
/// is active the first time the console opens after upgrading inherits the old
/// pins. Copying into every org instead would duplicate each entry N times,
/// and dropping them would silently discard the one thing in this feature the
/// user explicitly asked to keep.
fn pinned_path(org: &str) -> Result<PathBuf, String> {
    let dir = org_log_dir(org)?;
    let path = dir.join("pinned.jsonl");
    if !path.exists() {
        if let Ok(legacy) = legacy_pinned_path() {
            if legacy.exists() {
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                // A failed rename is not fatal — the caller just starts empty.
                let _ = fs::rename(&legacy, &path);
            }
        }
    }
    Ok(path)
}

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One Organisation's pinned entries. Empty for an org that has pinned nothing.
#[tauri::command]
pub async fn load_pinned_log(org: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = pinned_path(&org)?;
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_pinned_log(org: String, entry_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path(&org)?;
        ensure_dir(&path)?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        // Strip any newlines in the entry so each line is one entry.
        let single = entry_json.replace('\n', " ");
        writeln!(f, "{single}").map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clear **this org's** pins only. Another Organisation's kept entries are a
/// different file and are not touched.
#[tauri::command]
pub async fn clear_pinned_log(org: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path(&org)?;
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rewrite_pinned_log(org: String, entries_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path(&org)?;
        ensure_dir(&path)?;
        // Caller passes the full body (each line one entry, newline separated).
        fs::write(&path, &entries_json).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Project-scoped activity log ──────────────────────────────────────────────
//
// The Log view's full activity stream is persisted PER PROJECT at
// `<project>/.atlas/logs.jsonl` (one JSON entry per line) so it survives app
// restarts and never bleeds across projects. The file is soft-capped so a
// long-lived project can't grow it without bound.

/// Keep the project log under this many bytes (trimmed from the front).
const PROJECT_LOG_CAP_BYTES: u64 = 1024 * 1024; // 1 MB

fn project_log_path(project: &str) -> PathBuf {
    PathBuf::from(project).join(".atlas").join("logs.jsonl")
}

#[tauri::command]
pub async fn load_project_log(project: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = project_log_path(&project);
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_project_log(project: String, entry_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = project_log_path(&project);
        ensure_dir(&path)?;
        {
            let mut f = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            let single = entry_json.replace('\n', " ");
            writeln!(f, "{single}").map_err(|e| e.to_string())?;
        }
        // Soft-cap: if the file grew past the limit, keep the most recent bytes
        // starting at a line boundary.
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > PROJECT_LOG_CAP_BYTES {
                if let Ok(content) = fs::read_to_string(&path) {
                    let keep_from = content.len().saturating_sub((PROJECT_LOG_CAP_BYTES / 2) as usize);
                    let start = content[keep_from..]
                        .find('\n')
                        .map(|i| keep_from + i + 1)
                        .unwrap_or(keep_from);
                    let _ = fs::write(&path, &content[start..]);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_project_log(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = project_log_path(&project);
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
