//! Read file references off the system clipboard, and write text to it.
//!
//! When a user copies a file in Finder and pastes it into the chat input, the
//! WKWebView `paste` event exposes a `File` object but NOT its absolute path
//! (the web sandbox strips it). So the frontend asks Rust to read the native
//! pasteboard's file URLs directly and inserts those paths into the composer.
//!
//! The write half exists for the same class of reason: `navigator.clipboard`
//! requires a live user activation, which a copy that happens *after* an
//! `await` no longer has. See [`clipboard_write_text`].

/// Put `text` on the system clipboard, bypassing the web clipboard API.
///
/// `navigator.clipboard.writeText` works only while a user activation is in
/// scope. WKWebView drops that activation across an `await`, so any copy that
/// follows a network round-trip — inviting a teammate and copying the invite
/// links the server just minted, say — fails with a bare `NotAllowedError` no
/// matter how the promise is chained. The native pasteboard has no such rule.
///
/// Callers should still try the web API first (it is cross-platform and needs
/// no IPC) and fall back here; `src/lib/clipboard.ts` does exactly that.
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_write_text(&text)
    }
    #[cfg(target_os = "linux")]
    {
        linux_write_text(&text)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = text;
        Err("clipboard writes are only implemented on macOS and Linux".to_string())
    }
}

#[cfg(target_os = "linux")]
fn linux_write_text(text: &str) -> Result<(), String> {
    let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var_os("XDG_SESSION_TYPE").map(|s| s == "wayland").unwrap_or(false);
    linux_write_text_with_runner(text, is_wayland, default_command_runner)
}

#[cfg(any(target_os = "linux", test))]
#[allow(dead_code)]
fn default_command_runner(program: &str, args: &[&str], input: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }

    child.wait().map(|status| status.success()).unwrap_or(false)
}

#[cfg(any(target_os = "linux", test))]
fn linux_write_text_with_runner<F>(text: &str, is_wayland: bool, mut runner: F) -> Result<(), String>
where
    F: FnMut(&str, &[&str], &str) -> bool,
{
    let candidates: &[(&str, &[&str])] = if is_wayland {
        &[
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ]
    } else {
        &[
            ("xclip", &["-selection", "clipboard"]),
            ("wl-copy", &[]),
            ("xsel", &["--clipboard", "--input"]),
        ]
    };

    for (program, args) in candidates {
        if runner(program, args, text) {
            return Ok(());
        }
    }

    Err("failed to write to clipboard via supported helpers (wl-copy, xclip, xsel)".to_string())
}

#[cfg(target_os = "macos")]
fn macos_write_text(text: &str) -> Result<(), String> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::msg_send;
    use std::ffi::CString;

    autoreleasepool(|_| unsafe {
        let (Some(pb_class), Some(str_class)) =
            (AnyClass::get(c"NSPasteboard"), AnyClass::get(c"NSString"))
        else {
            return Err("NSPasteboard unavailable".to_string());
        };

        let pb: *mut AnyObject = msg_send![pb_class, generalPasteboard];
        if pb.is_null() {
            return Err("no general pasteboard".to_string());
        }

        // A write must clear first — `setString:forType:` on a pasteboard whose
        // ownership was not re-claimed is a silent no-op.
        let _: i64 = msg_send![pb, clearContents];

        let value = CString::new(text).map_err(|_| "text contains a NUL byte".to_string())?;
        let value_str: *mut AnyObject = msg_send![str_class, stringWithUTF8String: value.as_ptr()];
        // @"public.utf8-plain-text" — the modern equivalent of NSStringPboardType.
        let Ok(type_c) = CString::new("public.utf8-plain-text") else {
            return Err("bad pasteboard type".to_string());
        };
        let type_str: *mut AnyObject = msg_send![str_class, stringWithUTF8String: type_c.as_ptr()];
        if value_str.is_null() || type_str.is_null() {
            return Err("could not build pasteboard strings".to_string());
        }

        let ok: Bool = msg_send![pb, setString: value_str, forType: type_str];
        if ok.as_bool() {
            Ok(())
        } else {
            Err("the pasteboard refused the write".to_string())
        }
    })
}

