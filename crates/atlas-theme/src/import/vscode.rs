//! VS Code colour theme → Atlas.
//!
//! The lossy case, and the report is the feature. A VS Code theme is a
//! *workbench* theme: several hundred `colors` keys naming widgets Atlas does
//! not have (peek views, notification toasts, the minimap, the merge editor,
//! debug toolbars), plus `tokenColors`, which is a TextMate grammar-selector
//! language rather than a list of roles. Roughly a third of the `colors` keys
//! in a typical theme land somewhere in Atlas; the rest are counted by category
//! so the user can see the shape of what was left behind.
//!
//! Three things make it worth doing anyway: `editor.background` /
//! `foreground` / `focusBorder` and friends are enough to derive a credible
//! shadcn layer, the 16 ANSI terminal colours transfer exactly, and
//! `tokenColors` is where the theme's personality actually lives.
//!
//! ## TextMate scope resolution
//!
//! `tokenColors` is a list of rules, each with one or more scope *selectors*.
//! A selector matches a scope when it is a dotted prefix of it, so
//! `string` matches `string.quoted.double.ts`. VS Code resolves a token by
//! taking the most specific matching selector, later rules winning ties.
//!
//! This importer inverts that: for each Atlas `syntax.*` key it holds a short
//! list of *representative* scopes (the table in [`SCOPE_TABLE`]), asks which
//! rule VS Code would apply to each, and takes the winner. That is why the
//! table reads as "scope → key" even though the file is "rule → scopes": it is
//! the question Atlas needs answered, run through VS Code's own matching.
//!
//! `semanticTokenColors` takes precedence where it names a bare token type,
//! because a theme that bothers to write one is stating its intent more
//! directly than a grammar selector can.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::import::draft::VariantDraft;
use crate::import::report::{Fidelity, ImportReport};
use crate::import::{finish_theme, ImportOptions, ImportedTheme};
use crate::{ThemeError, ThemeKeyValue};

/// Workbench colour key → Atlas theme key(s).
const COLOR_MAP: &[(&str, &[&str])] = &[
    (
        "editor.background",
        &["editor.background", "diff.context.background"],
    ),
    ("editor.foreground", &["editor.foreground"]),
    (
        "editorCursor.foreground",
        &["editor.caret", "terminal.cursor"],
    ),
    ("editorGutter.background", &["editor.gutter.background"]),
    ("editorLineNumber.foreground", &["editor.gutter.foreground"]),
    (
        "editorLineNumber.activeForeground",
        &["editor.active_line.gutter_foreground"],
    ),
    (
        "editor.lineHighlightBackground",
        &["editor.active_line.background"],
    ),
    (
        "editor.selectionBackground",
        &["editor.selection.background", "selection.background"],
    ),
    (
        "editor.findMatchHighlightBackground",
        &["search.match.background"],
    ),
    (
        "editor.findMatchBackground",
        &["search.match.active_background"],
    ),
    (
        "editorBracketMatch.background",
        &["editor.match_bracket.background"],
    ),
    (
        "editorBracketMatch.border",
        &["editor.match_bracket.border"],
    ),
    (
        "scrollbarSlider.background",
        &["scrollbar.thumb.background"],
    ),
    (
        "scrollbarSlider.hoverBackground",
        &["scrollbar.thumb.hover"],
    ),
    ("sideBar.background", &["panel.background"]),
    ("input.background", &["panel.input.background"]),
    ("focusBorder", &["border.strong"]),
    ("list.hoverBackground", &["element.hover"]),
    (
        "list.activeSelectionBackground",
        &["element.selected", "element.active"],
    ),
    ("disabledForeground", &["text.disabled"]),
    ("editorError.foreground", &["status.error.foreground"]),
    ("editorWarning.foreground", &["status.warning.foreground"]),
    ("editorInfo.foreground", &["status.info.foreground"]),
    (
        "gitDecoration.addedResourceForeground",
        &["diff.added.text"],
    ),
    (
        "gitDecoration.deletedResourceForeground",
        &["diff.removed.text"],
    ),
    (
        "diffEditor.insertedTextBackground",
        &["diff.added.emphasis"],
    ),
    (
        "diffEditor.removedTextBackground",
        &["diff.removed.emphasis"],
    ),
    (
        "diffEditor.insertedLineBackground",
        &["diff.added.background"],
    ),
    (
        "diffEditor.removedLineBackground",
        &["diff.removed.background"],
    ),
    ("terminal.background", &["terminal.background"]),
    ("terminal.foreground", &["terminal.foreground"]),
    ("terminal.ansiBlack", &["terminal.ansi.black"]),
    ("terminal.ansiRed", &["terminal.ansi.red"]),
    ("terminal.ansiGreen", &["terminal.ansi.green"]),
    ("terminal.ansiYellow", &["terminal.ansi.yellow"]),
    ("terminal.ansiBlue", &["terminal.ansi.blue"]),
    ("terminal.ansiMagenta", &["terminal.ansi.magenta"]),
    ("terminal.ansiCyan", &["terminal.ansi.cyan"]),
    ("terminal.ansiWhite", &["terminal.ansi.white"]),
    ("terminal.ansiBrightBlack", &["terminal.ansi.bright_black"]),
    ("terminal.ansiBrightRed", &["terminal.ansi.bright_red"]),
    ("terminal.ansiBrightGreen", &["terminal.ansi.bright_green"]),
    (
        "terminal.ansiBrightYellow",
        &["terminal.ansi.bright_yellow"],
    ),
    ("terminal.ansiBrightBlue", &["terminal.ansi.bright_blue"]),
    (
        "terminal.ansiBrightMagenta",
        &["terminal.ansi.bright_magenta"],
    ),
    ("terminal.ansiBrightCyan", &["terminal.ansi.bright_cyan"]),
    ("terminal.ansiBrightWhite", &["terminal.ansi.bright_white"]),
];

