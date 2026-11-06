//! Serialising a [`Theme`] back to the TOML a user can keep and edit.
//!
//! Written by hand rather than through `toml::to_string`, because the file is
//! the artefact an import produces and a human then owns. Three things serde
//! would not give us:
//!
//!  - **Base tokens in the documented order.** `ThemeVariant::base` is a
//!    `BTreeMap`, so serde would alphabetise it — `accent` first, `radius`
//!    somewhere in the middle, the shadow ramp split across the file. The
//!    built-in themes are written in the order `docs/reference/theme-keys.md`
//!    lists, and an imported theme should read like one of them.
//!  - **Quoted dotted keys, always.** `"border.default" = "…"` is one key; an
//!    unquoted `border.default` is a nested table, and a file mixing the two
//!    forms trips the loader's leaf-and-prefix check on a re-read.
//!  - **The `#:schema` line**, which is a comment and therefore invisible to
//!    any serialiser, but is what makes the file validate in an editor.

use std::collections::BTreeMap;

use crate::{Theme, ThemeKeyValue, ThemeVariant, BASE_TOKENS, FONT_TOKENS, PALETTE_KEYS};

/// The published schema URL, written as the first line of every file we emit.
pub const SCHEMA_URL: &str = "https://docs.tryatlas.cc/schema/theme-v1.json";

/// A theme as a schema-1 TOML file, ready to write to `~/.config/atlas/themes`.
///
/// Round-trips: `parse_theme(&theme_to_toml(&t), "…")` returns `t` again, minus
/// warnings (which are derived, not stored).
pub fn theme_to_toml(theme: &Theme) -> String {
    let mut out = String::new();
    out.push_str(&format!("#:schema {SCHEMA_URL}\n"));
    out.push_str(&format!("schema = {}\n", theme.schema));
    out.push_str(&format!("id = {}\n", quote(&theme.id)));
    out.push_str(&format!("name = {}\n", quote(&theme.name)));
    out.push_str(&format!("author = {}\n", quote(&theme.author)));
    out.push_str(&format!("license = {}\n", quote(&theme.license)));
    if !theme.base.is_empty() {
        out.push_str("\n[base]\n");
        write_base(&mut out, &theme.base, &BTreeMap::new());
    }
    for (appearance, variant) in [
        ("dark", theme.dark.as_ref()),
        ("light", theme.light.as_ref()),
    ] {
        if let Some(variant) = variant {
            write_variant(&mut out, appearance, variant, &theme.base);
        }
    }
    out
}

/// `base` in the documented order, then anything the schema gains later, so a
/// token added to BASE_TOKENS without being added here is still written out.
/// Tokens equal to the shared `[base]` are left to it.
fn write_base(
    out: &mut String,
    base: &BTreeMap<String, String>,
    shared: &BTreeMap<String, String>,
) {
    let mut written = Vec::new();
    for token in BASE_TOKENS.iter().chain(FONT_TOKENS) {
        if let Some(value) = base.get(*token) {
            if shared.get(*token) != Some(value) {
                out.push_str(&format!("{} = {}\n", quote(token), quote(value)));
            }
            written.push(*token);
        }
    }
    for (token, value) in base {
        if !written.contains(&token.as_str()) && shared.get(token) != Some(value) {
            out.push_str(&format!("{} = {}\n", quote(token), quote(value)));
        }
    }
}

fn write_variant(
    out: &mut String,
    appearance: &str,
    variant: &ThemeVariant,
    shared: &BTreeMap<String, String>,
) {
    out.push_str(&format!("\n[{appearance}.base]\n"));
    write_base(out, &variant.base, shared);

    if !variant.palette.is_empty() {
        out.push_str(&format!("\n[{appearance}.palette]\n"));
        for name in PALETTE_KEYS {
            if let Some(value) = variant.palette.get(*name) {
                out.push_str(&format!("{name} = {}\n", quote(value)));
            }
        }
    }

    if !variant.keys.is_empty() {
        out.push_str(&format!("\n[{appearance}.keys]\n"));
        for (key, value) in &variant.keys {
            let rendered = match value {
                ThemeKeyValue::Color(color) => quote(color),
                ThemeKeyValue::Styled(style) => format!("{{ color = {} }}", quote(&style.color)),
            };
            out.push_str(&format!("{} = {rendered}\n", quote(key)));
        }
    }
}

/// A TOML basic string. Font stacks carry `"` (`"SF Mono", monospace`) and
/// Windows-ish font names can carry `\`, so both are escaped.
fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{built_in_themes, parse_theme};

    /// Every built-in survives a write and a re-read unchanged. The built-ins
    /// are the widest sample of the schema we have — dotted keys, styled
    /// syntax entries, font stacks with embedded quotes, two variants.
    #[test]
    fn every_built_in_round_trips_through_the_writer() {
        for theme in built_in_themes().unwrap() {
            let written = theme_to_toml(&theme);
            let reparsed = parse_theme(&written, "round-trip")
                .unwrap_or_else(|error| panic!("{} did not re-read: {error}\n{written}", theme.id));
            assert_eq!(reparsed, theme, "{} changed across a round trip", theme.id);
        }
    }

    #[test]
    fn writes_base_tokens_in_the_documented_order() {
        let theme = &built_in_themes().unwrap()[0];
        let written = theme_to_toml(theme);
        let background = written.find("\"background\"").unwrap();
        let radius = written.find("\"radius\"").unwrap();
        let accent = written.find("\"accent\"").unwrap();
        assert!(
            background < accent && accent < radius,
            "alphabetised, not documented order"
        );
    }
}