/// Absolute POSIX paths of the files currently on the clipboard, in pasteboard
/// order. Empty when the clipboard holds no file references — e.g. plain text,
/// or a raw screenshot bitmap that has no backing file on disk.
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        macos_file_paths()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn macos_file_paths() -> Vec<String> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use std::ffi::{CStr, CString};

    autoreleasepool(|_| unsafe {
        let (Some(pb_class), Some(str_class)) = (
            AnyClass::get(c"NSPasteboard"),
            AnyClass::get(c"NSString"),
        ) else {
            return Vec::new();
        };

        // [NSPasteboard generalPasteboard]
        let pb: *mut AnyObject = msg_send![pb_class, generalPasteboard];
        if pb.is_null() {
            return Vec::new();
        }

        // @"NSFilenamesPboardType" — the classic file-list type Finder writes on
        // a Cmd-C of one or more files. `propertyListForType:` yields an
        // NSArray<NSString*> of POSIX paths.
        let Ok(type_c) = CString::new("NSFilenamesPboardType") else {
            return Vec::new();
        };
        let type_str: *mut AnyObject =
            msg_send![str_class, stringWithUTF8String: type_c.as_ptr()];
        if type_str.is_null() {
            return Vec::new();
        }

        let plist: *mut AnyObject = msg_send![pb, propertyListForType: type_str];
        if plist.is_null() {
            return Vec::new();
        }

        let count: usize = msg_send![plist, count];
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let s: *mut AnyObject = msg_send![plist, objectAtIndex: i];
            if s.is_null() {
                continue;
            }
            let c: *const std::os::raw::c_char = msg_send![s, UTF8String];
            if c.is_null() {
                continue;
            }
            let path = CStr::from_ptr(c).to_string_lossy().into_owned();
            if !path.is_empty() {
                out.push(path);
            }
        }
        out
    })
}

/// Largest paste we will spool to disk — the Spaces media ceiling.
const SCRATCH_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Scratch files older than this are swept on the next write.
const SCRATCH_TTL_SECS: u64 = 24 * 60 * 60;

