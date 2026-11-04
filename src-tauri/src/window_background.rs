//! The native window background, from the persisted theme.
//!
//! The window is opaque and is shown before the webview has painted anything,
//! so whatever colour it carries IS the launch flash. Hardcoding black meant
//! every non-black theme — and every light variant — opened on a black frame
//! and then jumped. Rust already parses themes (`atlas-theme`), and the chosen
//! theme is in `config.toml` before the webview starts loading, so the right
//! colour is available at exactly the moment it is needed.
//!
//! The web half of the same flash lives in `index.html`, which replays the last
//! run's colours out of `localStorage`. Two mechanisms because they run at
//! different times: this one is before the webview exists, that one is before
//! the first stylesheet.
//!
//! Only the `background` BASE TOKEN is read. A theme may leave it out
//! (ADR-0022), so it goes through `atlas_theme::derive`, the Rust half of the
//! one derivation engine — the same answer `resolveBase` gives the webview.

use crate::state::atlas_config::ThemeMode;
use atlas_theme::Theme;
use tauri::window::Color;

/// What Atlas has always opened on, and what a theme that cannot be read or
/// whose background is not a colour still opens on.
pub const FALLBACK: Color = Color(0, 0, 0, 255);

/// The window background for the theme `mode` selects: `light_id` while Atlas
/// is light, `dark_id` while it is dark.
///
/// `system_is_light` is the OS appearance, used only when the mode is
/// `System` — the same question `appearanceForMode` answers in TypeScript.
pub fn window_background(
    light_id: &str,
    dark_id: &str,
    mode: ThemeMode,
    system_is_light: bool,
) -> Color {
    let wants_light = wants_light(mode, system_is_light);
    let Ok(theme) = atlas_theme::get_theme(if wants_light { light_id } else { dark_id }) else {
        return FALLBACK;
    };
    background_of(&theme, wants_light).unwrap_or(FALLBACK)
}

fn wants_light(mode: ThemeMode, system_is_light: bool) -> bool {
    match mode {
        ThemeMode::Light => true,
        ThemeMode::Dark => false,
        ThemeMode::System => system_is_light,
    }
}

fn background_of(theme: &Theme, wants_light: bool) -> Option<Color> {
    // Same fallback order as `chooseVariant` in `@tryatlas/design`'s
    // `src/theme/resolve-theme.ts`: the requested variant, then whichever
    // one the theme does have.
    let (variant, dark) = match (wants_light, &theme.light, &theme.dark) {
        (true, Some(light), _) => (light, false),
        (false, _, Some(dark)) => (dark, true),
        (_, Some(light), None) => (light, false),
        (_, None, Some(dark)) => (dark, true),
        (_, None, None) => return None,
    };
    let base = atlas_theme::derive::resolve_base(&variant.base, &variant.palette, dark);
    let color = atlas_theme::color::parse(base.get("background")?)?;
    // A translucent background would make the window see-through, which is the
    // compositor cost the opaque window exists to avoid: alpha is dropped.
    let channel = |value: f64| value.round().clamp(0.0, 255.0) as u8;
    Some(Color(
        channel(color.r),
        channel(color.g),
        channel(color.b),
        255,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_theme::ThemeVariant;

    /// A variant carrying only the one base token this module reads.
    fn variant(background: &str) -> ThemeVariant {
        ThemeVariant {
            base: [("background".to_string(), background.to_string())]
                .into_iter()
                .collect(),
            palette: Default::default(),
            keys: Default::default(),
        }
    }

    fn theme(dark: Option<&str>, light: Option<&str>) -> Theme {
        Theme {
            schema: 1,
            id: "test".into(),
            name: "Test".into(),
            author: "Atlas".into(),
            license: "MIT".into(),
            base: Default::default(),
            dark: dark.map(variant),
            light: light.map(variant),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn mode_picks_the_variant() {
        let t = theme(Some("#191724"), Some("#faf4ed"));
        assert_eq!(
            background_of(&t, wants_light(ThemeMode::Dark, true)),
            Some(Color(0x19, 0x17, 0x24, 255))
        );
        assert_eq!(
            background_of(&t, wants_light(ThemeMode::Light, false)),
            Some(Color(0xfa, 0xf4, 0xed, 255))
        );
    }

    #[test]
    fn system_mode_follows_the_os() {
        let t = theme(Some("#191724"), Some("#faf4ed"));
        assert_eq!(
            background_of(&t, wants_light(ThemeMode::System, true)),
            Some(Color(0xfa, 0xf4, 0xed, 255))
        );
        assert_eq!(
            background_of(&t, wants_light(ThemeMode::System, false)),
            Some(Color(0x19, 0x17, 0x24, 255))
        );
    }

    #[test]
    fn a_missing_variant_falls_back_to_the_other() {
        let t = theme(Some("#0a0a0a"), None);
        assert_eq!(background_of(&t, true), Some(Color(0x0a, 0x0a, 0x0a, 255)));
    }

    #[test]
    fn any_colour_notation_and_alpha_is_dropped() {
        let read = |value: &str| background_of(&theme(Some(value), None), false);
        assert_eq!(read("#abc"), Some(Color(0xaa, 0xbb, 0xcc, 255)));
        assert_eq!(read("#10203080"), Some(Color(0x10, 0x20, 0x30, 255)));
        assert_eq!(read("oklch(1 0 0)"), Some(Color(255, 255, 255, 255)));
        assert_eq!(read("var(--nope)"), None);
    }

    #[test]
    fn a_theme_without_a_background_gets_the_appearance_default() {
        let mut t = theme(None, Some("#faf4ed"));
        t.light.as_mut().unwrap().base.clear();
        assert_eq!(background_of(&t, true), Some(Color(255, 255, 255, 255)));
    }

    /// The whole point of the feature: no shipped theme may fall back to black.
    #[test]
    fn every_built_in_theme_yields_a_colour() {
        for theme in atlas_theme::built_in_themes().expect("built-ins load") {
            for wants_light in [false, true] {
                assert!(
                    background_of(&theme, wants_light).is_some(),
                    "{} has no launch background (light: {wants_light})",
                    theme.id
                );
            }
        }
    }
}