/// Workbench key → shadcn base token. Runs after [`COLOR_MAP`] so the theme
/// keys are already in place and only the base layer is being invented.
const BASE_MAP: &[(&str, &str)] = &[
    ("editor.background", "background"),
    ("foreground", "foreground"),
    ("editorWidget.background", "card"),
    ("dropdown.background", "popover"),
    ("button.background", "primary"),
    ("button.foreground", "primary-foreground"),
    ("editorGroupHeader.tabsBackground", "secondary"),
    ("descriptionForeground", "muted-foreground"),
    ("list.hoverBackground", "accent"),
    ("list.activeSelectionForeground", "accent-foreground"),
    ("editorError.foreground", "destructive"),
    ("editorGroup.border", "border"),
    ("input.border", "input"),
    ("focusBorder", "ring"),
    ("sideBar.background", "sidebar"),
    ("sideBar.foreground", "sidebar-foreground"),
    ("sideBar.border", "sidebar-border"),
    ("textLink.foreground", "sidebar-primary"),
];

/// Representative TextMate scopes for each Atlas syntax key, most wanted first.
///
/// These are targets to *resolve*, not selectors to match: each is run through
/// VS Code's own "longest matching selector, last rule wins" rule against the
/// theme's `tokenColors`.
const SCOPE_TABLE: &[(&str, &[&str])] = &[
    (
        "syntax.comment",
        &["comment", "comment.line", "punctuation.definition.comment"],
    ),
    (
        "syntax.keyword",
        &[
            "keyword.control",
            "keyword",
            "storage.type",
            "storage.modifier",
        ],
    ),
    (
        "syntax.operator",
        &["keyword.operator", "keyword.operator.arithmetic"],
    ),
    ("syntax.string", &["string.quoted.double", "string"]),
    ("syntax.escape", &["constant.character.escape"]),
    ("syntax.regexp", &["string.regexp"]),
    ("syntax.number", &["constant.numeric"]),
    (
        "syntax.constant",
        &[
            "constant.other",
            "constant.language",
            "constant",
            "variable.language",
            "support.constant",
        ],
    ),
    (
        "syntax.type",
        &[
            "entity.name.type",
            "entity.name.class",
            "support.type",
            "support.class",
            "storage.type.class",
        ],
    ),
    (
        "syntax.function",
        &[
            "entity.name.function",
            "support.function",
            "meta.function-call",
        ],
    ),
    (
        "syntax.definition",
        &[
            "entity.name.function.definition",
            "entity.name",
            "entity.name.namespace",
        ],
    ),
    ("syntax.variable", &["variable.other.readwrite", "variable"]),
    (
        "syntax.property",
        &[
            "variable.other.property",
            "support.type.property-name",
            "meta.object-literal.key",
        ],
    ),
    ("syntax.tag", &["entity.name.tag"]),
    (
        "syntax.attribute",
        &[
            "entity.other.attribute-name",
            "meta.preprocessor",
            "keyword.control.directive",
        ],
    ),
];

