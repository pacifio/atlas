//! Zed → Atlas.
//!
//! The near-lossless case, and not by accident: decision 9 modelled Atlas's
//! theme keys on Zed's dotted role names, so most of this file is a table of
//! identities. Where the names differ it is because Atlas's no-leaf-and-prefix
//! rule forbids Zed's shape — Zed has a bare `border` alongside `border.variant`,
//! `border.selected`, `border.disabled` and `border.focused`. The middle three
//! collapse onto the two Atlas border keys in [`STYLE_MAP`] (`border.subtle` and
//! `border.strong`); the bare `border` and `border.focused` are not theme keys
//! at all and carry into the shadcn `border`/`input` and `ring` base tokens
//! instead (see `derive_base_tokens`).
//!
//! **A family is several themes, not one theme with several variants.** A Zed
//! file is `{name, themes: [{name, appearance, style}]}` and the members are
//! siblings, not a dark/light pair of one design: "Rosé Pine", "Rosé Pine Moon"
//! and "Rosé Pine Dawn" are three themes that happen to ship together. Each one
//! becomes its own Atlas theme with a single variant, which is also how the
//! built-ins already treat that exact family.
//!
//! **What Zed does not have is the shadcn layer.** Its style is a flat map of
//! app roles with no notion of `card` / `popover` / `primary`, so all 45 base
//! tokens are derived — see [`derive_base_tokens`] for the chain, which is
//! reported key by key rather than hidden.
//!
//! **What Atlas does not have** is Zed's icon and player vocabulary, its
//! per-role `.border` triplets, and the editor furniture Atlas draws itself
//! (wrap guides, invisibles, subheaders). Those are counted and categorised in
//! the report rather than dropped in silence.

use serde_json::{Map, Value};

use crate::import::draft::VariantDraft;
use crate::import::report::{Fidelity, ImportReport};
use crate::import::{finish_theme, ImportOptions, ImportedTheme};
use crate::{ThemeError, ThemeKeyValue};

/// Zed style key → Atlas theme key. One source may feed several targets.
const STYLE_MAP: &[(&str, &[&str])] = &[
    ("border.selected", &["border.strong"]),
    ("border.disabled", &["border.subtle"]),
    ("border.variant", &["border.subtle"]),
    ("element.hover", &["element.hover"]),
    ("element.selected", &["element.selected"]),
    ("element.active", &["element.active"]),
    ("text.disabled", &["text.disabled"]),
    ("success", &["status.success.foreground"]),
    ("warning", &["status.warning.foreground"]),
    ("error", &["status.error.foreground"]),
    ("info", &["status.info.foreground"]),
    ("created", &["diff.added.text"]),
    (
        "created.background",
        &["diff.added.background", "diff.added.emphasis"],
    ),
    ("deleted", &["diff.removed.text"]),
    (
        "deleted.background",
        &["diff.removed.background", "diff.removed.emphasis"],
    ),
    (
        "editor.background",
        &[
            "editor.background",
            "diff.context.background",
            "panel.input.background",
        ],
    ),
    ("editor.foreground", &["editor.foreground", "editor.caret"]),
    ("editor.gutter.background", &["editor.gutter.background"]),
    ("editor.line_number", &["editor.gutter.foreground"]),
    (
        "editor.active_line_number",
        &["editor.active_line.gutter_foreground"],
    ),
    (
        "editor.active_line.background",
        &["editor.active_line.background"],
    ),
    (
        "editor.document_highlight.read_background",
        &["editor.match_bracket.background"],
    ),
    ("surface.background", &["panel.background"]),
    (
        "search.match_background",
        &["search.match.background", "search.match.active_background"],
    ),
    (
        "scrollbar.thumb.background",
        &["scrollbar.thumb.background"],
    ),
    (
        "scrollbar.thumb.hover_background",
        &["scrollbar.thumb.hover"],
    ),
    ("terminal.background", &["terminal.background"]),
    ("terminal.foreground", &["terminal.foreground"]),
    ("terminal.ansi.black", &["terminal.ansi.black"]),
    ("terminal.ansi.red", &["terminal.ansi.red"]),
    ("terminal.ansi.green", &["terminal.ansi.green"]),
    ("terminal.ansi.yellow", &["terminal.ansi.yellow"]),
    ("terminal.ansi.blue", &["terminal.ansi.blue"]),
    ("terminal.ansi.magenta", &["terminal.ansi.magenta"]),
    ("terminal.ansi.cyan", &["terminal.ansi.cyan"]),
    ("terminal.ansi.white", &["terminal.ansi.white"]),
    (
        "terminal.ansi.bright_black",
        &["terminal.ansi.bright_black"],
    ),
    ("terminal.ansi.bright_red", &["terminal.ansi.bright_red"]),
    (
        "terminal.ansi.bright_green",
        &["terminal.ansi.bright_green"],
    ),
    (
        "terminal.ansi.bright_yellow",
        &["terminal.ansi.bright_yellow"],
    ),
    ("terminal.ansi.bright_blue", &["terminal.ansi.bright_blue"]),
    (
        "terminal.ansi.bright_magenta",
        &["terminal.ansi.bright_magenta"],
    ),
    ("terminal.ansi.bright_cyan", &["terminal.ansi.bright_cyan"]),
    (
        "terminal.ansi.bright_white",
        &["terminal.ansi.bright_white"],
    ),
];

