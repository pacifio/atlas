//! Native window controls that Tauri's cross-platform API doesn't cover.

/// Perform the macOS window "zoom" (the green-button / double-click-title
/// behaviour). Tauri's `toggleMaximize()` does NOT map to AppKit's zoom on
/// macOS, so a double-click on our custom titlebar appeared to do nothing.
/// We call `-[NSWindow performZoom:]` directly instead.
///
/// AppKit calls must run on the main thread, so the message is dispatched
/// via `run_on_main_thread`. No-op on non-macOS.
#[tauri::command]
pub fn window_zoom(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(ptr) = win.ns_window() {
                    // `ns_window()` returns the NSWindow as a `*mut c_void`.
                    use objc2::runtime::AnyObject;
                    let ns = ptr as *mut AnyObject;
                    if ns.is_null() {
                        return;
                    }
                    unsafe {
                        let _: () = objc2::msg_send![
                            &*ns,
                            performZoom: core::ptr::null_mut::<AnyObject>()
                        ];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
    Ok(())
}

/// Set the native window title. The frontend drives this from the active
/// project so the OS shows `projectName - Atlas` (visible on minimize /
/// window-menu / hover), falling back to plain `Atlas` when no project is
/// open. Tauri's JS `setTitle` exists, but routing it through a command
/// keeps the title an effect of Rust-owned project state.
///
/// On macOS the title is set here, on the main thread, rather than through
/// `window.set_title`: AppKit re-lays the titlebar out on a title change,
/// which drops the traffic lights back to their default spot, and tauri's
/// `set_title` lands on a later event-loop turn than anything queued after it.
/// Setting it directly lets `apply_traffic_light_inset` run after it.
#[tauri::command]
pub fn set_window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(ptr) = win.ns_window() else { return };
                let ns_window = ptr as *mut objc2::runtime::AnyObject;
                if ns_window.is_null() {
                    return;
                }
                let title = objc2_foundation::NSString::from_str(&title);
                // SAFETY: on the main thread, with a live NSWindow.
                unsafe {
                    let () = objc2::msg_send![&*ns_window, setTitle: &*title];
                }
                if let Some((x, y)) = traffic_light_position(&win) {
                    // SAFETY: as above.
                    unsafe { inset_traffic_lights(&*ns_window, x, y) };
                }
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_title(&title).map_err(|e| e.to_string())
    }
}

/// Put the traffic lights where `trafficLightPosition` in `tauri.conf.json`
/// says, now. Called once the main window exists (`lib.rs` setup).
///
/// tao applies that position only from its content view's `drawRect:`. With
/// tauri's `unstable` feature the main webview is a child that covers that
/// view, so it redraws only on a resize, and AppKit lays the titlebar out
/// again (lights back at x 7, centred ~14pt down) when the window first shows
/// and on every title change. So until the first resize the lights sat high
/// and left of the bar. No-op off macOS, or for a window with no position.
pub fn apply_traffic_light_inset(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let Some((x, y)) = traffic_light_position(window) else {
            return;
        };
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(ptr) = win.ns_window() else { return };
            let ns_window = ptr as *mut objc2::runtime::AnyObject;
            if ns_window.is_null() {
                return;
            }
            // SAFETY: on the main thread, with a live NSWindow.
            unsafe { inset_traffic_lights(&*ns_window, x, y) };
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
}

/// This window's `trafficLightPosition`, from the config it was built from.
#[cfg(target_os = "macos")]
fn traffic_light_position(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    use tauri::Manager;
    window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == window.label())
        .and_then(|w| w.traffic_light_position.as_ref())
        .map(|p| (p.x, p.y))
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

#[cfg(target_os = "macos")]
mod encode {
    use super::{CgPoint, CgRect, CgSize};
    use objc2::{Encode, Encoding, RefEncode};

    // SAFETY: field for field the layout and encoding of CoreGraphics'
    // CGPoint / CGSize / CGRect (64-bit: `CGFloat` is `f64`).
    unsafe impl Encode for CgPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl RefEncode for CgPoint {
        const ENCODING_REF: Encoding = Encoding::Pointer(&<Self as Encode>::ENCODING);
    }
    unsafe impl Encode for CgSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl RefEncode for CgSize {
        const ENCODING_REF: Encoding = Encoding::Pointer(&<Self as Encode>::ENCODING);
    }
    unsafe impl Encode for CgRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[CgPoint::ENCODING, CgSize::ENCODING]);
    }
    unsafe impl RefEncode for CgRect {
        const ENCODING_REF: Encoding = Encoding::Pointer(&<Self as Encode>::ENCODING);
    }
}

/// tao's `inset_traffic_lights`, in effect: make the titlebar container
/// `button height + y` tall (the buttons are 16pt and keep AppKit's 6pt
/// offset from the container's bottom, so their centre lands `y + 2`pt below
/// the window top), then place button `i` at `x + i * spacing`.
///
/// # Safety
/// Main thread only; `ns_window` must be a live NSWindow.
#[cfg(target_os = "macos")]
unsafe fn inset_traffic_lights(ns_window: &objc2::runtime::AnyObject, x: f64, y: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // Flush a pending titlebar layout first, or it lands after this and puts
    // the buttons straight back.
    let () = unsafe { msg_send![ns_window, layoutIfNeeded] };
    // NSWindowCloseButton / MiniaturizeButton / ZoomButton.
    let buttons: Vec<*mut AnyObject> = (0usize..3)
        .map(|kind| unsafe { msg_send![ns_window, standardWindowButton: kind] })
        .collect();
    if buttons.iter().any(|b| b.is_null()) {
        return;
    }
    let close = unsafe { &*buttons[0] };
    let superview: *mut AnyObject = unsafe { msg_send![close, superview] };
    if superview.is_null() {
        return;
    }
    let container: *mut AnyObject = unsafe { msg_send![&*superview, superview] };
    if container.is_null() {
        return;
    }
    let container = unsafe { &*container };

    let close_rect: CgRect = unsafe { msg_send![close, frame] };
    let window_rect: CgRect = unsafe { msg_send![ns_window, frame] };
    let mut title_bar: CgRect = unsafe { msg_send![container, frame] };
    title_bar.size.height = close_rect.size.height + y;
    title_bar.origin.y = window_rect.size.height - title_bar.size.height;
    let () = unsafe { msg_send![container, setFrame: title_bar] };

    let mini_rect: CgRect = unsafe { msg_send![&*buttons[1], frame] };
    let spacing = mini_rect.origin.x - close_rect.origin.x;
    for (i, button) in buttons.iter().enumerate() {
        let button = unsafe { &**button };
        let mut rect: CgRect = unsafe { msg_send![button, frame] };
        rect.origin.x = x + i as f64 * spacing;
        let () = unsafe { msg_send![button, setFrameOrigin: rect.origin] };
    }
}