/// `semanticTokenColors` type → Atlas syntax key. Only bare type names are
/// read; a selector with modifiers (`variable.readonly.defaultLibrary`) is a
/// conditional rule and applying it unconditionally would be wrong.
const SEMANTIC_MAP: &[(&str, &str)] = &[
    ("comment", "syntax.comment"),
    ("keyword", "syntax.keyword"),
    ("string", "syntax.string"),
    ("number", "syntax.number"),
    ("operator", "syntax.operator"),
    ("regexp", "syntax.regexp"),
    ("type", "syntax.type"),
    ("class", "syntax.type"),
    ("interface", "syntax.type"),
    ("struct", "syntax.type"),
    ("enum", "syntax.type"),
    ("typeParameter", "syntax.type"),
    ("namespace", "syntax.type"),
    ("function", "syntax.function"),
    ("method", "syntax.function"),
    ("macro", "syntax.attribute"),
    ("variable", "syntax.variable"),
    ("parameter", "syntax.variable"),
    ("property", "syntax.property"),
    ("enumMember", "syntax.constant"),
];

/// Ignored `colors` keys, grouped by the widget family they belong to.
const IGNORED_PREFIXES: &[(&str, &str, &str)] = &[
    (
        "editor.foldBackground",
        "editor furniture",
        "Atlas draws the fold placeholder from the secondary surface",
    ),
    (
        "activityBar",
        "app chrome",
        "Atlas's project rail follows the panel tokens",
    ),
    (
        "tab.",
        "app chrome",
        "Atlas's tab strip follows the accent and sidebar tokens",
    ),
    (
        "input.placeholderForeground",
        "text roles",
        "Atlas's placeholder follows muted-foreground",
    ),
    (
        "terminal.selectionBackground",
        "terminal",
        "Atlas derives the terminal selection from `primary`",
    ),
    ("minimap", "editor furniture", "Atlas has no minimap"),
    (
        "editorOverviewRuler",
        "editor furniture",
        "Atlas has no overview ruler",
    ),
    (
        "editorIndentGuide",
        "editor furniture",
        "Atlas draws no indent guides",
    ),
    ("editorRuler", "editor furniture", "Atlas draws no rulers"),
    (
        "editorWhitespace",
        "editor furniture",
        "Atlas does not render whitespace",
    ),
    (
        "editorCodeLens",
        "editor furniture",
        "Atlas has no code lens",
    ),
    (
        "editorInlayHint",
        "editor furniture",
        "Atlas has no inlay hints",
    ),
    (
        "editorLightBulb",
        "editor furniture",
        "Atlas has no light-bulb affordance",
    ),
    (
        "editorGhostText",
        "editor furniture",
        "Atlas has no ghost text",
    ),
    (
        "editorSuggestWidget",
        "widget",
        "Atlas's completions follow the popover tokens",
    ),
    (
        "editorHoverWidget",
        "widget",
        "Atlas's hovers follow the popover tokens",
    ),
    ("peekView", "widget", "Atlas has no peek view"),
    (
        "notification",
        "widget",
        "Atlas's toasts follow the popover tokens",
    ),
    (
        "quickInput",
        "widget",
        "Atlas's palettes follow the popover tokens",
    ),
    ("menu", "widget", "Atlas's menus follow the popover tokens"),
    ("breadcrumb", "widget", "Atlas has no breadcrumb bar"),
    ("debug", "widget", "Atlas has no debugger"),
    ("debugToolBar", "widget", "Atlas has no debugger"),
    ("debugConsole", "widget", "Atlas has no debugger"),
    ("testing", "widget", "Atlas has no test explorer"),
    (
        "merge",
        "vcs",
        "Atlas resolves conflicts through its own diff tokens",
    ),
    (
        "mergeEditor",
        "vcs",
        "Atlas resolves conflicts through its own diff tokens",
    ),
    (
        "gitDecoration",
        "vcs",
        "only added and deleted have an Atlas equivalent",
    ),
    (
        "scm",
        "vcs",
        "Atlas's source-control panel follows the panel tokens",
    ),
    (
        "statusBar",
        "app chrome",
        "Atlas's status bar follows the panel tokens",
    ),
    (
        "titleBar",
        "app chrome",
        "Atlas's title bar follows the panel tokens",
    ),
    (
        "activityBarBadge",
        "app chrome",
        "Atlas badges follow the status tokens",
    ),
    (
        "badge",
        "app chrome",
        "Atlas badges follow the status tokens",
    ),
    (
        "panelTitle",
        "app chrome",
        "Atlas panel titles follow the text tokens",
    ),
    (
        "panelSection",
        "app chrome",
        "Atlas panel sections follow the panel tokens",
    ),
    (
        "sideBarSectionHeader",
        "app chrome",
        "Atlas section headers follow the panel tokens",
    ),
    (
        "sideBarTitle",
        "app chrome",
        "Atlas section titles follow the text tokens",
    ),
    (
        "welcomePage",
        "app chrome",
        "Atlas has its own welcome screen",
    ),
    ("walkThrough", "app chrome", "Atlas has no walkthroughs"),
    (
        "settings",
        "app chrome",
        "Atlas's settings follow the app tokens",
    ),
    (
        "keybindingLabel",
        "app chrome",
        "Atlas's Kbd primitive follows the base tokens",
    ),
    (
        "notebook",
        "editor furniture",
        "Atlas has no notebook editor",
    ),
    (
        "charts",
        "widget",
        "Atlas charts use the chart-1…chart-5 base tokens",
    ),
    (
        "symbolIcon",
        "icon roles",
        "Atlas icons take their color from the text roles",
    ),
    (
        "icon",
        "icon roles",
        "Atlas icons take their color from the text roles",
    ),
    (
        "problemsErrorIcon",
        "icon roles",
        "Atlas icons take their color from the text roles",
    ),
    (
        "terminalCommandDecoration",
        "terminal",
        "Atlas's terminal draws no command decorations",
    ),
    (
        "terminalOverviewRuler",
        "terminal",
        "Atlas's terminal has no overview ruler",
    ),
    (
        "terminalStickyScroll",
        "terminal",
        "Atlas's terminal has no sticky scroll",
    ),
];