/// Zed syntax scope → Atlas `syntax.*` key. Zed's map is richer than Atlas's
/// fifteen roles, so several Zed scopes collapse onto one Atlas key; the first
/// one present wins.
const SYNTAX_MAP: &[(&str, &[&str])] = &[
    ("syntax.comment", &["comment", "comment.doc"]),
    ("syntax.keyword", &["keyword"]),
    ("syntax.string", &["string"]),
    ("syntax.number", &["number"]),
    ("syntax.type", &["type"]),
    ("syntax.function", &["function"]),
    ("syntax.variable", &["variable"]),
    ("syntax.operator", &["operator"]),
    ("syntax.tag", &["tag"]),
    ("syntax.attribute", &["attribute", "preproc", "embedded"]),
    (
        "syntax.constant",
        &["constant", "constant.builtin", "boolean"],
    ),
    ("syntax.regexp", &["string.regex"]),
    ("syntax.escape", &["string.escape"]),
    ("syntax.definition", &["title", "constructor"]),
    ("syntax.property", &["property"]),
];

/// Zed style keys that exist, are understood, and have nowhere to go.
/// Listed by prefix so the report can say *why* rather than "unknown".
const IGNORED_PREFIXES: &[(&str, &str, &str)] = &[
    ("icon", "icon roles", "Atlas icons take their color from the text roles"),
    ("players", "collaboration", "Atlas has no multiplayer cursors"),
    ("editor.wrap_guide", "editor furniture", "Atlas's editor draws no wrap guides"),
    ("editor.active_wrap_guide", "editor furniture", "Atlas's editor draws no wrap guides"),
    ("editor.invisible", "editor furniture", "Atlas does not render invisibles"),
    ("editor.subheader", "editor furniture", "Atlas has no editor subheader"),
    ("editor.highlighted_line", "editor furniture", "Atlas highlights only the active line"),
    ("editor.document_highlight.write", "editor furniture", "Atlas has one bracket/occurrence highlight, not a read/write pair"),
    ("status_bar", "app chrome", "Atlas's status bar follows the panel tokens"),
    ("title_bar", "app chrome", "Atlas's title bar follows the panel tokens"),
    ("toolbar", "app chrome", "Atlas's toolbars follow the panel tokens"),
    ("tab_bar", "app chrome", "Atlas's tab strip follows the accent and sidebar tokens"),
    ("tab", "app chrome", "Atlas's tab strip follows the accent and sidebar tokens"),
    ("pane", "app chrome", "Atlas has no per-pane border role"),
    ("panel.focused_border", "app chrome", "Atlas has one focus border role"),
    ("drop_target", "app chrome", "Atlas draws drop targets from the primary token"),
    ("link_text", "app chrome", "Atlas links follow `primary`"),
    ("success.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("warning.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("error.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("info.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("modified.background", "vcs", "Atlas tints only additions and removals"),
    ("border", "base tokens", "Zed's border roles are carried into the shadcn `border` and `ring` tokens"),
    ("background", "base tokens", "carried into the shadcn `background` token"),
    ("elevated_surface", "base tokens", "carried into the shadcn `card` and `popover` tokens"),
    ("text.muted", "base tokens", "carried into the shadcn `muted-foreground` token"),
    ("text.accent", "base tokens", "carried into the shadcn `primary` token"),
    ("text.placeholder", "text roles", "Atlas's placeholder follows `muted-foreground`"),
    ("ghost_element", "element overlays", "Atlas has one overlay ladder, not a ghost variant"),
    ("panel.background", "app chrome", "Atlas's project rail follows the panel tokens"),
    ("scrollbar.track", "app chrome", "Atlas paints the scrollbar track transparent"),
    ("conflict", "vcs", "Atlas shows conflicts through the status tokens"),
    ("renamed", "vcs", "Atlas has no renamed-file color"),
    ("ignored", "vcs", "Atlas has no ignored-file color"),
    ("hidden", "vcs", "Atlas has no hidden-file color"),
    ("unreachable", "vcs", "Atlas has no unreachable-code color"),
    ("predictive", "editor furniture", "Atlas has no inline-prediction color"),
    ("hint", "editor furniture", "Atlas has no inlay-hint color"),
    ("terminal.bright_foreground", "terminal", "Atlas has one terminal foreground"),
    ("terminal.dim_foreground", "terminal", "Atlas has one terminal foreground"),
    ("terminal.ansi.dim", "terminal", "Atlas exposes the 16-color ANSI set, not Zed's dim ramp"),
];

pub(crate) fn import(
    value: &Value,
    options: &ImportOptions,
) -> Result<Vec<ImportedTheme>, ThemeError> {
    let family = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Zed theme");
    let author = value.get("author").and_then(Value::as_str);
    let themes = value
        .get("themes")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::validation(&options.origin, "a Zed theme family needs a `themes` array")
        })?;
    if themes.is_empty() {
        return Err(crate::validation(&options.origin, "`themes` is empty"));
    }

    let mut out = Vec::with_capacity(themes.len());
    for entry in themes {
        out.push(import_one(entry, family, author, options)?);
    }
    Ok(out)
}

