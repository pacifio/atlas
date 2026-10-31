//! Layer 2 — the vendored betterleaks rule corpus.
//!
//! Three hundred-odd provider-specific formats that no entropy threshold can be
//! tuned to catch: prefixes short enough to score low, tokens with structure,
//! keys whose alphabet is narrow. The rule *data* is generated into
//! `vendor_rules.rs`; this module is the engine that runs it.
//!
//! Two properties keep it off the hot path. Each rule declares the keywords that
//! must appear in the input for its regex to have any chance of matching, so a
//! cheap lowercase substring scan eliminates almost the whole corpus per call.
//! And each rule's regex compiles lazily, on first use — a typical turn touches
//! a handful of rules, so the other three hundred never compile at all.

use std::sync::OnceLock;

use regex::Regex;

use crate::entropy::shannon_entropy;
use crate::region::Region;
use crate::vendor_rules::VENDOR_RULES;
use crate::Category;

/// One vendored detection rule. Generated data — see `scripts/gen_vendor_rules.py`.
pub struct VendorRule {
    /// Upstream rule id, e.g. `anthropic-api-key`. Diagnostic only.
    pub id: &'static str,
    /// Go/RE2 source pattern, valid for Rust's `regex` crate.
    pub pattern: &'static str,
    /// Lowercase substrings that must be present for the regex to be run.
    pub keywords: &'static [&'static str],
    /// Capture group holding the secret. 0 means "group 1 if the pattern has
    /// one, otherwise the whole match" — the upstream default.
    pub secret_group: usize,
    /// Upstream entropy filter, if any: the finding is discarded below this.
    pub min_entropy: Option<f64>,
    /// Whether the upstream filter used `<=` (discard at the threshold) rather
    /// than `<` (discard below it).
    pub entropy_inclusive: bool,
}

impl VendorRule {
    /// Does the finding clear this rule's entropy filter?
    fn passes_entropy(&self, secret: &str) -> bool {
        match self.min_entropy {
            None => true,
            Some(threshold) => {
                let entropy = shannon_entropy(secret);
                if self.entropy_inclusive {
                    entropy > threshold
                } else {
                    entropy >= threshold
                }
            }
        }
    }
}

/// Lazily-compiled regex per rule, parallel to `VENDOR_RULES`.
fn compiled() -> &'static [OnceLock<Option<Regex>>] {
    static SLOTS: OnceLock<Vec<OnceLock<Option<Regex>>>> = OnceLock::new();
    SLOTS.get_or_init(|| (0..VENDOR_RULES.len()).map(|_| OnceLock::new()).collect())
}

/// The compiled regex for rule `index`, or `None` if it does not compile.
///
/// A rule that fails to compile is skipped rather than panicking: a bad pattern
/// in vendored data must not take down the capture path at runtime. The
/// `vendor_rules_all_compile` test is what makes that case impossible to ship.
fn rule_regex(index: usize) -> Option<&'static Regex> {
    compiled()[index]
        .get_or_init(|| Regex::new(VENDOR_RULES[index].pattern).ok())
        .as_ref()
}

pub(crate) fn detect(input: &str) -> Vec<Region> {
    matches(input)
        .into_iter()
        .map(|(_, region)| region)
        .collect()
}

/// Ids of the rules that matched `input`, each once, in corpus order.
pub(crate) fn matched_ids(input: &str) -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = Vec::new();
    for (index, _) in matches(input) {
        let id = VENDOR_RULES[index].id;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// Every match: the rule that found it and the secret's span.
fn matches(input: &str) -> Vec<(usize, Region)> {
    let haystack = input.to_ascii_lowercase();
    let mut found = Vec::new();

    for (index, rule) in VENDOR_RULES.iter().enumerate() {
        if !rule.keywords.is_empty()
            && !rule
                .keywords
                .iter()
                .any(|keyword| haystack.contains(keyword))
        {
            continue;
        }
        let Some(regex) = rule_regex(index) else {
            continue;
        };
        for captures in regex.captures_iter(input) {
            let group = match rule.secret_group {
                0 => captures.get(1).or_else(|| captures.get(0)),
                n => captures.get(n),
            };
            let Some(secret) = group else { continue };
            if !rule.passes_entropy(secret.as_str()) {
                continue;
            }
            found.push((
                index,
                Region::new(secret.start(), secret.end(), Category::VendorRule),
            ));
        }
    }
    found
}

/// How many rules are vendored. Exposed so a test can assert the corpus did not
/// silently shrink to nothing after a regeneration.
pub fn rule_count() -> usize {
    VENDOR_RULES.len()
}

/// Rule ids whose pattern does not compile. Empty in a healthy build; the
/// generator's `INCOMPATIBLE` list is where a genuinely unportable rule is
/// recorded and dropped.
pub fn uncompilable_rule_ids() -> Vec<&'static str> {
    VENDOR_RULES
        .iter()
        .enumerate()
        .filter(|(index, _)| rule_regex(*index).is_none())
        .map(|(_, rule)| rule.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_vendored_rule_compiles_under_the_rust_regex_crate() {
        let bad = uncompilable_rule_ids();
        assert!(
            bad.is_empty(),
            "{} vendored rules do not compile: {bad:?} — add them to INCOMPATIBLE in \
             scripts/gen_vendor_rules.py with a reason, then regenerate",
            bad.len()
        );
    }

    #[test]
    fn the_corpus_is_substantial() {
        // A regeneration against a bad path would silently emit an empty table
        // and every vendor-layer test would still pass by matching nothing.
        assert!(rule_count() > 200, "only {} rules vendored", rule_count());
    }

    #[test]
    fn every_rule_declares_keywords_so_the_prefilter_can_do_its_job() {
        let keywordless: Vec<_> = VENDOR_RULES
            .iter()
            .filter(|rule| rule.keywords.is_empty())
            .map(|rule| rule.id)
            .collect();
        // A keywordless rule runs its regex against every string we ever redact.
        assert!(keywordless.len() <= 1, "keywordless rules: {keywordless:?}");
    }
}