/// A VS Code theme file, after `include` has been resolved.
pub(crate) struct Resolved {
    pub value: Value,
    /// Files pulled in through `include`, outermost last.
    pub includes: Vec<String>,
    /// `include` targets that could not be read, e.g. on a pasted theme.
    pub unresolved: Vec<String>,
}

pub(crate) fn import(
    resolved: Resolved,
    options: &ImportOptions,
) -> Result<Vec<ImportedTheme>, ThemeError> {
    let root = resolved.value;
    let colors = root
        .get("colors")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let token_colors = root
        .get("tokenColors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let semantic = root
        .get("semanticTokenColors")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if colors.is_empty() && token_colors.is_empty() {
        return Err(crate::validation(
            &options.origin,
            "no usable colors: a VS Code theme needs `colors` or `tokenColors`",
        ));
    }

    let name = root
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("VS Code theme")
        .to_string();
    let appearance: &'static str = match root.get("type").and_then(Value::as_str) {
        Some("light") | Some("hc-light") => "light",
        Some(_) => "dark",
        // No `type` at all: judge it by the editor background, which is the one
        // colour every theme sets.
        None => match colors
            .get("editor.background")
            .and_then(Value::as_str)
            .and_then(crate::color::is_dark)
        {
            Some(false) => "light",
            _ => "dark",
        },
    };

    let mut report = ImportReport::new("vscode", name.clone(), Fidelity::Lossy);
    for include in &resolved.includes {
        report.note(format!("resolved `include`: {include}"));
    }
    for include in &resolved.unresolved {
        report.warn(format!(
            "`include: {include}` could not be read, so the colors it would have supplied are missing — import from the theme file on disk to resolve it"
        ));
    }
    if root.get("type").is_none() {
        report.note(format!(
            "no `type` field; the appearance was judged from editor.background as {appearance}"
        ));
    }

    let mut draft = VariantDraft::new(appearance);
    let mut used: BTreeSet<String> = BTreeSet::new();
    for (source, targets) in COLOR_MAP {
        let Some(value) = colors.get(*source).and_then(Value::as_str) else {
            continue;
        };
        let mut landed = false;
        for target in *targets {
            landed |= draft.map_color_key(target, source, value);
        }
        if landed {
            used.insert((*source).to_string());
        }
    }
    let semantic_used = map_semantic(&semantic, &mut draft, &mut report);
    map_token_colors(&token_colors, &mut draft, &mut report);

    draft.fill_palette();
    for (source, token) in BASE_MAP {
        if let Some(value) = colors.get(*source).and_then(Value::as_str) {
            if draft.map_base(token, source, value) {
                used.insert((*source).to_string());
            }
        }
    }
    draft.fill_required_base();

    record_ignored(&colors, &used, &mut report);
    if !semantic.is_empty() {
        let skipped = semantic.len() - semantic_used;
        if skipped > 0 {
            report.ignore(
                format!("semanticTokenColors ({skipped} selectors)"),
                "semantic tokens",
                "only bare token types are read; a selector with modifiers is conditional and cannot be applied unconditionally",
            );
        }
    }
    report.note(
        "a VS Code theme is a starting point, not a copy: it describes a workbench Atlas does not have, and Atlas's chrome (panels, tabs, comms, agent chips) is derived rather than stated",
    );

    let scoped = ImportOptions {
        origin: options.origin.clone(),
        id_hint: options.id_hint.clone(),
        name_hint: options.name_hint.clone().or(Some(name)),
        author_hint: options.author_hint.clone(),
        license_hint: options.license_hint.clone(),
    };
    finish_theme(vec![draft], report, &scoped).map(|theme| vec![theme])
}

