//! End-to-end import tests, against committed fixtures.
//!
//! Nothing here touches the network (the fixtures are the point) and nothing
//! reads `~/.config`. Each test asserts on the *converted theme* and on the
//! *report*, because the report is half the feature: an importer that silently
//! drops two thirds of a VS Code theme and an importer that drops two thirds
//! and says so are different products.

use std::collections::BTreeSet;
use std::path::Path;

use atlas_theme::export::to_shadcn_registry_item;
use atlas_theme::import::report::Fidelity;
use atlas_theme::import::{import_themes, ImportFormat, ImportOptions, ImportedTheme};
use atlas_theme::{parse_theme, Theme, ThemeKeyValue, BASE_TOKENS};

const TWEAKCN: &str = include_str!("fixtures/tweakcn-catppuccin.json");
const GLOBALS_CSS: &str = include_str!("fixtures/shadcn-globals.css");
const ZED: &str = include_str!("fixtures/zed-rose-pine.json");
const VSCODE: &str = include_str!("fixtures/vscode-nocturne.json");

fn fixtures() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures"))
}

fn options(origin: &str) -> ImportOptions {
    ImportOptions {
        origin: origin.to_string(),
        ..ImportOptions::default()
    }
}

fn import(source: &str, origin: &str) -> Vec<ImportedTheme> {
    import_themes(source, None, None, &options(origin)).expect("import succeeds")
}

/// Every required base token present, and every value one the loader accepts —
/// which is exactly what the TypeScript resolver needs to produce every key in
/// `atlas_theme::theme_keys()`.
fn assert_complete(theme: &Theme) {
    let reparsed = parse_theme(&atlas_theme::toml_writer::theme_to_toml(theme), "assert").unwrap();
    assert_eq!(
        &reparsed, theme,
        "{}: the written TOML does not re-read",
        theme.id
    );
    assert!(
        theme.dark.is_some() || theme.light.is_some(),
        "{}: no variant",
        theme.id
    );
    for (appearance, variant) in [
        ("dark", theme.dark.as_ref()),
        ("light", theme.light.as_ref()),
    ] {
        let Some(variant) = variant else { continue };
        let missing: Vec<_> = BASE_TOKENS
            .iter()
            .filter(|token| !variant.base.contains_key(**token))
            .collect();
        assert!(
            missing.is_empty(),
            "{}/{appearance}: missing {missing:?}",
            theme.id
        );
        for (key, value) in &variant.keys {
            assert!(
                atlas_theme::is_css_color(value.color()),
                "{}/{appearance}: {key} = {}",
                theme.id,
                value.color()
            );
        }
    }
}

fn color(theme: &Theme, appearance: &str, key: &str) -> String {
    let variant = match appearance {
        "light" => theme.light.as_ref(),
        _ => theme.dark.as_ref(),
    }
    .unwrap_or_else(|| panic!("{} has no {appearance} variant", theme.id));
    variant
        .keys
        .get(key)
        .map(ThemeKeyValue::color)
        .unwrap_or_else(|| panic!("{key} is unset"))
        .to_string()
}

// ── shadcn / tweakcn ────────────────────────────────────────────────────────

