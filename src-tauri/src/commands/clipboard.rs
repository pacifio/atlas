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
    let is_wayland = std::env::var_os("WAYLAND_DISPLAY")
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        || std::env::var_os("XDG_SESSION_TYPE")
            .map(|s| s == "wayland")
            .unwrap_or(false);
    linux_write_text_with_runner(text, is_wayland, default_command_runner)
}

#[cfg(any(target_os = "linux", test))]
#[allow(dead_code)]
fn default_command_runner(program: &str, args: &[&str], input: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };

    // Feed stdin on a background thread so pipe buffer saturation (>64KB on Linux)
    // never hangs the calling thread if the helper fails to drain stdin immediately.
    let input_bytes = input.as_bytes().to_vec();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let res = stdin.write_all(&input_bytes).and_then(|_| stdin.flush());
        drop(stdin); // Send EOF to helper
        let _ = tx.send(res);
    });

    // Bounded timeout for feeding stdin
    let write_timeout = Duration::from_millis(1500);
    match rx.recv_timeout(write_timeout) {
        Ok(Ok(())) => {}
        // The helper closed stdin before taking all of it, usually by exiting:
        // its exit status is the answer, not the broken pipe. A fast runner
        // hit this with `true`, which exits without reading.
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::BrokenPipe => {
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(status)) => return status.success(),
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
    }

    // Give the helper a brief startup window to detect immediate failure (e.g. invalid
    // arguments, missing dependencies, or display connection rejected on launch). If it
    // exits with an error status, return false so fallback helpers can be attempted.
    let startup_check = Duration::from_millis(100);
    let start = Instant::now();
    while start.elapsed() < startup_check {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }

    // On X11, clipboard helpers such as xclip and xsel must remain running as the
    // selection owner to serve subsequent paste requests from other applications.
    // Since stdin was successfully delivered and the helper did not exit with an error,
    // treat the handoff as success and reap the child asynchronously when it terminates.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    true
}

#[cfg(any(target_os = "linux", test))]
fn linux_write_text_with_runner<F>(
    text: &str,
    is_wayland: bool,
    mut runner: F,
) -> Result<(), String>
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
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
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