fn map_semantic(
    semantic: &Map<String, Value>,
    draft: &mut VariantDraft,
    report: &mut ImportReport,
) -> usize {
    let mut used = 0;
    for (selector, value) in semantic {
        let Some(target) = SEMANTIC_MAP
            .iter()
            .find(|(name, _)| name == selector)
            .map(|(_, key)| *key)
        else {
            continue;
        };
        let (color, italic) = match value {
            Value::String(color) => (Some(color.clone()), false),
            Value::Object(entry) => (
                entry
                    .get("foreground")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                entry
                    .get("fontStyle")
                    .and_then(Value::as_str)
                    .is_some_and(|style| style.contains("italic")),
            ),
            _ => (None, false),
        };
        let Some(color) = color else { continue };
        if draft.map_key(
            target,
            &format!("semanticTokenColors.{selector}"),
            ThemeKeyValue::Color(color),
        ) {
            used += 1;
            if italic {
                report.ignore(
                    format!("semanticTokenColors.{selector}.fontStyle"),
                    "font styles",
                    FONT_STYLE_REASON,
                );
            }
        }
    }
    used
}

/// Said the same way wherever a `fontStyle` is dropped, so the report groups
/// them into one line rather than several near-identical ones.
const FONT_STYLE_REASON: &str =
    "an Atlas theme key carries a color only; the scope is imported with its color and no italics";

/// One `tokenColors` rule, flattened.
struct Rule {
    scopes: Vec<String>,
    foreground: Option<String>,
    italic: bool,
    /// Position in the file: later wins a specificity tie, as in VS Code.
    order: usize,
}

