//! Atlas's single source of truth for secret redaction.
//!
//! # Why this exists
//!
//! Atlas records agent Sessions to disk. An agent that reads a `.env` file puts
//! its contents verbatim into the transcript, and a shell command that prints a
//! token puts it in the tool result. Redaction therefore runs **before
//! persistence, not before upload** — the local store is never itself a place a
//! secret lives, so every downstream feature (sync, export, share, support
//! bundle) inherits the guarantee instead of needing its own scrubbing pass, and
//! there is exactly one code path that can be forgotten rather than two.
//!
//! # Shape
//!
//! String in, redacted string out, plus a tally of what was replaced. No I/O, no
//! async, no logging of the content it processes, no Tauri runtime — so it is
//! testable as a pure table and cheap enough to sit on the turn-completion path.
//!
//! ```
//! let out = atlas_redact::redact("deploy with API_KEY=supersecretvalue123");
//! assert!(out.text.contains("[REDACTED]"));
//! assert_eq!(out.counts.total(), 1);
//! ```
//!
//! # The layers, and why there are six
//!
//! Each catches a class the others provably miss, and a string is redacted if
//! *any* of them flags it:
//!
//! 1. [`Category::Entropy`] — Shannon entropy over long tokens. The only layer
//!    that catches a key format nobody has written a rule for.
//! 2. [`Category::VendorRule`] — the vendored betterleaks corpus. Provider
//!    formats whose entropy is too low, or whose alphabet too narrow, for (1).
//! 3. [`Category::ProviderToken`] — deterministic prefixes for credentials the
//!    corpus only detects *in company* (composite rules) or not at all.
//! 4. [`Category::CredentialedUri`] — `scheme://user:pass@host`.
//! 5. [`Category::ConnectionString`] — JDBC, keyword DSN, semicolon form.
//! 6. [`Category::CredentialValue`] — `DB_PASSWORD=…`, value only.
//!
//! # Over-redaction is a failure too
//!
//! A transcript reduced to `[REDACTED]` is as useless as one that leaks, and it
//! is the failure nobody reports. Documentation placeholders, `${VAR}`
//! expansions, mask runs and obviously-fake example keys are held out
//! deliberately, and the negative cases in `tests/` are load-bearing rather than
//! decorative. That property is also what makes redaction **idempotent**:
//! running the pass twice produces the same output.

mod credential;
mod dsn;
mod entropy;
mod json;
mod placeholder;
mod provider;
mod region;
mod uri;
mod vendor;
mod vendor_rules;

pub use vendor::{rule_count, uncompilable_rule_ids};

/// What replaces a detected secret. Short, obviously not a value, and — being
/// under ten characters and low entropy — invisible to the layers on a second
/// pass, which is what makes redaction idempotent.
pub const PLACEHOLDER: &str = "[REDACTED]";

/// Which layer flagged a replacement. Ordered so a tie between two layers over
/// the same span resolves the same way every run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Category {
    Entropy,
    VendorRule,
    ProviderToken,
    CredentialedUri,
    ConnectionString,
    CredentialValue,
}

impl Category {
    /// Stable machine-readable name, for persisting a tally.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Entropy => "entropy",
            Self::VendorRule => "vendor_rule",
            Self::ProviderToken => "provider_token",
            Self::CredentialedUri => "credentialed_uri",
            Self::ConnectionString => "connection_string",
            Self::CredentialValue => "credential_value",
        }
    }

    /// Every category, for iterating a tally.
    pub const ALL: [Category; 6] = [
        Self::Entropy,
        Self::VendorRule,
        Self::ProviderToken,
        Self::CredentialedUri,
        Self::ConnectionString,
        Self::CredentialValue,
    ];
}

/// How many replacements each layer contributed.
///
/// This is what drives the user-facing "38 secrets redacted" figure on the
/// promotion and import confirmations — the one number that lets a developer
/// judge a bulk disclosure before making it. It counts *replacements*, so two
/// layers agreeing about one secret count once.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RedactionCounts {
    counts: [u32; 6],
}