#[test]
fn a_tweakcn_registry_item_becomes_a_complete_two_variant_theme() {
    let imported = import(TWEAKCN, "tweakcn-catppuccin.json");
    assert_eq!(imported.len(), 1, "a registry item is one theme");
    let ImportedTheme { theme, report, .. } = &imported[0];

    assert_complete(theme);
    assert_eq!(theme.id, "catppuccin");
    assert_eq!(report.fidelity, Fidelity::Native);
    assert_eq!(report.variants, ["dark", "light"]);

    // The author's own notation survives: nothing is converted to hex.
    let dark = theme.dark.as_ref().unwrap();
    assert_eq!(dark.base["background"], "oklch(0.2155 0.0254 284.0647)");
    assert_eq!(
        dark.base["font-sans"], "Montserrat, sans-serif",
        "cssVars.theme reaches both variants"
    );
    // Except `radius`: its rem assumes a 16px root and Atlas's is 13px, so it
    // is carried over as the px the author saw, and the report says so.
    assert_eq!(dark.base["radius"], "5.6px");
    assert!(
        report
            .summary
            .iter()
            .any(|note| note.contains("0.35rem") && note.contains("5.6px")),
        "the radius conversion should be reported: {:?}",
        report.summary
    );

    // The dark block omits `destructive-foreground`, as current shadcn does.
    // It must be derived, and it must be readable against `destructive`.
    assert!(
        report
            .derived
            .iter()
            .any(|entry| entry.target == "dark.base.destructive-foreground"),
        "destructive-foreground should be reported as derived: {:?}",
        report.derived
    );
    assert!(dark.base.contains_key("destructive-foreground"));

    // Decision 20: kept, ignored, and said out loud.
    assert_eq!(dark.base["spacing"], "0.25rem");
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("spacing")),
        "the spacing warning is required by decision 20: {:?}",
        report.warnings
    );

    // tweakcn's shadow ingredients have nowhere to go and are categorised.
    assert_eq!(
        report.counts.ignored_by_category.get("shadow recipe"),
        Some(&6)
    );
    assert!(report.counts.mapped > 80, "{:?}", report.counts);
}

#[test]
fn a_pasted_globals_css_yields_light_and_dark() {
    let imported = import(GLOBALS_CSS, "globals.css");
    let ImportedTheme { theme, report, .. } = &imported[0];
    assert_complete(theme);
    assert_eq!(report.format, "shadcn-css");
    assert_eq!(report.variants, ["dark", "light"]);

    assert_eq!(
        theme.light.as_ref().unwrap().base["background"],
        "oklch(1 0 0)"
    );
    assert_eq!(
        theme.dark.as_ref().unwrap().base["background"],
        "oklch(0.145 0 0)"
    );
    // `@theme` reaches both variants, and `--letter-spacing` is tweakcn's name
    // for the tracking token.
    assert_eq!(
        theme.dark.as_ref().unwrap().base["font-sans"],
        "Inter, sans-serif"
    );
    assert_eq!(
        theme.dark.as_ref().unwrap().base["tracking-normal"],
        "0.01em"
    );
    // `--color-background: var(--background)` is an alias, not a value.
    assert!(!report
        .ignored
        .iter()
        .any(|entry| entry.source.contains("color-background")));
}

#[test]
fn a_dark_only_paste_is_not_filed_as_a_light_variant() {
    let source = ":root { --background: #0b0b0f; --foreground: #f4f4f5; }";
    let imported = import_themes(
        source,
        None,
        None,
        &ImportOptions {
            origin: "paste".to_string(),
            name_hint: Some("Midnight".to_string()),
            ..ImportOptions::default()
        },
    )
    .unwrap();
    let theme = &imported[0].theme;
    assert!(theme.dark.is_some() && theme.light.is_none());
    assert!(imported[0]
        .report
        .summary
        .iter()
        .any(|line| line.contains("dark variant")));
}

// ── Zed ─────────────────────────────────────────────────────────────────────

