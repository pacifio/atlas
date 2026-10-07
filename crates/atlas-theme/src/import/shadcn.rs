//! shadcn / tweakcn → Atlas.
//!
//! The native case. Decision 9 kept shadcn's base-token names verbatim, so this
//! importer is mostly a rename-free copy: `--background` is `background`,
//! `--sidebar-ring` is `sidebar-ring`, and a tweakcn export lands in Atlas with
//! nothing lost that Atlas has a place for.
//!
//! Two source shapes, one mapping:
//!
//!  - a **registry item** (`{type: "registry:style", cssVars: {theme, light,
//!    dark}}`), which is what tweakcn's "Import/Export" button emits and what a
//!    URL on a shadcn site serves;
//!  - a paste of **`globals.css`**, which is what someone who has already wired
//!    the theme into a project has to hand.
//!
//! What it cannot carry, and the report says so: shadcn describes an
//! *application chrome* and stops there. There is no editor, no terminal, no
//! syntax highlighting and no diff in the vocabulary, so every Atlas theme key
//! ([`crate::theme_keys`]) resolves from the base tokens or from Atlas's
//! defaults. A shadcn import
//! recolours the app and leaves the code surfaces looking like Atlas.
//!
//! Decision 20 governs the one token that arrives and is then ignored:
//! tweakcn's `spacing`. Atlas owns spacing and the type scale, so the value is
//! *kept in the file* — dropping it would silently lose the author's intent on
//! a later round trip — and a warning says it has no effect.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::color;
use crate::import::draft::VariantDraft;
use crate::import::report::{Fidelity, ImportReport};
use crate::import::{css, finish_theme, ImportOptions, ImportedTheme};
use crate::{ThemeError, BASE_TOKENS};

/// tweakcn emits the ingredients of its shadow ramp alongside the ramp itself.
/// Atlas takes the composed `shadow-*` values; the parts have nowhere to go.
const SHADOW_RECIPE: &[&str] = &[
    "shadow-color",
    "shadow-opacity",
    "shadow-blur",
    "shadow-spread",
    "shadow-offset-x",
    "shadow-offset-y",
];

/// The browser-default root font size a shadcn theme's `rem` values assume.
const CSS_DEFAULT_ROOT_PX: f64 = 16.0;

/// A `rem` or `em` radius as the px it meant in its source.
///
/// Atlas's root font size is 13px, not the browser's 16px, so tweakcn's
/// `0.35rem` would land as 4.55px instead of the 5.6px its author saw — and the
/// derived `calc(var(--radius) - 4px)` steps collapse to nearly square. Any
/// other unit, or anything that is not a plain number, is left as written.
fn radius_in_px(value: &str) -> Option<String> {
    let value = value.trim();
    let number = value
        .strip_suffix("rem")
        .or_else(|| value.strip_suffix("em"))?;
    let number: f64 = number
        .trim()
        .parse()
        .ok()
        .filter(|n: &f64| n.is_finite() && *n >= 0.0)?;
    let px = (number * CSS_DEFAULT_ROOT_PX * 1000.0).round() / 1000.0;
    Some(format!("{px}px"))
}