fn import_one(
    entry: &Value,
    family: &str,
    author: Option<&str>,
    options: &ImportOptions,
) -> Result<ImportedTheme, ThemeError> {
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(family)
        .to_string();
    let appearance = match entry.get("appearance").and_then(Value::as_str) {
        Some("light") => "light",
        _ => "dark",
    };
    let style = entry
        .get("style")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            crate::validation(
                &options.origin,
                format!("theme \"{name}\" has no `style` object"),
            )
        })?;

    let mut report = ImportReport::new("zed", name.clone(), Fidelity::NearLossless);
    let mut draft = VariantDraft::new(appearance);

    // Players first: `players[0].cursor` is a better `editor.caret` than the
    // editor foreground STYLE_MAP would otherwise leave there, and first writer
    // wins inside a draft.
    map_players(style, &mut draft, &mut report);
    for (source, targets) in STYLE_MAP {
        let Some(value) = string_at(style, source) else {
            continue;
        };
        for target in *targets {
            draft.map_color_key(target, source, value);
        }
    }
    map_syntax(style, &mut draft, &mut report);

    draft.fill_palette();
    derive_base_tokens(&mut draft, style);
    draft.fill_required_base();

    record_ignored(style, &mut report);
    report.note(
        "Atlas's theme keys were modeled on Zed's roles, so the editor, terminal, syntax and diff colors transfer directly",
    );
    report.note(
        "Zed has no shadcn layer, so all 45 base tokens were derived from the style — check `primary`, `accent` and `card` first if the chrome looks off",
    );

    finish_theme_with_name(vec![draft], report, options, &name, family, author)
}

