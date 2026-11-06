//! Base-token derivation: the Rust half of ADR-0022's one engine.
//!
//! The rules are `[[base]]` in `keys.toml`, generated into `base-rules.txt`
//! (read here) and into the TS registry (read by `resolveBase` in
//! `@tryatlas/design`'s `src/theme/resolve-theme.ts`). This file is the
//! interpreter, and it must agree with that function to the last digit:
//! `tests/base_derivation.rs` and the package's `resolve-theme.test.ts` both
//! check the same golden fixture.
//!
//! Rust runs it where a theme leaves Rust: import, which pins what it derives,
//! and export, which writes the whole shadcn set. Everything else receives the
//! variant as written and derives in TypeScript.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::color;

const RULES: &str = include_str!("../base-rules.txt");

/// The closed operation vocabulary of `keys.toml`.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Alpha(f64),
    Lighten(f64),
    TowardBackground(f64),
    TowardForeground(f64),
    Readable,
}

#[derive(Debug)]
struct Rule {
    token: &'static str,
    palette: Option<&'static str>,
    base: Option<&'static str>,
    op: Option<Op>,
    dark: Option<&'static str>,
    light: Option<&'static str>,
}

fn rules() -> &'static [Rule] {
    static PARSED: OnceLock<Vec<Rule>> = OnceLock::new();
    PARSED.get_or_init(|| {
        RULES
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| {
                let fields: Vec<&'static str> = line.split('\t').collect();
                assert_eq!(fields.len(), 7, "base-rules.txt: malformed line {line:?}");
                let field = |at: usize| Some(fields[at]).filter(|value| *value != "-");
                let amount = || {
                    field(4)
                        .and_then(|value| value.parse::<f64>().ok())
                        .unwrap_or_else(|| panic!("base-rules.txt: {} needs an amount", fields[0]))
                };
                let op = field(3).map(|op| match op {
                    "alpha" => Op::Alpha(amount()),
                    "lighten" => Op::Lighten(amount()),
                    "toward_background" => Op::TowardBackground(amount()),
                    "toward_foreground" => Op::TowardForeground(amount()),
                    "readable" => Op::Readable,
                    other => panic!("base-rules.txt: unknown op {other}"),
                });
                Rule {
                    token: fields[0],
                    palette: field(1),
                    base: field(2),
                    op,
                    dark: field(5),
                    light: field(6),
                }
            })
            .collect()
    })
}

fn apply(op: Op, value: &str, base: &BTreeMap<String, String>) -> String {
    let token = |name: &str, fallback: &'static str| {
        base.get(name).map_or(fallback.to_string(), Clone::clone)
    };
    match op {
        Op::Alpha(amount) => color::with_alpha(value, amount),
        Op::Lighten(amount) => color::mix(value, "#ffffff", amount),
        Op::TowardBackground(amount) => color::mix(value, &token("background", "#000000"), amount),
        Op::TowardForeground(amount) => color::mix(value, &token("foreground", "#ffffff"), amount),
        // Until `foreground` exists — only while deriving it — the choice is
        // white or black, since `background` cannot be read on itself.
        Op::Readable => match base.get("foreground") {
            None => color::readable(value, "#ffffff", "#000000").to_string(),
            Some(foreground) => {
                color::readable(value, foreground, &token("background", "#000000")).to_string()
            }
        },
    }
}

/// One derived token: its value, and where it came from in words, for an
/// import report.
#[derive(Debug, Clone, PartialEq)]
pub struct Derived {
    pub token: &'static str,
    pub value: String,
    pub from: String,
}

/// Every base token `written` leaves out, in rule order, derived from the
/// ones it has. A written value is never touched; empty counts as absent, as
/// it does in TypeScript.
pub fn derive_missing(
    written: &BTreeMap<String, String>,
    palette: &BTreeMap<String, String>,
    dark: bool,
) -> Vec<Derived> {
    let mut base = written.clone();
    base.retain(|_, value| !value.is_empty());
    let mut out = Vec::new();
    for rule in rules() {
        if base.contains_key(rule.token) {
            continue;
        }
        let from_palette = rule
            .palette
            .and_then(|hue| palette.get(hue).filter(|value| !value.is_empty()))
            .map(|value| {
                (
                    format!("palette.{}", rule.palette.unwrap_or_default()),
                    value.clone(),
                )
            });
        let from_base = || {
            rule.base
                .and_then(|token| base.get(token))
                .map(|value| (rule.base.unwrap_or_default().to_string(), value.clone()))
        };
        let from_default = || {
            let value = if dark {
                rule.dark
            } else {
                rule.light.or(rule.dark)
            };
            value.map(|value| ("atlas default".to_string(), value.to_string()))
        };
        let Some((source, value)) = from_palette.or_else(from_base).or_else(from_default) else {
            continue;
        };
        let (value, from) = match rule.op {
            Some(op) => (
                apply(op, &value, &base),
                format!("{source}, {}", describe(op)),
            ),
            None => (value, source),
        };
        base.insert(rule.token.to_string(), value.clone());
        out.push(Derived {
            token: rule.token,
            value,
            from,
        });
    }
    out
}

/// `written` with every missing base token filled in.
pub fn resolve_base(
    written: &BTreeMap<String, String>,
    palette: &BTreeMap<String, String>,
    dark: bool,
) -> BTreeMap<String, String> {
    let mut base = written.clone();
    for derived in derive_missing(written, palette, dark) {
        base.insert(derived.token.to_string(), derived.value);
    }
    base
}

fn describe(op: Op) -> String {
    match op {
        Op::Alpha(amount) => format!("alpha {amount}"),
        Op::Lighten(amount) => format!("lightened {amount}"),
        Op::TowardBackground(amount) => format!("mixed {amount} toward background"),
        Op::TowardForeground(amount) => format!("mixed {amount} toward foreground"),
        Op::Readable => "readable on it".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn covers_every_base_token_in_order() {
        let tokens: Vec<&str> = rules().iter().map(|rule| rule.token).collect();
        assert_eq!(tokens, crate::BASE_TOKENS);
    }

    #[test]
    fn two_seeds_make_a_whole_set() {
        let base = resolve_base(
            &map(&[("background", "#101418"), ("primary", "#7aa2f7")]),
            &BTreeMap::new(),
            true,
        );
        for token in crate::BASE_TOKENS {
            assert!(base.contains_key(*token), "{token} was not derived");
        }
        assert_eq!(base["ring"], "#7aa2f7");
        assert_eq!(base["foreground"], "#ffffff");
        // A pale primary on a dark theme takes the dark background as its ink.
        assert_eq!(base["primary-foreground"], "#101418");
    }

    #[test]
    fn a_written_value_wins_and_the_palette_comes_before_a_default() {
        let derived = derive_missing(
            &map(&[("card", "#222222")]),
            &map(&[("green", "#00ff00")]),
            true,
        );
        assert!(derived.iter().all(|entry| entry.token != "card"));
        let chart = derived
            .iter()
            .find(|entry| entry.token == "chart-2")
            .unwrap();
        assert_eq!(
            (chart.value.as_str(), chart.from.as_str()),
            ("#00ff00", "palette.green")
        );
        let border = derived
            .iter()
            .find(|entry| entry.token == "border")
            .unwrap();
        assert_eq!(border.from, "background, mixed 0.16 toward foreground");
    }
}