#[test]
fn a_zed_family_becomes_one_atlas_theme_per_member() {
    let imported = import(ZED, "zed-rose-pine.json");
    assert_eq!(imported.len(), 2);
    let ids: Vec<&str> = imported
        .iter()
        .map(|entry| entry.theme.id.as_str())
        .collect();
    assert_eq!(ids, ["rose-pine", "rose-pine-dawn"]);

    for entry in &imported {
        assert_complete(&entry.theme);
        assert_eq!(entry.report.fidelity, Fidelity::NearLossless);
        assert_eq!(entry.theme.author, "Rosé Pine");
    }

    let dark = &imported[0].theme;
    assert!(
        dark.dark.is_some() && dark.light.is_none(),
        "a family member has one appearance"
    );
    assert!(imported[1].theme.light.is_some());

    // Zed's `border` has no theme key of its own any more; it carries the
    // shadcn `border` token, and `border.disabled` is the low-emphasis one.
    assert_eq!(dark.dark.as_ref().unwrap().base["border"], "#26233aff");
    assert_eq!(color(dark, "dark", "border.subtle"), "#2a2a3aff");

    // All 16 ANSI colours transfer.
    let variant = dark.dark.as_ref().unwrap();
    let ansi = variant
        .keys
        .keys()
        .filter(|key| key.starts_with("terminal.ansi."))
        .count();
    assert_eq!(ansi, 16);

    // `players[0]` is the local user's cursor and selection.
    assert_eq!(color(dark, "dark", "editor.caret"), "#c4a7e7ff");
    assert_eq!(color(dark, "dark", "selection.background"), "#c4a7e733");

    // An italic Zed scope keeps its colour and loses the italics: the loader
    // rejects a `font_style`, so importing one would produce a file Atlas then
    // refuses. The drop is in the report rather than silent.
    assert_eq!(
        variant.keys["syntax.keyword"],
        ThemeKeyValue::Color("#31748fff".to_string())
    );
    assert!(
        imported[0]
            .report
            .ignored
            .iter()
            .any(|entry| entry.category == "font styles" && entry.source.contains("keyword")),
        "{:?}",
        imported[0].report.ignored
    );

    // The palette is guessed from the ANSI ramp, which is what carries the
    // status, agent and diff keys through resolution.
    assert_eq!(variant.palette["red"], "#eb6f92ff");
    assert_eq!(variant.palette["purple"], "#c4a7e7ff");

    // Zed has no shadcn layer, so `accent` must come from the hover surface —
    // not from a brand colour (the audit's "accent collision").
    assert_eq!(variant.base["accent"], "#ffffff14");
    assert_eq!(variant.base["primary"], "#c4a7e7ff");

    // Zed roles Atlas has no home for are counted, not silently dropped.
    let ignored = &imported[0].report.counts.ignored_by_category;
    assert!(ignored.contains_key("icon roles"), "{ignored:?}");
    assert!(ignored.contains_key("app chrome"), "{ignored:?}");
}

/// Regression test: `players[0].selection` used to fan out to
/// `terminal.selection` too, which is a `[[derived]]` variable in keys.toml
/// (derived from the shadcn `primary` token), not a settable `[[key]]` — so
/// every Zed import wrote an unknown key and loaded with a warning.
/// `finish_theme` writes the converted TOML and re-reads it through
/// `parse_theme`, which is what actually raises `ThemeWarning`s, so checking
/// `theme.warnings` here is checking exactly what the app would show the user
/// on import, not just the in-memory draft.
#[test]
fn a_zed_import_loads_with_no_unknown_key_warnings() {
    for entry in import(ZED, "zed-rose-pine.json") {
        assert!(
            entry.theme.warnings.is_empty(),
            "{}: {:?}",
            entry.theme.id,
            entry.theme.warnings
        );
    }
}

// ── VS Code ─────────────────────────────────────────────────────────────────

#[test]
fn a_vs_code_theme_resolves_its_include_and_the_child_wins() {
    let imported = import_themes(
        VSCODE,
        None,
        Some(fixtures()),
        &options("vscode-nocturne.json"),
    )
    .unwrap();
    let ImportedTheme { theme, report, .. } = &imported[0];
    assert_complete(theme);
    assert_eq!(report.fidelity, Fidelity::Lossy);
    assert_eq!(theme.name, "Nocturne Bright");
    assert!(
        report.warnings.is_empty(),
        "the include resolved: {:?}",
        report.warnings
    );
    assert!(report
        .summary
        .iter()
        .any(|line| line.contains("vscode-base.json")));

    // Child overrides parent…
    assert_eq!(color(theme, "dark", "editor.background"), "#20232b");
    // …and everything the child did not restate comes from the parent.
    assert_eq!(color(theme, "dark", "terminal.ansi.magenta"), "#c678dd");
    assert_eq!(color(theme, "dark", "editor.caret"), "#5a9cf8");
}