impl RedactionCounts {
    pub fn record(&mut self, category: Category) {
        self.counts[category as usize] += 1;
    }

    pub fn merge(&mut self, other: &RedactionCounts) {
        for (slot, add) in self.counts.iter_mut().zip(other.counts.iter()) {
            *slot += add;
        }
    }

    pub fn get(&self, category: Category) -> u32 {
        self.counts[category as usize]
    }

    /// Total replacements across every layer.
    pub fn total(&self) -> u32 {
        self.counts.iter().sum()
    }

    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }

    /// Non-zero categories as `(name, count)`, for persisting or display.
    pub fn entries(&self) -> Vec<(&'static str, u32)> {
        Category::ALL
            .iter()
            .filter(|c| self.get(**c) > 0)
            .map(|c| (c.as_str(), self.get(*c)))
            .collect()
    }
}

/// A scrubbed string and the tally of what was taken out of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub text: String,
    pub counts: RedactionCounts,
}

impl Redacted {
    /// Nothing was found; the input passes through untouched.
    fn clean(text: impl Into<String>) -> Self {
        Self { text: text.into(), counts: RedactionCounts::default() }
    }

    /// Did this pass replace anything?
    pub fn changed(&self) -> bool {
        !self.counts.is_empty()
    }
}

/// Redact a plain string through all six layers.
///
/// Never panics: malformed UTF-8 cannot reach here (`&str` is validated), and a
/// span landing mid-character is dropped rather than sliced.
pub fn redact(input: &str) -> Redacted {
    if input.is_empty() {
        return Redacted::clean(input);
    }

    let mut regions = entropy::detect(input);
    regions.extend(vendor::detect(input));
    regions.extend(provider::detect(input));
    regions.extend(uri::detect(input));
    regions.extend(dsn::detect(input));
    regions.extend(credential::detect(input));

    let (text, replaced) = region::apply(input, regions, PLACEHOLDER);
    let mut counts = RedactionCounts::default();
    for category in replaced {
        counts.record(category);
    }
    Redacted { text, counts }
}

/// Redact only the credential material inside a link value, keeping the link.
///
/// Used by [`redact_json`] for `url`/`uri` fields. Replacing a whole URL
/// destroys the reference the transcript exists to keep, and the entropy layer
/// misreads long path segments and signed-URL parameters as secrets — so
/// neither runs here. What must still not survive is an actual credential:
/// a userinfo password (`postgres://app:hunter2@db/x`), a `password=` query
/// parameter, or a provider token embedded in the URL the way git remotes
/// embed one (`https://ghp_…@github.com/org/repo`).
pub(crate) fn redact_link(input: &str) -> Redacted {
    let mut regions = uri::detect_userinfo_passwords(input);
    regions.extend(dsn::detect_password_values(input));
    regions.extend(provider::detect(input));

    let (text, replaced) = region::apply(input, regions, PLACEHOLDER);
    let mut counts = RedactionCounts::default();
    for category in replaced {
        counts.record(category);
    }
    Redacted { text, counts }
}

/// Redact a payload whose shape is unknown — the right call for tool arguments
/// and tool results, which are JSON-shaped most of the time but not always.
///
/// If the trimmed input parses as a JSON object or array, or is JSONL with one
/// such value per line, it is routed through [`redact_json`], so ids, paths and
/// field names survive, and comes back serialised compactly. Anything else —
/// prose, logs, a fragment that does not parse — goes through the flat
/// [`redact`] pass. The counts are whichever path produced them; nothing is
/// dropped in the dispatch.
pub fn redact_auto(input: &str) -> Redacted {
    let trimmed = input.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if value.is_object() || value.is_array() {
                return redact_json(trimmed);
            }
        }
        // JSONL parses as no single value, so the check above declines it and
        // the flat pass gets a document it was never meant to see. `redact_json`
        // has always walked this shape; only the dispatch could not name it.
        if is_jsonl(trimmed) {
            return redact_json(trimmed);
        }
    }
    redact(input)
}

