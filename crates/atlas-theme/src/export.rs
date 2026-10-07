//! Atlas theme → shadcn registry item.
//!
//! The other direction of [`crate::import::shadcn`], and the reason a theme
//! authored in Atlas is not trapped there: the output is an ordinary
//! `registry:style` item, so it drops into a shadcn project's `registry.json`
//! or a tweakcn paste box unchanged.
//!
//! It is lossy in exactly the way the shadcn importer is lossy in reverse. The
//! base tokens *are* shadcn's, so they cross verbatim, appearance by
//! appearance. Everything above them — the eight-colour palette and every
//! theme key covering the editor, terminal, syntax, diffs and agent
//! chips — describes surfaces shadcn has no vocabulary for and is dropped. The
//! result carries the app's chrome and none of its code surfaces, which is the
//! right trade for pasting an Atlas theme onto a marketing site and the wrong
//! one for moving a theme between two Atlas installs (copy the TOML for that).
//!
//! The report says so in the same shape an import does, so the UI renders both
//! with one component.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::{Theme, ThemeVariant, NON_COLOR_BASE_TOKENS};

/// The `@theme`-level tokens: appearance-independent, so shadcn puts them in
/// `cssVars.theme` rather than repeating them under light and dark.
const THEME_LEVEL: &[&str] = &[
    "radius",
    "font-sans",
    "font-serif",
    "font-mono",
    "tracking-normal",
    "spacing",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// Base tokens written, counted across every variant.
    pub exported: usize,
    /// Palette entries and theme keys with no shadcn home.
    pub dropped: usize,
    pub dropped_by_category: BTreeMap<String, usize>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShadcnExport {
    pub id: String,
    pub name: String,
    /// The registry item, pretty-printed and ready to copy.
    pub json: String,
    pub variants: Vec<String>,
    pub report: ExportReport,
}

pub fn to_shadcn_registry_item(theme: &Theme) -> ShadcnExport {
    let mut css_vars = Map::new();
    let mut theme_level = Map::new();
    let mut exported = 0usize;
    let mut dropped_by_category: BTreeMap<String, usize> = BTreeMap::new();
    let mut variants = Vec::new();

    for (appearance, variant) in [
        ("light", theme.light.as_ref()),
        ("dark", theme.dark.as_ref()),
    ] {
        let Some(variant) = variant else { continue };
        variants.push(appearance.to_string());
        let mut block = Map::new();
        for (token, value) in &variant.base {
            if THEME_LEVEL.contains(&token.as_str()) {
                // Appearance-independent: written once, from whichever variant
                // states it first. A theme whose variants disagree about the
                // radius loses that disagreement, which shadcn cannot express.
                theme_level
                    .entry(token.clone())
                    .or_insert_with(|| Value::String(value.clone()));
            } else {
                block.insert(token.clone(), Value::String(value.clone()));
            }
            exported += 1;
        }
        css_vars.insert(appearance.to_string(), Value::Object(block));
        count_dropped(variant, &mut dropped_by_category);
    }
    if !theme_level.is_empty() {
        css_vars.insert("theme".to_string(), Value::Object(theme_level));
    }

    let item = json!({
        "$schema": "https://ui.shadcn.com/schema/registry-item.json",
        "name": theme.id,
        "type": "registry:style",
        "title": theme.name,
        "author": theme.author,
        "cssVars": Value::Object(css_vars),
    });

    let dropped = dropped_by_category.values().sum();
    let mut notes = vec![
        "Base tokens cross verbatim: shadcn's names are Atlas's names, so the chrome is exact."
            .to_string(),
    ];
    if dropped > 0 {
        notes.push(format!(
            "{dropped} Atlas values have no shadcn equivalent and were dropped — the editor, terminal, syntax, diff and agent colors. To move this theme to another Atlas install, copy the TOML instead."
        ));
    }
    if theme.light.is_none() || theme.dark.is_none() {
        notes.push("Only one variant exists, so the registry item has one appearance; shadcn consumers usually expect both.".to_string());
    }

    ShadcnExport {
        id: theme.id.clone(),
        name: theme.name.clone(),
        json: serde_json::to_string_pretty(&item).unwrap_or_default() + "\n",
        variants,
        report: ExportReport {
            exported,
            dropped,
            dropped_by_category,
            notes,
        },
    }
}

fn count_dropped(variant: &ThemeVariant, out: &mut BTreeMap<String, usize>) {
    if !variant.palette.is_empty() {
        *out.entry("palette".to_string()).or_default() += variant.palette.len();
    }
    for key in variant.keys.keys() {
        let family = key.split('.').next().unwrap_or("other").to_string();
        *out.entry(family).or_default() += 1;
    }
    debug_assert!(
        variant
            .base
            .keys()
            .all(|token| !NON_COLOR_BASE_TOKENS.contains(&token.as_str())
                || THEME_LEVEL.contains(&token.as_str())
                || token.starts_with("shadow-")),
        "a non-colour base token is neither theme-level nor a shadow",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::built_in_themes;

    #[test]
    fn every_base_token_survives_the_export() {
        let theme = built_in_themes()
            .unwrap()
            .into_iter()
            .find(|t| t.id == "rose-pine")
            .unwrap();
        let export = to_shadcn_registry_item(&theme);
        let item: Value = serde_json::from_str(&export.json).unwrap();
        let dark = theme.dark.as_ref().unwrap();
        for (token, value) in &dark.base {
            let found = item["cssVars"]["dark"]
                .get(token)
                .or_else(|| item["cssVars"]["theme"].get(token));
            assert_eq!(
                found.and_then(Value::as_str),
                Some(value.as_str()),
                "{token}"
            );
        }
        assert_eq!(export.variants, ["light", "dark"]);
        assert!(
            export.report.dropped > 0,
            "the theme keys must be reported as dropped"
        );
    }
}