#[test]
fn text_mate_scopes_resolve_by_specificity_with_the_later_rule_winning() {
    let imported = import_themes(VSCODE, None, Some(fixtures()), &options("vscode")).unwrap();
    let theme = &imported[0].theme;

    // `constant.character.escape` is more specific than `constant`, so the
    // escape colour is the specific rule's and not the generic one's.
    assert_eq!(color(theme, "dark", "syntax.constant"), "#d19a66");
    assert_eq!(color(theme, "dark", "syntax.number"), "#d19a66");
    assert_eq!(color(theme, "dark", "syntax.string"), "#98c379");
    assert_eq!(color(theme, "dark", "syntax.escape"), "#56b6c2");
    assert_eq!(color(theme, "dark", "syntax.function"), "#61afef");
    assert_eq!(color(theme, "dark", "syntax.tag"), "#e06c75");

    // The child's `comment` rule is appended after the parent's, so it wins the
    // specificity tie — the same order VS Code applies.
    assert_eq!(color(theme, "dark", "syntax.comment"), "#6b7280");

    // `fontStyle: italic` is dropped, and the rule's colour still lands.
    assert_eq!(color(theme, "dark", "syntax.keyword"), "#c678dd");
    let report = &imported[0].report;
    assert!(
        report
            .ignored
            .iter()
            .any(|entry| entry.category == "font styles" && entry.source.contains("fontStyle")),
        "{:?}",
        report.ignored
    );
    // The category count is recomputed from the list, so it moves with it.
    assert_eq!(
        report.counts.ignored_by_category["font styles"],
        report
            .ignored
            .iter()
            .filter(|entry| entry.category == "font styles")
            .count()
    );
}

#[test]
fn semantic_token_colours_take_precedence_and_modifiers_are_declined() {
    let imported = import_themes(VSCODE, None, Some(fixtures()), &options("vscode")).unwrap();
    let ImportedTheme { theme, report, .. } = &imported[0];

    // `property` is stated semantically; the TextMate `variable.other.property`
    // rule (#56b6c2) does not override it.
    assert_eq!(color(theme, "dark", "syntax.property"), "#8ec07c");
    // `class` carries a fontStyle; only its colour crosses.
    assert_eq!(
        theme.dark.as_ref().unwrap().keys["syntax.type"],
        ThemeKeyValue::Color("#e5c07b".to_string())
    );
    assert!(
        report.ignored.iter().any(|entry| {
            entry.category == "font styles" && entry.source == "semanticTokenColors.class.fontStyle"
        }),
        "{:?}",
        report.ignored
    );
    // A selector with modifiers is conditional and is reported, not applied.
    assert!(
        report
            .ignored
            .iter()
            .any(|entry| entry.category == "semantic tokens"),
        "{:?}",
        report.ignored
    );
}

#[test]
fn a_pasted_theme_reports_the_include_it_could_not_follow() {
    let imported = import_themes(VSCODE, None, None, &options("pasted")).unwrap();
    let report = &imported[0].report;
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("vscode-base.json")),
        "{:?}",
        report.warnings
    );
    // It still produces a usable theme from what the child alone carries.
    assert_complete(&imported[0].theme);
}

#[test]
fn a_vs_code_import_is_honest_about_how_much_it_left_behind() {
    let imported = import_themes(VSCODE, None, Some(fixtures()), &options("vscode")).unwrap();
    let report = &imported[0].report;
    assert!(report.counts.ignored > 15, "{:?}", report.counts);
    let categories: BTreeSet<&str> = report
        .counts
        .ignored_by_category
        .keys()
        .map(String::as_str)
        .collect();
    for expected in [
        "editor furniture",
        "widget",
        "app chrome",
        "textmate scopes",
    ] {
        assert!(
            categories.contains(expected),
            "missing {expected}: {categories:?}"
        );
    }
    assert!(report
        .summary
        .iter()
        .any(|line| line.contains("starting point")));
}

