//! `detect_categories` reports every layer that matched, before overlapping
//! matches are merged into one replacement — which `redact`'s tally cannot,
//! because a provider key the entropy layer also matched is counted once.

use atlas_redact::{detect_categories, redact, Category};

#[test]
fn a_provider_key_reports_its_provider_layer_even_when_entropy_also_matches() {
    let line = "const k = \"sk_live_51NzQ8vKj2mXyR4tPq9WbE7cL0dF3gH6\";";
    let found = detect_categories(line);
    assert!(
        found.contains(&Category::VendorRule) || found.contains(&Category::ProviderToken),
        "{found:?}"
    );
    // The tally still counts the span once, whichever layer it settled on.
    assert_eq!(redact(line).counts.total(), 1);
}

#[test]
fn clean_text_reports_nothing() {
    assert!(detect_categories("let total = items.len() + 1;").is_empty());
    assert!(detect_categories("").is_empty());
}

#[test]
fn each_category_is_reported_once_in_order() {
    let found = detect_categories("DB_PASSWORD=hunter2hunter2 DB_PASSWORD=other-secret-value");
    let mut sorted = found.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(found, sorted);
}

#[test]
fn vendor_rule_ids_name_the_rules_that_matched() {
    let ids =
        atlas_redact::vendor_rule_ids("const k = \"sk_live_51NzQ8vKj2mXyR4tPq9WbE7cL0dF3gH6\";");
    assert!(ids.iter().any(|id| id.contains("stripe")), "{ids:?}");
    assert!(atlas_redact::vendor_rule_ids("let total = items.len();").is_empty());
}