/// `players[0]` is the local user, so its cursor and selection are the ones the
/// single-user Atlas actually draws.
fn map_players(style: &Map<String, Value>, draft: &mut VariantDraft, report: &mut ImportReport) {
    let Some(first) = style
        .get("players")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
    else {
        return;
    };
    if let Some(cursor) = first.get("cursor").and_then(Value::as_str) {
        draft.map_color_key("editor.caret", "players[0].cursor", cursor);
        draft.map_color_key("terminal.cursor", "players[0].cursor", cursor);
    }
    if let Some(selection) = first.get("selection").and_then(Value::as_str) {
        // `terminal.selection` is a *derived* variable (`[[derived]]` in
        // keys.toml, not `[[key]]`): Atlas always computes it from the shadcn
        // `primary` base token at 30% alpha, and no theme may set it directly —
        // writing it here loaded every Zed import with an unknown-key warning.
        // `derive_base_tokens` below already sources `primary` from Zed's
        // `text.accent`, so the derived value still reflects the imported
        // theme; there is nothing left for this loop to write.
        for target in ["selection.background", "editor.selection.background"] {
            draft.map_color_key(target, "players[0].selection", selection);
        }
    }
    let extra = style
        .get("players")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
        .saturating_sub(1);
    if extra > 0 {
        report.ignore(
            format!("players[1..{}]", extra + 1),
            "collaboration",
            "Atlas has no multiplayer cursors; only the local player's cursor and selection are used",
        );
    }
}

/// Zed's `syntax` map is `{scope: {color, font_style, font_weight}}`. Only the
/// colour crosses: an Atlas theme key is a colour and nothing else, and the
/// loader rejects a `font_style` outright rather than accept one no consumer
/// reads. So an italicised scope is imported upright, and says so in the
/// dropped list — the alternative is a TOML the loader refuses.
fn map_syntax(style: &Map<String, Value>, draft: &mut VariantDraft, report: &mut ImportReport) {
    let Some(syntax) = style.get("syntax").and_then(Value::as_object) else {
        return;
    };
    let mut used = std::collections::BTreeSet::new();
    let mut styled = std::collections::BTreeSet::new();
    for (target, scopes) in SYNTAX_MAP {
        for scope in *scopes {
            let Some(entry) = syntax.get(*scope) else {
                continue;
            };
            let Some(color) = entry.get("color").and_then(Value::as_str) else {
                continue;
            };
            let has_font_style = entry
                .get("font_style")
                .and_then(Value::as_str)
                .is_some_and(|style| !style.eq_ignore_ascii_case("normal"));
            if draft.map_key(
                target,
                &format!("syntax.{scope}"),
                ThemeKeyValue::Color(color.to_string()),
            ) {
                used.insert((*scope).to_string());
                if has_font_style {
                    styled.insert((*scope).to_string());
                }
                break;
            }
        }
    }
    for scope in &styled {
        report.ignore(
            format!("syntax.{scope}.font_style"),
            "font styles",
            "an Atlas theme key carries a color only; the scope is imported with its color and no italics",
        );
    }
    let unused = syntax.keys().filter(|scope| !used.contains(*scope)).count();
    if unused > 0 {
        report.ignore(
            format!("syntax.* ({unused} scopes)"),
            "syntax scopes",
            "Zed's finer scopes collapse onto Atlas's syntax roles (see SYNTAX_MAP), and the surplus is dropped",
        );
    }
}