/// A shadcn registry item (`{type, cssVars, css?}`).
pub(crate) fn from_registry_item(
    value: &Value,
    options: &ImportOptions,
) -> Result<Vec<ImportedTheme>, ThemeError> {
    let vars = value.get("cssVars");
    let pick = |name: &str| -> BTreeMap<String, String> {
        vars.and_then(|vars| vars.get(name))
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| {
                            (key.trim_start_matches("--").to_string(), value.to_string())
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let (theme, light, dark) = (pick("theme"), pick("light"), pick("dark"));
    if theme.is_empty() && light.is_empty() && dark.is_empty() {
        return Err(crate::validation(
            &options.origin,
            "no cssVars found; a shadcn registry item needs cssVars.light, cssVars.dark or cssVars.theme",
        ));
    }
    let source_name = value
        .get("title")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("shadcn theme")
        .to_string();

    let mut report = ImportReport::new("shadcn", source_name.clone(), Fidelity::Native);
    if let Some(kind) = value.get("type").and_then(Value::as_str) {
        if kind != "registry:style" && kind != "registry:theme" {
            report.warn(format!(
                "registry item type is \"{kind}\"; only registry:style and registry:theme carry a theme"
            ));
        }
    }
    if value.get("css").is_some() {
        report.ignore(
            "css",
            "raw css",
            "a registry item's raw CSS block is not a theme value",
        );
    }
    build(&theme, &light, &dark, report, options)
}

/// A pasted `globals.css`.
pub(crate) fn from_css(
    source: &str,
    options: &ImportOptions,
) -> Result<Vec<ImportedTheme>, ThemeError> {
    let sheet = css::parse(source);
    if sheet.is_empty() {
        return Err(crate::validation(
            &options.origin,
            "no CSS custom properties found in :root, .dark or @theme",
        ));
    }
    let source_name = options
        .name_hint
        .clone()
        .unwrap_or_else(|| "Pasted CSS".to_string());
    let mut report = ImportReport::new("shadcn-css", source_name, Fidelity::Native);

    // `:root` is shadcn's LIGHT variant by convention — but only when a `.dark`
    // block exists to be the other half. A dark-only paste has its colours in
    // `:root` and labelling that "light" would file a black theme under the
    // appearance the user never sees.
    let root_is_light = if sheet.dark.is_empty() {
        let dark_root = sheet
            .root
            .get("background")
            .and_then(|value| color::is_dark(value));
        match dark_root {
            Some(true) => {
                report.note(":root has a dark background and there is no .dark block, so it was imported as the dark variant");
                false
            }
            _ => true,
        }
    } else {
        true
    };
    let (light, dark) = if root_is_light {
        (sheet.root.clone(), sheet.dark.clone())
    } else {
        (BTreeMap::new(), sheet.root.clone())
    };
    for selector in &sheet.other_selectors {
        report.ignore(
            selector.clone(),
            "css rule",
            "not a :root, .dark or @theme block",
        );
    }
    build(&sheet.theme, &light, &dark, report, options)
}

/// The shared half: two variants' worth of `name → value`, plus the
/// appearance-independent `@theme` / `cssVars.theme` block behind them.
fn build(
    theme_vars: &BTreeMap<String, String>,
    light: &BTreeMap<String, String>,
    dark: &BTreeMap<String, String>,
    mut report: ImportReport,
    options: &ImportOptions,
) -> Result<Vec<ImportedTheme>, ThemeError> {
    let mut drafts = Vec::new();
    let mut converted_radii = std::collections::BTreeSet::new();
    for (appearance, vars) in [("dark", dark), ("light", light)] {
        if vars.is_empty() {
            continue;
        }
        let mut draft = VariantDraft::new(appearance);
        for token in BASE_TOKENS {
            let found = vars
                .get(*token)
                .map(|value| (format!("--{token} ({appearance})"), value))
                .or_else(|| {
                    theme_vars
                        .get(*token)
                        .map(|value| (format!("--{token} (@theme)"), value))
                });
            let Some((source, value)) = found else {
                continue;
            };
            if *token == "radius" {
                if let Some(px) = radius_in_px(value) {
                    if draft.map_base(token, &source, &px) {
                        converted_radii.insert((value.trim().to_string(), px));
                    }
                    continue;
                }
            }
            draft.map_base(token, &source, value);
        }
        // tweakcn writes the tracking token under Tailwind's own name.
        if draft.base_value("tracking-normal").is_none() {
            if let Some(value) = vars
                .get("letter-spacing")
                .or_else(|| theme_vars.get("letter-spacing"))
            {
                draft.map_base("tracking-normal", "--letter-spacing", value);
            }
        }
        draft.fill_palette();
        draft.fill_required_base();
        drafts.push(draft);
    }
    if drafts.is_empty() {
        return Err(crate::validation(&options.origin, "no usable colors found"));
    }

    // Everything the source said that did not land anywhere.
    let mut reported = std::collections::BTreeSet::new();
    for (where_, vars) in [("@theme", theme_vars), ("light", light), ("dark", dark)] {
        for (name, value) in vars {
            if BASE_TOKENS.contains(&name.as_str()) || name == "letter-spacing" {
                continue;
            }
            if css::is_alias(value) {
                continue; // `--color-x: var(--x)` is a re-export, not a value.
            }
            if !reported.insert(name.clone()) {
                continue;
            }
            if SHADOW_RECIPE.contains(&name.as_str()) {
                report.ignore(
                    format!("--{name}"),
                    "shadow recipe",
                    "Atlas takes the composed shadow-2xs…shadow-2xl ramp, not the parts it was built from",
                );
            } else {
                report.ignore(
                    format!("--{name} ({where_})"),
                    "unmapped shadcn token",
                    "no Atlas base token or theme key carries this",
                );
            }
        }
    }

    for (original, px) in &converted_radii {
        report.note(format!(
            "`radius` {original} was converted to {px}: the source assumes a {CSS_DEFAULT_ROOT_PX}px root, and Atlas's smaller root would have shrunk the whole radius scale"
        ));
    }

    if drafts
        .iter()
        .any(|draft| draft.base_value("spacing").is_some())
    {
        // Decision 20: kept in the file, honoured by nothing.
        report.warn(
            "`spacing` was kept in the theme file but Atlas ignores it — spacing and the type scale are app-owned (decision 20)",
        );
    }
    report.note(
        "shadcn themes describe application chrome only: Atlas's editor, terminal, syntax and diff keys fall back to the built-in defaults for the appearance",
    );

    finish_theme(drafts, report, options).map(|theme| vec![theme])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rem_or_em_radius_becomes_the_px_its_source_meant() {
        assert_eq!(radius_in_px("0.35rem").as_deref(), Some("5.6px"));
        assert_eq!(radius_in_px(" 0.625rem ").as_deref(), Some("10px"));
        assert_eq!(radius_in_px("0.5em").as_deref(), Some("8px"));
        assert_eq!(radius_in_px("0rem").as_deref(), Some("0px"));
        for kept in [
            "8px",
            "0",
            "calc(1rem - 2px)",
            "remrem",
            "-1rem",
            "1.2.3rem",
        ] {
            assert_eq!(
                radius_in_px(kept),
                None,
                "{kept:?} should be left as written"
            );
        }
    }
}
