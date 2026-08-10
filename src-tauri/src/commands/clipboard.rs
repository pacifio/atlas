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
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("clipboard writes are only implemented on macOS".to_string())
    }
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