// ── export ──────────────────────────────────────────────────────────────────

#[test]
fn an_atlas_theme_survives_a_trip_through_shadcn_and_back() {
    let original = atlas_theme::built_in_themes()
        .unwrap()
        .into_iter()
        .find(|theme| theme.id == "tokyo-night")
        .unwrap();
    let export = to_shadcn_registry_item(&original);

    let back = import_themes(
        &export.json,
        Some(ImportFormat::Shadcn),
        None,
        &options("round trip"),
    )
    .unwrap();
    assert_eq!(back.len(), 1);
    let roundtripped = &back[0].theme;
    assert_complete(roundtripped);
    assert_eq!(roundtripped.id, original.id);
    assert_eq!(roundtripped.name, original.name);

    // Every base token, in every variant, byte for byte.
    for (appearance, source) in [
        ("dark", original.dark.as_ref()),
        ("light", original.light.as_ref()),
    ] {
        let Some(source) = source else { continue };
        let target = match appearance {
            "light" => roundtripped.light.as_ref(),
            _ => roundtripped.dark.as_ref(),
        }
        .unwrap_or_else(|| panic!("{appearance} variant did not survive"));
        for (token, value) in &source.base {
            assert_eq!(target.base.get(token), Some(value), "{appearance}.{token}");
        }
    }

    // And the report says what shadcn cannot hold.
    assert!(export.report.dropped > 40, "{:?}", export.report);
    assert!(export.report.dropped_by_category.contains_key("syntax"));
    assert!(export
        .report
        .notes
        .iter()
        .any(|note| note.contains("no shadcn equivalent")));
}

// ── failures ────────────────────────────────────────────────────────────────

#[test]
fn bad_input_fails_with_something_a_user_can_act_on() {
    let cases: &[(&str, &str)] = &[
        ("{ not json", "unrecognized theme format"),
        ("hello world", "unrecognized theme format"),
        (r#"{"themes": []}"#, "`themes` is empty"),
        (r#"{"cssVars": {}}"#, "no cssVars found"),
        (r#"{"colors": {}}"#, "no usable colors"),
        (":root { color: red; }", "no CSS custom properties"),
    ];
    for (source, expected) in cases {
        let error = import_themes(source, None, None, &options("bad"))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(expected),
            "{source:?} gave {error:?}, wanted {expected:?}"
        );
    }
}

#[test]
fn an_explicit_format_overrides_the_sniffer() {
    // A Zed file forced through the VS Code importer must fail loudly rather
    // than produce a theme out of the two keys the shapes happen to share.
    let error = import_themes(ZED, Some(ImportFormat::VsCode), None, &options("forced"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("no usable colors"), "{error}");
}

/// The mock backend and the TypeScript resolver test both read this file: it is
/// the one place an imported theme's exact shape is pinned. Regenerate with
/// `UPDATE_IMPORT_SNAPSHOT=1 cargo test -p atlas-theme --test import`.
#[test]
fn browser_mock_snapshot_is_current() {
    const PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/dev/mock-backend/fixtures/imported-themes.json"
    );
    let mut themes: Vec<Theme> = Vec::new();
    themes.push(import(TWEAKCN, "tweakcn-catppuccin.json").remove(0).theme);
    themes.extend(
        import(ZED, "zed-rose-pine.json")
            .into_iter()
            .map(|entry| entry.theme),
    );
    themes.push(
        import_themes(
            VSCODE,
            None,
            Some(fixtures()),
            &options("vscode-nocturne.json"),
        )
        .unwrap()
        .remove(0)
        .theme,
    );
    let expected = serde_json::to_string_pretty(&themes).unwrap() + "\n";
    if std::env::var("UPDATE_IMPORT_SNAPSHOT").as_deref() == Ok("1") {
        std::fs::write(PATH, &expected).unwrap();
    }
    assert_eq!(std::fs::read_to_string(PATH).unwrap_or_default(), expected);
}
