//! Native macOS application menu, built from `src-tauri/menu.json`.
//!
//! The menu model is shared: the frontend draws the same menus inside the
//! Windows/Linux titlebar (`src/features/menu/`), so the two cannot list
//! different items. Every custom item carries its model id — a keybinding
//! action id or a menu-only command id — and clicking it emits
//! [`MENU_EVENT`] with that id; the renderer runs it (`runAction` for an
//! action), the same code the chord runs.
//!
//! Why Atlas ships its own menu at all: without one Tauri installs its
//! *default* menu, whose Window ▸ Close (Cmd+W) calls `performClose:` on the
//! key window. In the main webview that is harmless — the keybinding
//! dispatcher (`useActionHotkeys` in `App.tsx`) `preventDefault()`s every chord
//! it handles, so WebKit reports the key equivalent as handled and the menu
//! never fires. But the embedded browser (`commands::browser`) is a separate
//! native child webview loading remote pages that don't preventDefault Cmd+W,
//! so the chord fell through to the default Close item and tore down the whole
//! window. Here the chord belongs to the Close Tab item, which closes the tab.
//!
//! The same fallthrough is what makes every accelerator below useful: while
//! the embedded browser has focus, the menu is the only thing that hears
//! Atlas's chords. In the main webview the dispatcher still wins, so nothing
//! runs twice. Accelerators follow the user's bindings
//! (`menu_set_accelerators`); items start without one until the renderer has
//! read `keybindings.json`.

use std::collections::HashMap;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::Manager;

/// The one event every custom menu item emits; the payload is the item id.
pub const MENU_EVENT: &str = "atlas:menu-command";

const MODEL_JSON: &str = include_str!("../menu.json");

#[derive(Debug, Deserialize)]
pub struct MenuModel {
    pub menus: Vec<MenuDef>,
}

#[derive(Debug, Deserialize)]
pub struct MenuDef {
    pub id: String,
    pub label: String,
    pub items: Vec<ItemDef>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ItemDef {
    Action { id: String, label: String },
    Command { id: String, label: String },
    Role { role: Role },
    Separator,
}

/// The native items Atlas uses. Undo/Redo are DELIBERATELY absent: the
/// predefined items bind Cmd+Z / Cmd+Shift+Z to AppKit's `undo:` / `redo:`
/// selectors, which macOS routes straight to WKWebView's native editing undo
/// WITHOUT dispatching a JS keydown — that shadowed CodeMirror's own history,
/// so Cmd+Z did nothing in the code editor. Without them Cmd+Z reaches the
/// page: CodeMirror undoes, and the embedded browser's text fields still undo
/// through WebKit's built-in editing default.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Zoom,
    BringAllToFront,
}

pub fn model() -> MenuModel {
    serde_json::from_str(MODEL_JSON).expect("src-tauri/menu.json is valid (pinned by tests)")
}

/// Every custom item by id, managed so `menu_set_accelerators` can re-point
/// accelerators without rebuilding the menu. Only exists where the menu does.
pub struct MenuItems(pub HashMap<String, MenuItem<tauri::Wry>>);

pub fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let mut custom = HashMap::new();
    let menu = Menu::new(app)?;
    for def in model().menus {
        let mut submenu = SubmenuBuilder::with_id(app, def.id.as_str(), def.label.as_str());
        for item in &def.items {
            submenu = match item {
                ItemDef::Separator => submenu.separator(),
                ItemDef::Role { role } => submenu.item(&predefined(app, *role)?),
                ItemDef::Action { id, label } | ItemDef::Command { id, label } => {
                    let entry = MenuItem::with_id(app, id.as_str(), label, true, None::<&str>)?;
                    custom.insert(id.clone(), entry.clone());
                    submenu.item(&entry)
                }
            };
        }
        let submenu: Submenu<tauri::Wry> = submenu.build()?;
        menu.append(&submenu)?;
    }
    app.manage(MenuItems(custom));
    Ok(menu)
}

fn predefined(app: &tauri::AppHandle, role: Role) -> tauri::Result<PredefinedMenuItem<tauri::Wry>> {
    match role {
        Role::Services => PredefinedMenuItem::services(app, None),
        Role::Hide => PredefinedMenuItem::hide(app, None),
        Role::HideOthers => PredefinedMenuItem::hide_others(app, None),
        Role::ShowAll => PredefinedMenuItem::show_all(app, None),
        Role::Quit => PredefinedMenuItem::quit(app, None),
        Role::Cut => PredefinedMenuItem::cut(app, None),
        Role::Copy => PredefinedMenuItem::copy(app, None),
        Role::Paste => PredefinedMenuItem::paste(app, None),
        Role::SelectAll => PredefinedMenuItem::select_all(app, None),
        Role::Fullscreen => PredefinedMenuItem::fullscreen(app, None),
        Role::Minimize => PredefinedMenuItem::minimize(app, None),
        Role::Zoom => PredefinedMenuItem::maximize(app, None),
        Role::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, None),
    }
}

/// Whether a menu event id is one of ours (rather than a predefined item's).
pub fn is_custom(app: &tauri::AppHandle, id: &str) -> bool {
    app.try_state::<MenuItems>()
        .is_some_and(|items| items.0.contains_key(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn the_menu_model_parses_and_every_custom_id_is_unique() {
        let model = model();
        assert!(!model.menus.is_empty());
        let mut seen = HashSet::new();
        for menu in &model.menus {
            assert!(!menu.items.is_empty(), "{} is empty", menu.id);
            for item in &menu.items {
                if let ItemDef::Action { id, .. } | ItemDef::Command { id, .. } = item {
                    assert!(seen.insert(id.clone()), "{id} appears twice");
                }
            }
        }
        assert!(
            seen.contains("tabs.close"),
            "Cmd+W must stay a Close Tab item"
        );
    }

    /// The renderer looks a menu item up by the same id it runs; a separator
    /// at either end, or two in a row, renders as a stray line.
    #[test]
    fn separators_only_ever_sit_between_items() {
        for menu in model().menus {
            let seps: Vec<bool> = menu
                .items
                .iter()
                .map(|i| matches!(i, ItemDef::Separator))
                .collect();
            assert!(
                !seps.first().copied().unwrap_or(false),
                "{} starts with a separator",
                menu.id
            );
            assert!(
                !seps.last().copied().unwrap_or(false),
                "{} ends with a separator",
                menu.id
            );
            assert!(
                !seps.windows(2).any(|w| w[0] && w[1]),
                "{} has two separators in a row",
                menu.id
            );
        }
    }
}