/// The shadcn base tokens ([`crate::BASE_TOKENS`]), from Zed roles.
///
/// Every entry here is a judgement, so each is a one-liner rather than a table:
/// `accent` is shadcn's *hover surface* (the audit's "accent collision"), not a
/// brand colour, which is why it comes from `element.hover` and `primary` comes
/// from `text.accent`.
fn derive_base_tokens(draft: &mut VariantDraft, style: &Map<String, Value>) {
    let get = |key: &str| string_at(style, key).map(str::to_string);
    const PAIRS: &[(&str, &str)] = &[
        ("background", "background"),
        ("foreground", "text"),
        ("card", "elevated_surface.background"),
        ("card-foreground", "text"),
        ("popover", "elevated_surface.background"),
        ("popover-foreground", "text"),
        ("primary", "text.accent"),
        ("secondary", "surface.background"),
        ("secondary-foreground", "text.muted"),
        ("muted", "element.background"),
        ("muted-foreground", "text.muted"),
        ("accent", "element.hover"),
        ("accent-foreground", "text"),
        ("destructive", "error"),
        ("border", "border"),
        ("input", "border"),
        ("ring", "border.focused"),
        ("sidebar", "surface.background"),
        ("sidebar-foreground", "text"),
        ("sidebar-primary", "text.accent"),
        ("sidebar-accent", "element.hover"),
        ("sidebar-accent-foreground", "text"),
        ("sidebar-border", "border.variant"),
        ("sidebar-ring", "border.focused"),
        ("chart-1", "terminal.ansi.blue"),
        ("chart-2", "terminal.ansi.green"),
        ("chart-3", "terminal.ansi.yellow"),
        ("chart-4", "terminal.ansi.magenta"),
        ("chart-5", "terminal.ansi.red"),
    ];
    for (token, source) in PAIRS {
        if let Some(value) = get(source) {
            draft.map_base(token, &format!("style.{source}"), &value);
        }
    }
    // The remaining tokens (`primary-foreground`, the fonts, the shadow ramp,
    // `radius`) have no Zed source at all: `fill_required_base` derives them
    // and reports each one.
}

fn record_ignored(style: &Map<String, Value>, report: &mut ImportReport) {
    let mapped: std::collections::BTreeSet<&str> = STYLE_MAP.iter().map(|(key, _)| *key).collect();
    let mut counted: std::collections::BTreeMap<(&str, &str), usize> =
        std::collections::BTreeMap::new();
    let mut unknown = Vec::new();
    for key in style.keys() {
        if key == "syntax" || mapped.contains(key.as_str()) {
            continue;
        }
        match IGNORED_PREFIXES
            .iter()
            .filter(|(prefix, _, _)| key == prefix || key.starts_with(&format!("{prefix}.")))
            .max_by_key(|(prefix, _, _)| prefix.len())
        {
            Some((_, category, reason)) => *counted.entry((category, reason)).or_default() += 1,
            None => unknown.push(key.clone()),
        }
    }
    for ((category, reason), count) in counted {
        report.ignore(format!("{count} {category} key(s)"), category, reason);
    }
    for key in unknown {
        report.ignore(
            key,
            "unmapped zed role",
            "no Atlas theme key carries this role",
        );
    }
}

fn string_at<'a>(style: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    style.get(key).and_then(Value::as_str)
}

/// A Zed family member carries its own name and the family's author, so it
/// cannot go through the plain `finish_theme` path the other importers use.
fn finish_theme_with_name(
    drafts: Vec<VariantDraft>,
    report: ImportReport,
    options: &ImportOptions,
    name: &str,
    family: &str,
    author: Option<&str>,
) -> Result<ImportedTheme, ThemeError> {
    let scoped = ImportOptions {
        origin: options.origin.clone(),
        id_hint: None,
        name_hint: Some(name.to_string()),
        author_hint: Some(author.unwrap_or(family).to_string()),
        license_hint: options.license_hint.clone(),
    };
    finish_theme(drafts, report, &scoped)
}