fn map_token_colors(token_colors: &[Value], draft: &mut VariantDraft, report: &mut ImportReport) {
    let rules: Vec<Rule> = token_colors
        .iter()
        .enumerate()
        .map(|(order, entry)| Rule {
            scopes: match entry.get("scope") {
                Some(Value::String(scope)) => scope
                    .split(',')
                    .map(|part| part.trim().to_string())
                    .filter(|part| !part.is_empty())
                    .collect(),
                Some(Value::Array(list)) => list
                    .iter()
                    .filter_map(Value::as_str)
                    .flat_map(|scope| scope.split(',').map(|part| part.trim().to_string()))
                    .filter(|part| !part.is_empty())
                    .collect(),
                // A rule with no scope is the theme's default foreground.
                _ => Vec::new(),
            },
            foreground: entry
                .get("settings")
                .and_then(|settings| settings.get("foreground"))
                .and_then(Value::as_str)
                .map(str::to_string),
            italic: entry
                .get("settings")
                .and_then(|settings| settings.get("fontStyle"))
                .and_then(Value::as_str)
                .is_some_and(|style| style.contains("italic")),
            order,
        })
        .collect();

    let mut matched_scopes = BTreeSet::new();
    let mut italicised = BTreeSet::new();
    for (target, candidates) in SCOPE_TABLE {
        for candidate in *candidates {
            let Some(rule) = best_rule(&rules, candidate) else {
                continue;
            };
            let Some(color) = rule.foreground.clone() else {
                continue;
            };
            if draft.map_key(
                target,
                &format!("tokenColors[{candidate}]"),
                ThemeKeyValue::Color(color),
            ) {
                matched_scopes.insert((*candidate).to_string());
                if rule.italic {
                    italicised.insert((*candidate).to_string());
                }
                break;
            }
        }
    }
    for scope in &italicised {
        report.ignore(
            format!("tokenColors[{scope}].fontStyle"),
            "font styles",
            FONT_STYLE_REASON,
        );
    }

    // A rule whose every selector is a markup/diff/plain-text scope has no
    // Atlas home at all; the rest are simply finer than Atlas's syntax roles
    // (see SCOPE_TABLE).
    let unused = rules
        .iter()
        .filter(|rule| !rule.scopes.is_empty())
        .filter(|rule| {
            !rule.scopes.iter().any(|scope| {
                matched_scopes
                    .iter()
                    .any(|matched| matched == scope || matched.starts_with(&format!("{scope}.")))
            })
        })
        .count();
    if unused > 0 {
        report.ignore(
            format!("tokenColors ({unused} rules)"),
            "textmate scopes",
            "grammar-specific and markup scopes have no equivalent among Atlas's syntax roles (see SCOPE_TABLE)",
        );
    }
}

/// VS Code's own resolution, for one target scope: the longest selector that is
/// a dotted prefix of it, later rules winning a tie.
fn best_rule<'a>(rules: &'a [Rule], target: &str) -> Option<&'a Rule> {
    let mut best: Option<(usize, usize, &Rule)> = None;
    for rule in rules {
        for scope in &rule.scopes {
            // Descendant selectors (`meta.tag entity.name`) are a context rule;
            // only the rightmost element is the scope being coloured.
            let selector = scope.split_whitespace().next_back().unwrap_or(scope);
            if !(target == selector || target.starts_with(&format!("{selector}."))) {
                continue;
            }
            let specificity = selector.split('.').count();
            let better = best.is_none_or(|(best_specificity, best_order, _)| {
                specificity > best_specificity
                    || (specificity == best_specificity && rule.order >= best_order)
            });
            if better {
                best = Some((specificity, rule.order, rule));
            }
        }
    }
    best.map(|(_, _, rule)| rule)
}

fn record_ignored(colors: &Map<String, Value>, used: &BTreeSet<String>, report: &mut ImportReport) {
    let mut counted: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    let mut unknown = 0usize;
    for key in colors.keys() {
        if used.contains(key) {
            continue;
        }
        match IGNORED_PREFIXES
            .iter()
            .filter(|(prefix, _, _)| key == prefix || key.starts_with(&format!("{prefix}.")))
            .max_by_key(|(prefix, _, _)| prefix.len())
        {
            Some((_, category, reason)) => *counted.entry((category, reason)).or_default() += 1,
            None => unknown += 1,
        }
    }
    for ((category, reason), count) in counted {
        report.ignore(format!("{count} {category} key(s)"), category, reason);
    }
    if unknown > 0 {
        report.ignore(
            format!("{unknown} workbench key(s)"),
            "workbench chrome",
            "widgets and surfaces Atlas does not have",
        );
    }
}