/// Is this input JSONL: two or more lines, each its own JSON object or array?
///
/// An ndjson tool result, `jq -c` output, a transcript read a line at a time.
/// The shape is JSON but it parses as no single value, so [`redact_auto`]'s
/// whole-input check declined it and the flat pass ran over a document: every
/// id cleared the entropy threshold and was replaced, the tally counted one
/// per line instead of one per secret, and a span that ran past a JSON escape
/// left a line that no longer parses.
///
/// Deliberately strict, in that every non-empty line must parse, so a prose
/// payload that merely opens with a brace still takes the flat path. Lines are
/// split the way [`redact_json`] splits them, and the first line that does not
/// parse ends the scan, so the cost on a non-JSONL payload is one line rather
/// than the whole input.
fn is_jsonl(trimmed: &str) -> bool {
    if !trimmed.contains('\n') {
        return false;
    }
    let mut lines = 0usize;
    for line in trimmed.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) if value.is_object() || value.is_array() => lines += 1,
            _ => return false,
        }
    }
    lines > 1
}

/// Redact bytes, or decline if they are not text.
///
/// Returns `None` for input that is not valid UTF-8. A tool result can be a
/// compiled binary, an image, or a truncated multi-byte read, and the only
/// correct answer for those is *don't touch it*: lossy-decoding to scan would
/// corrupt the payload on the way back out, and there is no such thing as a
/// secret you can find in bytes you cannot read. Callers store the payload
/// verbatim with a binary marker instead.
pub fn redact_bytes(input: &[u8]) -> Option<Redacted> {
    std::str::from_utf8(input).ok().map(redact)
}

/// Redact JSON content, walking the value so structure and field names survive.
///
/// Accepts a single JSON value or JSONL (one value per line) — both shapes occur
/// in agent transcripts. Any line that does not parse falls back to [`redact`],
/// so a truncated or malformed transcript is still scrubbed rather than skipped.
pub fn redact_json(input: &str) -> Redacted {
    if input.trim().is_empty() {
        return Redacted::clean(input);
    }

    let leaf = |value: &str| {
        let out = redact(value);
        (out.text, out.counts)
    };

    // Whole-input parse first: a pretty-printed object spans many lines, and
    // treating it line-by-line would fall back to flat redaction and destroy the
    // very identifiers the walk exists to protect.
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(input) {
        let mut counts = RedactionCounts::default();
        json::redact_value(&mut value, &mut counts, &leaf);
        return match serde_json::to_string(&value) {
            Ok(text) => Redacted { text, counts },
            // Re-serialising a value we just parsed cannot realistically fail,
            // but redaction must never be the thing that loses a turn.
            Err(_) => redact(input),
        };
    }

    let mut out = String::with_capacity(input.len());
    let mut counts = RedactionCounts::default();
    for (index, line) in input.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        if line.trim().is_empty() {
            out.push_str(line);
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(mut value) => {
                let mut line_counts = RedactionCounts::default();
                json::redact_value(&mut value, &mut line_counts, &leaf);
                match serde_json::to_string(&value) {
                    Ok(text) => {
                        out.push_str(&text);
                        counts.merge(&line_counts);
                    }
                    Err(_) => {
                        let fallback = redact(line);
                        out.push_str(&fallback.text);
                        counts.merge(&fallback.counts);
                    }
                }
            }
            Err(_) => {
                let fallback = redact(line);
                out.push_str(&fallback.text);
                counts.merge(&fallback.counts);
            }
        }
    }
    Redacted { text: out, counts }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_string_is_returned_untouched() {
        assert_eq!(redact("").text, "");
        assert_eq!(redact_json("").text, "");
    }

    #[test]
    fn counts_are_reported_per_category() {
        let out = redact("API_KEY=supersecretvalue123 and postgres://a:hunter2@db/x");
        assert_eq!(out.counts.get(Category::CredentialValue), 1);
        assert_eq!(out.counts.get(Category::CredentialedUri), 1);
        assert_eq!(out.counts.total(), 2);
        assert!(out.changed());
    }

    #[test]
    fn category_names_are_stable() {
        assert_eq!(Category::Entropy.as_str(), "entropy");
        assert_eq!(Category::ALL.len(), 6);
    }
}
