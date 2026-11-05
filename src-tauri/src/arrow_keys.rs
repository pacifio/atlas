//! Arrow keys the webview leaves unhandled must not be typed as text (macOS).
//!
//! With tauri's `unstable` feature (on for the browser tab's child webview),
//! every webview, the main window's included, is built as a *child*: the
//! WKWebView sits directly in tao's `TaoView`. An arrow key WebKit does not
//! use (→ at the end of a field, ← at its start) bubbles up the responder
//! chain to `TaoView`'s `keyDown:`, which runs `interpretKeyEvents:` on it,
//! and the key's character code (U+001C–U+001F for ← → ↑ ↓) is inserted
//! into the focused field as a glyphless box. No `keydown` listener sees it
//! happen, and the insertion goes around the DOM's own key handling.
//!
//! wry's non-child path is protected: `WryWebViewParent`'s `keyDown:` hands
//! the event to the menu and nothing else (wry#769). The child path never
//! got that guard (tauri-apps/tauri#10194, open). Until it does, this
//! replaces `TaoView`'s `keyDown:` with one that drops the four arrow keys
//! and forwards everything else to tao unchanged. The arrows' real work
//! happened in WebKit before the bubble; tao's own keyboard events for them
//! go nowhere in Atlas, and menu shortcuts are matched by
//! `performKeyEquivalent:`, before `keyDown:`.
//!
//! The CodeMirror composer never showed this: it handled every arrow itself
//! and called `preventDefault`, which marks the key handled, so it never
//! bubbled.

use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};

type KeyDown = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

/// tao's own `keyDown:`, called for every key that is not an arrow.
static TAO_KEY_DOWN: OnceLock<KeyDown> = OnceLock::new();

/// `kVK_LeftArrow` … `kVK_UpArrow`.
const ARROW_KEY_CODES: std::ops::RangeInclusive<u16> = 123..=126;

/// Install the guard. Call once a window exists: tao registers `TaoView` when
/// it builds its first view. Swapping the class's method covers views built
/// before and after.
pub fn install() {
    if TAO_KEY_DOWN.get().is_some() {
        return;
    }
    let Some(class) = AnyClass::get(c"TaoView") else {
        tracing::warn!(target: "atlas::arrow_keys", "arrow-key guard not installed: no TaoView class");
        return;
    };
    let Some(method) = class.instance_method(sel!(keyDown:)) else {
        tracing::warn!(target: "atlas::arrow_keys", "arrow-key guard not installed: TaoView has no keyDown:");
        return;
    };
    let guard: KeyDown = key_down;
    // SAFETY: `key_down` has `keyDown:`'s signature (`v@:@`), and forwards to
    // the implementation it replaces for every key it does not drop. The
    // original is stored before any event can reach the new one: AppKit
    // delivers key events on this (the main) thread, after `setup` returns.
    unsafe {
        let original = method.set_implementation(std::mem::transmute::<KeyDown, Imp>(guard));
        let _ = TAO_KEY_DOWN.set(std::mem::transmute::<Imp, KeyDown>(original));
    }
}

unsafe extern "C-unwind" fn key_down(this: *mut AnyObject, sel: Sel, event: *mut AnyObject) {
    // SAFETY: AppKit passes a live NSEvent.
    let key_code: u16 = unsafe { msg_send![&*event, keyCode] };
    if ARROW_KEY_CODES.contains(&key_code) {
        return;
    }
    if let Some(original) = TAO_KEY_DOWN.get() {
        // SAFETY: tao's `keyDown:`, called as AppKit would have.
        unsafe { original(this, sel, event) };
    }
}