/// Linux: the paths a paste should attach, as GTK's clipboard sees them —
/// the copied files, else the clipboard's image spooled to the scratch
/// directory as a file. Empty when it holds neither.
///
/// WebKitGTK's `paste` event carries nothing a renderer could attach: for a
/// clipboard image no `File`, no `items`, an empty `types`; for a copied
/// file `text/uri-list` listed as a type with an empty string behind it and
/// no `Files`. So neither the `scratch_write_bytes` route a screenshot takes
/// under WKWebView nor the `clipboard_file_paths` one is reachable there.
/// GTK's own clipboard sees both; this reads it there, keeping the image's
/// bytes as offered when the format is one the attach route knows. The
/// other platforms answer empty: their paste event carries what they need,
/// and the renderer asks only on Linux.
#[tauri::command]
pub async fn clipboard_paste_paths(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "linux")]
    {
        match linux::with_clipboard(&app, linux::pasted).await? {
            linux::Pasted::Files(paths) => Ok(paths),
            linux::Pasted::Image { ext, bytes } => {
                spool_scratch(&app, &format!("pasted.{ext}"), &bytes).map(|path| vec![path])
            }
            linux::Pasted::Nothing => Ok(Vec::new()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
fn macos_file_paths() -> Vec<String> {
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{CStr, CString};

    autoreleasepool(|_| unsafe {
        let (Some(pb_class), Some(str_class)) =
            (AnyClass::get(c"NSPasteboard"), AnyClass::get(c"NSString"))
        else {
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
        let type_str: *mut AnyObject = msg_send![str_class, stringWithUTF8String: type_c.as_ptr()];
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
    spool_scratch(&app, &requested, bytes)
}

/// Write `bytes` to `<app_cache_dir>/pasted/<stem>-<uuid>.<ext>`, the stem
/// and extension taken from `requested` once it has been reduced to a safe
/// basename, and return the path.
fn spool_scratch(app: &tauri::AppHandle, requested: &str, bytes: &[u8]) -> Result<String, String> {
    use tauri::Manager;

    // Basename only: a header is untrusted input and must never pick a directory.
    let base = std::path::Path::new(requested)
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

/// Image flavours the attach route takes as they are, most preferred first,
/// each with the extension its scratch file gets.
#[cfg(any(target_os = "linux", test))]
const IMAGE_TARGETS: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
    ("image/bmp", "bmp"),
];

/// The first of `IMAGE_TARGETS` the clipboard offers.
#[cfg(any(target_os = "linux", test))]
fn pick_image_target(offered: &[String]) -> Option<(&'static str, &'static str)> {
    IMAGE_TARGETS
        .iter()
        .copied()
        .find(|(mime, _)| offered.iter().any(|o| o == mime))
}

/// Local `file://` URIs as absolute, percent-decoded paths. Anything else — a
/// remote `sftp://`, the `http://` link a browser puts beside a copied
/// address — is skipped.
#[cfg(any(target_os = "linux", test))]
fn paths_from_file_uris<'a>(uris: impl Iterator<Item = &'a str>) -> Vec<String> {
    uris.filter_map(|uri| {
        let rest = uri.trim().strip_prefix("file://")?;
        // `file:///x` has an empty host, `file://localhost/x` names this
        // machine; any other host is a remote file.
        let path = match rest.find('/') {
            Some(0) => rest,
            Some(i) if &rest[..i] == "localhost" => &rest[i..],
            _ => return None,
        };
        let path = percent_decode(path);
        (!path.is_empty()).then_some(path)
    })
    .collect()
}

// ── Linux: GTK's clipboard ───────────────────────────────────────────────────
//
// WebKitGTK gives the renderer's `paste` event nothing a file or an image
// could be taken from (see `clipboard_paste_paths`), so Atlas reads the
// clipboard through GTK itself. GTK objects live on the main thread, where tao runs the GTK loop,
// so every read hops there; the `wait_for_*` calls iterate that loop until
// the clipboard's owner has answered, which keeps the window painting.
#[cfg(target_os = "linux")]
mod linux {
    use gtk::gdk;

    /// Run `read` against the system clipboard on the GTK main thread and
    /// hand its answer back.
    pub async fn with_clipboard<T, F>(app: &tauri::AppHandle, read: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&gtk::Clipboard) -> T + Send + 'static,
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let _ = tx.send(read(&clipboard));
        })
        .map_err(|e| e.to_string())?;
        rx.await
            .map_err(|_| "the clipboard read never answered".to_string())
    }

    /// What a paste should attach.
    pub enum Pasted {
        Files(Vec<String>),
        Image { ext: String, bytes: Vec<u8> },
        Nothing,
    }

    /// The copied files, else the image, else nothing — one read, so the
    /// hop to the main thread happens once per paste.
    pub fn pasted(clipboard: &gtk::Clipboard) -> Pasted {
        let files = file_paths(clipboard);
        if !files.is_empty() {
            return Pasted::Files(files);
        }
        match image(clipboard) {
            Some((ext, bytes)) => Pasted::Image { ext, bytes },
            None => Pasted::Nothing,
        }
    }

    /// The `file://` URIs on the clipboard, as paths.
    fn file_paths(clipboard: &gtk::Clipboard) -> Vec<String> {
        let uris = clipboard.wait_for_uris();
        super::paths_from_file_uris(uris.iter().map(gtk::glib::GString::as_str))
    }

    /// The clipboard's image as `(extension, bytes)`: the bytes as offered
    /// when the format is one the attach route knows, otherwise decoded by
    /// GdkPixbuf and re-encoded as PNG. `None` when no image is offered.
    fn image(clipboard: &gtk::Clipboard) -> Option<(String, Vec<u8>)> {
        let targets = clipboard.wait_for_targets().unwrap_or_default();
        let names: Vec<String> = targets.into_iter().map(|a| a.name().to_string()).collect();
        if let Some((mime, ext)) = super::pick_image_target(&names) {
            if let Some(data) = clipboard.wait_for_contents(&gdk::Atom::intern(mime)) {
                let bytes = data.data();
                if !bytes.is_empty() {
                    return Some((ext.to_string(), bytes));
                }
            }
        }
        if !names.iter().any(|n| n.starts_with("image/")) {
            return None;
        }
        let pixbuf = clipboard.wait_for_image()?;
        pixbuf
            .save_to_bufferv("png", &[])
            .ok()
            .map(|bytes| ("png".to_string(), bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uris_become_local_paths_only() {
        let uris = [
            "file:///home/u/Pictures/a%20b.png",
            "file://localhost/tmp/x.png",
            "file://nas/share/y.png",
            "http://example.com/z.png",
            "  file:///tmp/c.png\r",
            "file://",
        ];
        assert_eq!(
            paths_from_file_uris(uris.into_iter()),
            vec!["/home/u/Pictures/a b.png", "/tmp/x.png", "/tmp/c.png"]
        );
    }

    #[test]
    fn image_target_prefers_the_bytes_as_offered() {
        let offered = |s: &[&str]| s.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert_eq!(
            pick_image_target(&offered(&["text/plain", "image/jpeg", "image/png"])),
            Some(("image/png", "png"))
        );
        assert_eq!(
            pick_image_target(&offered(&["image/jpeg"])),
            Some(("image/jpeg", "jpg"))
        );
        assert_eq!(pick_image_target(&offered(&["image/tiff"])), None);
        assert_eq!(pick_image_target(&[]), None);
    }

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
        assert!(!default_command_runner(
            "non_existent_binary_xyz_123",
            &[],
            "test"
        ));
    }

    #[test]
    #[cfg(unix)]
    fn test_default_command_runner_immediate_success() {
        assert!(default_command_runner("true", &[], "test"));
    }

    #[test]
    #[cfg(unix)]
    fn test_default_command_runner_immediate_failure() {
        assert!(!default_command_runner("false", &[], "test"));
    }

    #[test]
    #[cfg(unix)]
    fn test_default_command_runner_stdin_reading_binary() {
        assert!(default_command_runner("cat", &[], "hello world"));
    }

    #[test]
    #[cfg(unix)]
    fn test_default_command_runner_persistent_helper_stays_alive_and_succeeds() {
        let start = std::time::Instant::now();
        let ok = default_command_runner("sleep", &["2"], "test");
        let elapsed = start.elapsed();
        assert!(ok);
        assert!(elapsed < std::time::Duration::from_millis(500));
    }

    #[test]
    #[cfg(unix)]
    fn test_default_command_runner_stdin_failure_does_not_block() {
        let start = std::time::Instant::now();
        let ok =
            default_command_runner("sh", &["-c", "exec 0<&-; sleep 10"], &"a".repeat(1_000_000));
        let elapsed = start.elapsed();
        assert!(!ok);
        assert!(elapsed < std::time::Duration::from_millis(2500));
    }

    #[test]
    #[cfg(unix)]
    fn test_default_command_runner_empty_input() {
        assert!(default_command_runner("cat", &[], ""));
    }
}
