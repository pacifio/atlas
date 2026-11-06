//! Rust's half of the base-derivation contract (ADR-0022).
//!
//! `base-derivation.json` is written by TypeScript's `resolveBase`, in
//! `@tryatlas/design`, and copied here by `bun run theme:keys`
//! (`src/features/theme/resolve-theme.test.ts` checks the installed package
//! still agrees with it). This test demands that `atlas_theme::derive`
//! reproduce every value in it exactly.
//! What fails silently without it: a rule or an operation edited in one
//! interpreter and not the other. Import and export would then write one set
//! of colours and the app would paint another, with nothing to say so.

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    appearance: String,
    written: BTreeMap<String, String>,
    palette: BTreeMap<String, String>,
    base: BTreeMap<String, String>,
}

#[test]
fn rust_derives_exactly_what_typescript_derives() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/base-derivation.json")).unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let derived = atlas_theme::derive::resolve_base(
            &case.written,
            &case.palette,
            case.appearance == "dark",
        );
        for (token, expected) in &case.base {
            assert_eq!(
                derived.get(token),
                Some(expected),
                "{}: {token} (regenerate with ATLAS_WRITE_DERIVATION=1 only if TS is the side you changed)",
                case.name
            );
        }
        assert_eq!(derived.len(), case.base.len(), "{}: token count", case.name);
    }
}
