//! The half of an import that is the same whatever the source was.
//!
//! All three importers do the same three things in the same order: put whatever
//! the source said into the right Atlas slot, guess an eight-colour palette
//! from whatever ended up in `terminal.ansi.*` / `syntax.*`, and fill the shadcn
//! base tokens the source did not have. Only the first step is format-specific,
//! so the other two live here and every importer gets the same derivation —
//! the `[[base]]` rules every theme resolves through — and the same report
//! entries for it.
//!
//! **Why the palette matters more than it looks.** It is optional in the file
//! format, but a wide swath of the theme keys resolve through it — every
//! status colour, every ANSI colour, every diff tint; see the Source column
//! in `docs/reference/theme-keys.md` for the current set. An import that skips
//! the palette produces a theme
//! whose editor is the author's and whose chrome is Atlas's, which looks like a
//! half-finished port. Guessing it from the ANSI ramp costs nothing and is
//! right far more often than it is wrong.

use std::collections::BTreeMap;

use crate::derive;
use crate::import::report::{DerivedKey, MappedKey};
use crate::{is_css_color, ThemeKeyValue, ThemeVariant, PALETTE_KEYS};

/// A variant under construction, plus the audit trail of how it got that way.
pub(crate) struct VariantDraft {
    pub appearance: &'static str,
    base: BTreeMap<String, String>,
    palette: BTreeMap<String, String>,
    keys: BTreeMap<String, ThemeKeyValue>,
    pub mapped: Vec<MappedKey>,
    pub derived: Vec<DerivedKey>,
}

impl VariantDraft {
    pub fn new(appearance: &'static str) -> Self {
        Self {
            appearance,
            base: BTreeMap::new(),
            palette: BTreeMap::new(),
            keys: BTreeMap::new(),
            mapped: Vec::new(),
            derived: Vec::new(),
        }
    }

    pub fn is_dark(&self) -> bool {
        self.appearance == "dark"
    }

    pub fn base_value(&self, token: &str) -> Option<&str> {
        self.base.get(token).map(String::as_str)
    }

    pub fn key_color(&self, key: &str) -> Option<&str> {
        self.keys.get(key).map(ThemeKeyValue::color)
    }

    /// First writer wins, so an importer can list its preferred source first
    /// and fall through to weaker ones without re-checking.
    pub fn map_base(&mut self, token: &str, source: &str, value: &str) -> bool {
        if self.base.contains_key(token) || !is_css_value(token, value) {
            return false;
        }
        self.base.insert(token.to_string(), value.to_string());
        self.mapped.push(MappedKey {
            target: format!("{}.base.{token}", self.appearance),
            source: source.to_string(),
            value: value.to_string(),
        });
        true
    }

    pub fn map_key(&mut self, key: &str, source: &str, value: ThemeKeyValue) -> bool {
        if self.keys.contains_key(key) || !is_css_color(value.color()) {
            return false;
        }
        let rendered = value.color().to_string();
        self.keys.insert(key.to_string(), value);
        self.mapped.push(MappedKey {
            target: format!("{}.keys.{key}", self.appearance),
            source: source.to_string(),
            value: rendered,
        });
        true
    }

    pub fn map_color_key(&mut self, key: &str, source: &str, value: &str) -> bool {
        self.map_key(key, source, ThemeKeyValue::Color(value.to_string()))
    }

    fn derive_base(&mut self, token: &str, from: &str, value: &str) {
        if self.base.contains_key(token) {
            return;
        }
        self.base.insert(token.to_string(), value.to_string());
        self.derived.push(DerivedKey {
            target: format!("{}.base.{token}", self.appearance),
            from: from.to_string(),
            value: value.to_string(),
        });
    }

    fn derive_palette(&mut self, name: &str, from: &str, value: &str) {
        if self.palette.contains_key(name) || !is_css_color(value) {
            return;
        }
        self.palette.insert(name.to_string(), value.to_string());
        self.derived.push(DerivedKey {
            target: format!("{}.palette.{name}", self.appearance),
            from: from.to_string(),
            value: value.to_string(),
        });
    }

    /// Fill every shadcn base token the source did not provide, by the same
    /// `[[base]]` rules a theme that omits them resolves through at runtime
    /// (`crate::derive`, ADR-0022). An import pins them: the user previewed
    /// this result, so it should not shift when a rule improves later.
    pub fn fill_base(&mut self) {
        let derived = derive::derive_missing(&self.base, &self.palette, self.is_dark());
        for entry in derived {
            self.derive_base(entry.token, &entry.from, &entry.value);
        }
    }

    /// Guess the eight palette colours from what the source already gave us.
    ///
    /// Only ever *adds*: an importer that found a real palette (nothing does
    /// today, but a future format might) keeps it.
    pub fn fill_palette(&mut self) {
        // (palette name, candidate theme keys in order, candidate base tokens)
        const SOURCES: &[(&str, &[&str], &[&str])] = &[
            (
                "red",
                &["terminal.ansi.red", "syntax.tag", "status.error.foreground"],
                &["destructive"],
            ),
            (
                "green",
                &[
                    "terminal.ansi.green",
                    "syntax.string",
                    "status.success.foreground",
                ],
                &[],
            ),
            (
                "yellow",
                &[
                    "terminal.ansi.yellow",
                    "syntax.attribute",
                    "status.warning.foreground",
                ],
                &[],
            ),
            (
                "blue",
                &[
                    "terminal.ansi.blue",
                    "syntax.function",
                    "status.info.foreground",
                ],
                &["primary"],
            ),
            ("cyan", &["terminal.ansi.cyan", "syntax.type"], &[]),
            ("purple", &["terminal.ansi.magenta", "syntax.keyword"], &[]),
            (
                "orange",
                &["syntax.number", "terminal.ansi.bright_red"],
                &[],
            ),
            (
                "pink",
                &[
                    "syntax.escape",
                    "terminal.ansi.bright_magenta",
                    "syntax.regexp",
                ],
                &[],
            ),
        ];
        for (name, keys, tokens) in SOURCES {
            let found = keys
                .iter()
                .find_map(|key| {
                    self.key_color(key)
                        .map(|value| (format!("keys.{key}"), value.to_string()))
                })
                .or_else(|| {
                    tokens.iter().find_map(|token| {
                        self.base_value(token)
                            .map(|value| (format!("base.{token}"), value.to_string()))
                    })
                });
            if let Some((from, value)) = found {
                self.derive_palette(name, &from, &value);
            }
        }
        debug_assert!(self
            .palette
            .keys()
            .all(|name| PALETTE_KEYS.contains(&name.as_str())));
    }

    pub fn finish(self) -> (ThemeVariant, Vec<MappedKey>, Vec<DerivedKey>) {
        (
            ThemeVariant {
                base: self.base,
                palette: self.palette,
                keys: self.keys,
            },
            self.mapped,
            self.derived,
        )
    }
}

/// Non-colour base tokens (`radius`, tracking, spacing, the shadow ramp) are free
/// text, so only the colour ones are syntax-checked on the way in.
fn is_css_value(token: &str, value: &str) -> bool {
    if crate::NON_COLOR_BASE_TOKENS.contains(&token) {
        !value.trim().is_empty()
    } else {
        is_css_color(value)
    }
}