/// Spool raw bytes to `<app_cache_dir>/pasted/<uuid>.<ext>` and return the path.
///
/// Every upload path in the app (team-chat attachments, Space media) takes a
/// file *path* — that is what the OS drag-drop and file picker hand over. A
/// pasted screenshot is the one source that arrives as bytes: WKWebView's
/// `paste` event exposes a nameless `File` with no path. Rather than teach two
/// upload pipelines a second input shape, the renderer parks the bytes here
/// and feeds the path into the existing one.
///
/// The body is raw IPC (`InvokeBody::Raw`) — a multi-megabyte screenshot must
/// not round-trip through base64 JSON. The filename rides in `x-filename`;
/// only its basename and extension are trusted, and the extension is what the
/// downstream content-type guess keys on.
#[tauri::command]
pub fn scratch_write_bytes(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    use tauri::Manager;

    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected a raw body".to_string()),
    };
    if bytes.is_empty() {
        return Err("nothing to paste".to_string());
    }
    if bytes.len() > SCRATCH_MAX_BYTES {
        return Err("that file is larger than 64 MB".to_string());
    }

    let requested = request
        .headers()
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(percent_decode)
        .unwrap_or_else(|| "pasted.png".to_string());
    // Basename only: a header is untrusted input and must never pick a directory.
    let base = std::path::Path::new(requested.as_str())
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("pasted.png");
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() && e.len() <= 8 => {
            (s, e.to_ascii_lowercase())
        }
        _ => (base, "png".to_string()),
    };
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    let ext: String = ext.chars().filter(char::is_ascii_alphanumeric).collect();
    let ext = if ext.is_empty() {
        "png".to_string()
    } else {
        ext
    };

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("pasted");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    sweep_scratch(&dir);

    let path = dir.join(format!("{stem}-{}.{ext}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Undo the renderer's `encodeURIComponent` — HTTP header values are ASCII, so
/// a non-Latin filename has to travel escaped. Malformed escapes pass through.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Best-effort removal of stale scratch files. Failures are ignored — a sweep
/// that cannot run must never block the paste that triggered it.
fn sweep_scratch(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .map(|age| age.as_secs() > SCRATCH_TTL_SECS)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linux_clipboard_wayland_success_first_helper() {
        let mut calls = Vec::new();
        let res = linux_write_text_with_runner("hello", true, |prog, args, input| {
            calls.push((
                prog.to_string(),
                args.iter().map(ToString::to_string).collect::<Vec<_>>(),
                input.to_string(),
            ));
            true
        });
        assert!(res.is_ok());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "wl-copy");
        assert_eq!(calls[0].1, Vec::<String>::new());
        assert_eq!(calls[0].2, "hello");
    }

    #[test]
    fn test_linux_clipboard_wayland_fallback_xclip() {
        let mut calls = Vec::new();
        let res = linux_write_text_with_runner("hello", true, |prog, args, input| {
            calls.push((
                prog.to_string(),
                args.iter().map(ToString::to_string).collect::<Vec<_>>(),
                input.to_string(),
            ));
            prog == "xclip"
        });
        assert!(res.is_ok());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "wl-copy");
        assert_eq!(calls[1].0, "xclip");
        assert_eq!(calls[1].1, vec!["-selection", "clipboard"]);
        assert_eq!(calls[1].2, "hello");
    }

    #[test]
    fn test_linux_clipboard_wayland_fallback_xsel() {
        let mut calls = Vec::new();
        let res = linux_write_text_with_runner("hello", true, |prog, args, input| {
            calls.push((
                prog.to_string(),
                args.iter().map(ToString::to_string).collect::<Vec<_>>(),
                input.to_string(),
            ));
            prog == "xsel"
        });
        assert!(res.is_ok());
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "wl-copy");
        assert_eq!(calls[1].0, "xclip");
        assert_eq!(calls[2].0, "xsel");
        assert_eq!(calls[2].1, vec!["--clipboard", "--input"]);
        assert_eq!(calls[2].2, "hello");
    }

    #[test]
    fn test_linux_clipboard_x11_success_first_helper() {
        let mut calls = Vec::new();
        let res = linux_write_text_with_runner("hello x11", false, |prog, args, input| {
            calls.push((
                prog.to_string(),
                args.iter().map(ToString::to_string).collect::<Vec<_>>(),
                input.to_string(),
            ));
            true
        });
        assert!(res.is_ok());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "xclip");
        assert_eq!(calls[0].1, vec!["-selection", "clipboard"]);
        assert_eq!(calls[0].2, "hello x11");
    }

    #[test]
    fn test_linux_clipboard_x11_fallback_wl_copy() {
        let mut calls = Vec::new();
        let res = linux_write_text_with_runner("hello", false, |prog, args, input| {
            calls.push((
                prog.to_string(),
                args.iter().map(ToString::to_string).collect::<Vec<_>>(),
                input.to_string(),
            ));
            prog == "wl-copy"
        });
        assert!(res.is_ok());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "xclip");
        assert_eq!(calls[1].0, "wl-copy");
    }

    #[test]
    fn test_linux_clipboard_x11_fallback_xsel() {
        let mut calls = Vec::new();
        let res = linux_write_text_with_runner("hello", false, |prog, args, input| {
            calls.push((
                prog.to_string(),
                args.iter().map(ToString::to_string).collect::<Vec<_>>(),
                input.to_string(),
            ));
            prog == "xsel"
        });
        assert!(res.is_ok());
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "xclip");
        assert_eq!(calls[1].0, "wl-copy");
        assert_eq!(calls[2].0, "xsel");
    }

    #[test]
    fn test_linux_clipboard_all_fail() {
        let mut calls = Vec::new();
        let res = linux_write_text_with_runner("fail", false, |prog, args, input| {
            calls.push((
                prog.to_string(),
                args.iter().map(ToString::to_string).collect::<Vec<_>>(),
                input.to_string(),
            ));
            false
        });
        assert!(res.is_err());
        assert_eq!(calls.len(), 3);
        assert_eq!(
            res.unwrap_err(),
            "failed to write to clipboard via supported helpers (wl-copy, xclip, xsel)"
        );
    }

    #[test]
    fn test_default_command_runner_handles_missing_binary() {
        assert!(!default_command_runner("non_existent_binary_xyz_123", &[], "test"));
    }
}
