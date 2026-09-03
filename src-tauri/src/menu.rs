//! Native macOS application menu.
//!
//! Atlas previously shipped no menu, so Tauri installed its *default* menu —
//! whose Window ▸ Close item (Cmd+W) calls `performClose:` on the key window.
//! In the main webview that's harmless: the keybinding dispatcher
//! (`features/keybindings`) catches the "close tab" chord and
//! `preventDefault()`s it, so WebKit reports the key equivalent as handled and
//! the menu never fires.
//!
//! But the embedded browser (`commands::browser`) is a *separate* native child
//! webview loading remote pages. Those pages don't preventDefault Cmd+W, so the
//! key equivalent fell through to the default Close item and tore down the whole
//! window — taking the app with it.
//!
//! Fix: define our own menu that mirrors the macOS standard (so Copy/Paste/etc.
//! still work in every webview) but replaces the predefined Close item with a
//! custom `atlas-close-tab` item. Its handler (wired in `lib.rs`) emits
//! `atlas:close-active-tab` to the main webview, which closes the active *tab*
//! instead of the window. The main-webview preventDefault path is unchanged, so
//! this only takes effect when a child webview has focus.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, Wry};

/// Menu item id for the Cmd+W "close tab" action. Matched in the
/// `on_menu_event` handler in `lib.rs`.
pub const CLOSE_TAB_ID: &str = "atlas-close-tab";

/// The Close Tab item, kept as managed state so its accelerator can follow the
/// user's `close-tab` binding. Rebuilding the whole menu to change one chord
/// would drop the macOS application menu for as long as it took.
pub struct CloseTabItem(pub MenuItem<Wry>);

/// Point the native Close Tab item at `accelerator` (Tauri's spelling, sent by
/// the frontend — see `native-accelerator.ts`), or unbind it with `None`.
///
/// This item only ever fires while a child webview holds focus, since the
/// dispatcher handles the chord itself everywhere else. Keeping it in step is
/// what stops the embedded browser from closing tabs on a chord the user
/// retired.
#[tauri::command]
pub fn set_close_tab_accelerator(
    accelerator: Option<String>,
    item: tauri::State<'_, CloseTabItem>,
) -> Result<(), String> {
    item.0.set_accelerator(accelerator.as_deref()).map_err(|e| e.to_string())
}

pub fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // App menu (first submenu → becomes the macOS application menu).
    let app_menu = Submenu::with_items(
        app,
        "Atlas",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Standard Edit menu — provides Cmd+C/V/X/A key equivalents that native
    // webviews (including the embedded browser) rely on.
    //
    // Undo/Redo are DELIBERATELY OMITTED. The predefined items bind Cmd+Z /
    // Cmd+Shift+Z to AppKit's `undo:` / `redo:` editing selectors, which macOS
    // routes straight to WKWebView's native editing-undo via the responder
    // chain — WITHOUT dispatching a JS keydown to the page. That shadowed
    // CodeMirror's own history (`historyKeymap`), so Cmd+Z did nothing in the
    // code editor. Without these items Cmd+Z reaches the page as a normal
    // keydown: CodeMirror handles its undo, and the embedded browser's text
    // fields still undo via WebKit's built-in editing default action.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // View menu — keep the standard fullscreen toggle (⌃⌘F) that the default
    // menu provided.
    let view_menu = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;

    // Window menu — Cmd+W is our custom "close tab" item, NOT the predefined
    // close-window (which would tear down the app from a focused child webview).
    // Starts on the default chord and is re-pointed once the frontend has read
    // the keymap out of `config.toml` (`set_close_tab_accelerator`).
    let close_tab = MenuItem::with_id(app, CLOSE_TAB_ID, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    app.manage(CloseTabItem(close_tab.clone()));
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}
