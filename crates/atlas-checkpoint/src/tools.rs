//! Turning what the wire says into something you can `GROUP BY`.
//!
//! The session-detail sidebar shows live counts — *Tool calls 4 · File edits 1 ·
//! Bash 1 · Read 2* — and those have to resolve to a query. The obstacle is that
//! **the wire has no canonical tool name**. ACP carries `toolCallId`, `title`,
//! `kind`, `status`, `content`, `locations` and `rawInput`; there is no field
//! holding "Bash". What the runtime exposes as `tool_name` is the first-sighting
//! *title*, and the two agent families put very different things there:
//!
//! * the **native agent** emits the real tool name as the title (`"Read"`,
//!   `"Bash"`), so its first sighting is already canonical;
//! * **ACP agents** emit a human display string (`"Edit src/foo.rs"`,
//!   `"Bash(cargo test)"`, `"Read /Users/…/lib.rs"`).
//!
//! So the canonical name is *derived*, deliberately and testably, and stored in
//! its own column beside the display title. Grouping by the raw wire value would
//! produce one bucket per file the agent touched, which is not a count of
//! anything.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The canonical tool names the sidebar groups by.
///
/// A closed set on purpose: it is a *facet*, and a facet whose values are
/// whatever an agent happened to call something is not a facet. Anything that
/// does not map lands in [`ToolName::Other`], which is honest and countable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    Read,
    Edit,
    Write,
    Bash,
    Search,
    Fetch,
    Delete,
    Move,
    Think,
    Task,
    Other,
}

impl ToolName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "Read",
            Self::Edit => "Edit",
            Self::Write => "Write",
            Self::Bash => "Bash",
            Self::Search => "Search",
            Self::Fetch => "Fetch",
            Self::Delete => "Delete",
            Self::Move => "Move",
            Self::Think => "Think",
            Self::Task => "Task",
            Self::Other => "Other",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "Read" => Some(Self::Read),
            "Edit" => Some(Self::Edit),
            "Write" => Some(Self::Write),
            "Bash" => Some(Self::Bash),
            "Search" => Some(Self::Search),
            "Fetch" => Some(Self::Fetch),
            "Delete" => Some(Self::Delete),
            "Move" => Some(Self::Move),
            "Think" => Some(Self::Think),
            "Task" => Some(Self::Task),
            "Other" => Some(Self::Other),
            _ => None,
        }
    }

    /// Does a call by this name write to a file?
    ///
    /// One of the two things that make a `file_touch` expected, and the weaker
    /// of them: the name is DERIVED, from a title and a `kind` token an adapter
    /// picks freely. A call carrying a diff block has said it edits a file
    /// outright, so capture treats that as sufficient on its own and this
    /// answer is not the last word.
    pub fn writes_files(self) -> bool {
        matches!(self, Self::Edit | Self::Write | Self::Delete | Self::Move)
    }
}

/// Derive the canonical name from everything the wire actually gives us.
///
/// Ordered by how much each source can be trusted:
///
/// 1. An explicit name in the arguments. Some agents put `tool_name`/`name`
///    there, and an agent naming itself beats any inference.
/// 2. The leading token of the title, when it is a name we know. This is what
///    catches the native agent (whose title *is* the name) and, incidentally,
///    Claude Code's `"Bash(cargo test)"` / `"Edit src/foo.rs"` shapes.
/// 3. The ACP `kind`, refined by the shape of the arguments — the only signal
///    available for an agent whose titles are pure prose.
pub fn canonical_name(
    wire_name: Option<&str>,
    title: Option<&str>,
    kind: Option<&str>,
    arguments: &serde_json::Value,
) -> ToolName {
    if let Some(explicit) = arguments
        .get("tool_name")
        .or_else(|| arguments.get("toolName"))
        .or_else(|| arguments.get("name"))
        .and_then(serde_json::Value::as_str)
    {
        if let Some(name) = match_known(explicit) {
            return name;
        }
    }

    // A call whose arguments carry a `command` string IS a shell call,
    // whatever its title's first word happens to be. Adapters title these
    // with the command line itself, and a command line is prose: a heredoc
    // write leads with "cat", which is a Read alias — so the call that WROTE
    // AND COMMITTED a file was classified as a read and never sampled for
    // writes. The argument shape outranks the title because it cannot be
    // prose.
    if arguments.get("command").and_then(serde_json::Value::as_str).is_some() {
        return ToolName::Bash;
    }

    // `wire_name` is the runtime's first-sighting value, which for the native
    // agent is the tool's real name.
    for candidate in [wire_name, title].into_iter().flatten() {
        if let Some(name) = match_known(leading_token(candidate)) {
            return name;
        }
    }

    from_kind(kind, arguments)
}

/// The first word of a title, stopping at the punctuation agents use to append
/// their argument: `"Bash(cargo test)"` → `Bash`, `"Edit src/foo.rs"` → `Edit`.
fn leading_token(title: &str) -> &str {
    title
        .trim()
        .split(|c: char| c.is_whitespace() || matches!(c, '(' | ':' | '[' | '<'))
        .next()
        .unwrap_or("")
}

/// Case-insensitive match against the canonical set, plus the aliases the three
/// agents actually use.
fn match_known(raw: &str) -> Option<ToolName> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "read" | "readfile" | "view" | "cat" => Some(ToolName::Read),
        "edit" | "multiedit" | "str_replace" | "str_replace_editor" | "apply_patch"
        | "applypatch" | "patch" | "notebookedit" => Some(ToolName::Edit),
        "write" | "writefile" | "create" | "create_file" | "createfile" => Some(ToolName::Write),
        "bash" | "shell" | "exec" | "execute" | "run" | "powershell" | "terminal" => {
            Some(ToolName::Bash)
        }
        "grep" | "glob" | "search" | "find" | "list" | "ls" | "codebase_search" => {
            Some(ToolName::Search)
        }
        "fetch" | "webfetch" | "websearch" | "web" | "browse" => Some(ToolName::Fetch),
        "delete" | "rm" | "remove" => Some(ToolName::Delete),
        "move" | "mv" | "rename" => Some(ToolName::Move),
        "think" | "thinking" | "reason" => Some(ToolName::Think),
        "task" | "agent" | "subagent" | "dispatch" => Some(ToolName::Task),
        _ => None,
    }
}

/// The fallback: ACP's category, sharpened by what the arguments look like.
///
/// `kind = "edit"` covers both editing an existing file and creating a new one,
/// and the sidebar distinguishes them — so the argument shape breaks the tie.
fn from_kind(kind: Option<&str>, arguments: &serde_json::Value) -> ToolName {
    match kind.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "read" => ToolName::Read,
        "edit" => {
            // An edit names what it is replacing; a write only carries content.
            let replaces = ["old_string", "oldText", "old_str", "diff", "patch"]
                .iter()
                .any(|key| arguments.get(key).is_some());
            if replaces {
                ToolName::Edit
            } else if arguments.get("content").is_some() || arguments.get("new_str").is_some() {
                ToolName::Write
            } else {
                ToolName::Edit
            }
        }
        "execute" => ToolName::Bash,
        "search" => ToolName::Search,
        "fetch" => ToolName::Fetch,
        "delete" => ToolName::Delete,
        "move" => ToolName::Move,
        "think" => ToolName::Think,
        _ => ToolName::Other,
    }
}

/// A path an agent touched, resolved against the Workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPath {
    /// NFC-normalised and workspace-relative when inside the Workspace;
    /// otherwise the path as given.
    pub path: String,
    /// The agent wrote outside the Workspace root (`../../etc/hosts`, somewhere
    /// in `~`). Recorded rather than dropped, and flagged so the link rule knows
    /// it can never match a commit and does not count it as pending agent work
    /// forever.
    pub out_of_repo: bool,
}

/// Resolve a path the agent reported against the Workspace root.
///
/// Two normalisations, both of which exist because their failure mode is a
/// **silently missing Checkpoint** rather than an error anyone sees:
///
/// * **Unicode form.** macOS hands back filenames in NFD; git stores NFC. A byte
///   comparison of the two forms of the same name simply fails, no Checkpoint
///   forms, and nothing is logged.
/// * **Separators and `.` / `..` segments.** The link rule compares against
///   git's stored path, which is always `/`-separated and always minimal.
pub fn resolve_path(raw: &str, workspace_root: &Path) -> ResolvedPath {
    let candidate = PathBuf::from(raw);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    };

    let cleaned = lexically_normalize(&absolute);
    match cleaned.strip_prefix(lexically_normalize(workspace_root)) {
        Ok(relative) => ResolvedPath {
            path: nfc(&to_slash(relative)),
            out_of_repo: false,
        },
        Err(_) => ResolvedPath {
            path: nfc(&to_slash(&cleaned)),
            out_of_repo: true,
        },
    }
}

/// Collapse `.` and `..` without touching the filesystem.
///
/// Deliberately lexical: `std::fs::canonicalize` resolves symlinks and requires
/// the file to exist, and by the time a turn is recorded the agent may have
/// deleted it. Resolving symlinks would also rewrite paths git knows by their
/// symlinked name, which is the opposite of what the link rule needs.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn to_slash(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Normalise to Unicode NFC.
///
/// Implemented for the case that actually bites — macOS decomposing a base
/// letter plus a combining accent (NFD) where git stores the precomposed form
/// (NFC) — without pulling in a full Unicode normalisation crate for a path
/// comparison. Anything outside that range is passed through unchanged, so the
/// worst case is the status quo rather than a mangled path.
fn nfc(value: &str) -> String {
    if value.is_ascii() {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(base) = chars.next() {
        match chars.peek().copied().and_then(|mark| compose(base, mark)) {
            Some(composed) => {
                chars.next();
                out.push(composed);
            }
            None => out.push(base),
        }
    }
    out
}

/// Compose a base character with a following combining mark, for the Latin-1
/// range that appears in real filenames.
fn compose(base: char, mark: char) -> Option<char> {
    let combined = match mark {
        // Combining acute, grave, circumflex, tilde, diaeresis, cedilla, ring.
        '\u{0301}' | '\u{0300}' | '\u{0302}' | '\u{0303}' | '\u{0308}' | '\u{0327}'
        | '\u{030A}' => (base, mark),
        _ => return None,
    };
    let (base, mark) = combined;
    let composed = match (base, mark) {
        ('a', '\u{0301}') => 'á',
        ('e', '\u{0301}') => 'é',
        ('i', '\u{0301}') => 'í',
        ('o', '\u{0301}') => 'ó',
        ('u', '\u{0301}') => 'ú',
        ('a', '\u{0300}') => 'à',
        ('e', '\u{0300}') => 'è',
        ('a', '\u{0302}') => 'â',
        ('e', '\u{0302}') => 'ê',
        ('o', '\u{0302}') => 'ô',
        ('a', '\u{0303}') => 'ã',
        ('n', '\u{0303}') => 'ñ',
        ('o', '\u{0303}') => 'õ',
        ('a', '\u{0308}') => 'ä',
        ('e', '\u{0308}') => 'ë',
        ('i', '\u{0308}') => 'ï',
        ('o', '\u{0308}') => 'ö',
        ('u', '\u{0308}') => 'ü',
        ('c', '\u{0327}') => 'ç',
        ('a', '\u{030A}') => 'å',
        ('A', '\u{0301}') => 'Á',
        ('E', '\u{0301}') => 'É',
        ('O', '\u{0301}') => 'Ó',
        ('U', '\u{0308}') => 'Ü',
        ('C', '\u{0327}') => 'Ç',
        ('N', '\u{0303}') => 'Ñ',
        _ => return None,
    };
    Some(composed)
}

/// Pull file paths out of a tool call, preferring the pre-extracted locations.
///
/// Three sources, in descending order of how directly the agent said "this
/// file": its `locations`, the paths named by the call's diff content blocks,
/// then a path-shaped key in its arguments.
///
/// The middle one is not optional. ACP's `locations` are a SHOULD, not a MUST,
/// and real adapters skip them: codex acp and cursor acp both report an edit
/// with `locations: []` and no `rawInput`, naming the file only in the diff
/// block. Reading just the first and last source recorded no write for those
/// calls, so the Session nominated no paths and no commit could ever link to
/// it — Timeline entries appeared, checkpoints never did.
///
/// Never goes through the title-derived name: a title is prose, and parsing a
/// path out of prose is how you end up recording `src/foo.rs,` with a comma.
pub fn extract_paths(
    locations: &[serde_json::Value],
    diff_paths: &[String],
    arguments: &serde_json::Value,
) -> Vec<String> {
    let mut out = Vec::new();

    // ACP hands these over already extracted — the structural advantage over
    // reconstructing them from a private transcript format.
    for location in locations {
        if let Some(path) = location.get("path").and_then(serde_json::Value::as_str) {
            if !path.trim().is_empty() {
                out.push(path.to_string());
            }
        }
    }

    if out.is_empty() {
        // Also structural: the agent attached a diff FOR this file. Every block
        // counts — one call editing three files must nominate all three, or the
        // commit links to part of its own work.
        out.extend(
            diff_paths
                .iter()
                .filter(|path| !path.trim().is_empty())
                .cloned(),
        );
    }

    if out.is_empty() {
        for key in ["file_path", "path", "filePath", "target_file", "file", "notebook_path"] {
            if let Some(path) = arguments.get(key).and_then(serde_json::Value::as_str) {
                if !path.trim().is_empty() {
                    out.push(path.to_string());
                    break;
                }
            }
        }
    }

    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(json: serde_json::Value) -> serde_json::Value {
        json
    }

    // ── Canonical name, per agent family ────────────────────────────────────

    /// The user's real repro: claude acp writes a file with a `cat` heredoc
    /// and commits, in one call titled with the COMMAND LINE. Its first word
    /// is "cat" — a Read alias — so the call that wrote and committed was
    /// classified as a read and never sampled for writes. A `command`
    /// argument is a shell call, whatever the title says.
    #[test]
    fn a_command_argument_makes_the_call_shell_shaped_whatever_the_title_leads_with() {
        for title in [
            "cat > test.txt <<'EOF'\ntest\nEOF\ngit add test.txt",
            "head -5 build.log",
            "find . -name '*.rs'",
        ] {
            assert_eq!(
                canonical_name(
                    Some(title),
                    Some(title),
                    Some("execute"),
                    &args(serde_json::json!({ "command": title })),
                ),
                ToolName::Bash,
                "title {title:?} must not out-vote the command argument"
            );
        }
    }

    /// …but an explicit name in the arguments still wins over everything,
    /// and a call WITHOUT a command argument keeps the title-token behaviour.
    #[test]
    fn the_command_rule_does_not_disturb_the_other_sources() {
        assert_eq!(
            canonical_name(
                None,
                None,
                None,
                &args(serde_json::json!({ "name": "read", "command": "irrelevant" })),
            ),
            ToolName::Read,
            "an explicit name is the agent naming itself"
        );
        assert_eq!(
            canonical_name(Some("Read"), Some("Read"), None, &args(serde_json::json!({}))),
            ToolName::Read
        );
    }

    #[test]
    fn the_native_agent_titles_are_already_canonical() {
        // It emits the real tool name as the title.
        for (title, expected) in [
            ("Read", ToolName::Read),
            ("Bash", ToolName::Bash),
            ("Edit", ToolName::Edit),
            ("Grep", ToolName::Search),
            ("WebFetch", ToolName::Fetch),
        ] {
            assert_eq!(
                canonical_name(Some(title), Some(title), None, &args(serde_json::json!({}))),
                expected,
                "native agent title {title}"
            );
        }
    }

    #[test]
    fn claude_code_display_titles_reduce_to_their_leading_token() {
        for (title, kind, expected) in [
            ("Bash(cargo test --package atlas-review)", "execute", ToolName::Bash),
            ("Read /Users/nafiz/dev/atlas/src/lib.rs", "read", ToolName::Read),
            ("Edit src/rate_limit.rs", "edit", ToolName::Edit),
        ] {
            assert_eq!(
                canonical_name(Some(title), Some(title), Some(kind), &args(serde_json::json!({}))),
                expected,
                "title {title}"
            );
        }
    }

    #[test]
    fn a_prose_title_falls_back_to_the_acp_kind() {
        // Codex-style: the title is a sentence, so only `kind` is usable.
        assert_eq!(
            canonical_name(
                Some("Running the test suite"),
                Some("Running the test suite"),
                Some("execute"),
                &args(serde_json::json!({}))
            ),
            ToolName::Bash
        );
        assert_eq!(
            canonical_name(
                Some("Looking at the rate limiter"),
                Some("Looking at the rate limiter"),
                Some("read"),
                &args(serde_json::json!({}))
            ),
            ToolName::Read
        );
    }

    #[test]
    fn the_edit_kind_is_split_into_edit_and_write_by_argument_shape() {
        // ACP has one `edit` kind for both, and the sidebar distinguishes them.
        assert_eq!(
            canonical_name(
                Some("Modifying the limiter"),
                None,
                Some("edit"),
                &args(serde_json::json!({ "old_string": "a", "new_string": "b" }))
            ),
            ToolName::Edit
        );
        assert_eq!(
            canonical_name(
                Some("Creating the limiter"),
                None,
                Some("edit"),
                &args(serde_json::json!({ "content": "fn main() {}" }))
            ),
            ToolName::Write
        );
    }

    #[test]
    fn an_explicit_name_in_the_arguments_wins() {
        assert_eq!(
            canonical_name(
                Some("Some prose title"),
                None,
                Some("other"),
                &args(serde_json::json!({ "tool_name": "Bash" }))
            ),
            ToolName::Bash
        );
    }

    #[test]
    fn an_unrecognised_call_is_other_rather_than_a_new_bucket() {
        assert_eq!(
            canonical_name(Some("Frobnicate the widget"), None, None, &args(serde_json::json!({}))),
            ToolName::Other
        );
    }

    #[test]
    fn only_file_writing_names_expect_a_file_touch() {
        assert!(ToolName::Edit.writes_files());
        assert!(ToolName::Write.writes_files());
        assert!(ToolName::Delete.writes_files());
        assert!(!ToolName::Read.writes_files());
        assert!(!ToolName::Bash.writes_files());
    }

    // ── Path resolution ─────────────────────────────────────────────────────

    #[test]
    fn an_absolute_path_inside_the_workspace_becomes_relative() {
        let resolved = resolve_path("/tmp/project/src/lib.rs", Path::new("/tmp/project"));
        assert_eq!(resolved.path, "src/lib.rs");
        assert!(!resolved.out_of_repo);
    }

    #[test]
    fn a_relative_path_is_taken_as_workspace_relative() {
        let resolved = resolve_path("src/lib.rs", Path::new("/tmp/project"));
        assert_eq!(resolved.path, "src/lib.rs");
        assert!(!resolved.out_of_repo);
    }

    #[test]
    fn dot_segments_are_collapsed() {
        let resolved = resolve_path("./src/../src/lib.rs", Path::new("/tmp/project"));
        assert_eq!(resolved.path, "src/lib.rs");
    }

    #[test]
    fn a_path_escaping_the_workspace_is_flagged_rather_than_dropped() {
        // Flagged, because the link rule must know it can never match a commit —
        // and dropping it would leave it looking like pending agent work forever.
        let resolved = resolve_path("../../etc/hosts", Path::new("/tmp/project"));
        assert!(resolved.out_of_repo);
        assert!(resolved.path.contains("etc/hosts"), "{}", resolved.path);
    }

    #[test]
    fn an_absolute_path_elsewhere_is_flagged() {
        let resolved = resolve_path("/Users/nafiz/.zshrc", Path::new("/tmp/project"));
        assert!(resolved.out_of_repo);
    }

    #[test]
    fn a_decomposed_filename_normalises_to_the_form_git_stores() {
        // macOS hands back NFD; git stores NFC. Comparing the two byte-wise
        // fails silently and no Checkpoint ever forms.
        let nfd = "src/cafe\u{0301}.rs";
        let resolved = resolve_path(nfd, Path::new("/tmp/project"));
        assert_eq!(resolved.path, "src/café.rs");
        // And the already-composed form is left as it is.
        assert_eq!(
            resolve_path("src/café.rs", Path::new("/tmp/project")).path,
            "src/café.rs"
        );
    }

    #[test]
    fn ascii_paths_are_untouched_by_normalisation() {
        assert_eq!(nfc("src/lib.rs"), "src/lib.rs");
    }

    // ── Path extraction ─────────────────────────────────────────────────────

    #[test]
    fn locations_are_preferred_over_the_arguments() {
        let paths = extract_paths(
            &[serde_json::json!({ "path": "/tmp/project/src/a.rs" })],
            &[],
            &args(serde_json::json!({ "file_path": "/tmp/project/src/b.rs" })),
        );
        assert_eq!(paths, vec!["/tmp/project/src/a.rs"]);
    }

    #[test]
    fn the_arguments_are_the_fallback_when_no_location_arrived() {
        let paths = extract_paths(&[], &[], &args(serde_json::json!({ "file_path": "src/b.rs" })));
        assert_eq!(paths, vec!["src/b.rs"]);
    }

    #[test]
    fn a_call_with_no_usable_location_yields_nothing_rather_than_failing() {
        assert!(
            extract_paths(&[], &[], &args(serde_json::json!({ "command": "cargo test" }))).is_empty()
        );
    }

    #[test]
    fn several_locations_are_all_extracted() {
        let paths = extract_paths(
            &[
                serde_json::json!({ "path": "src/a.rs" }),
                serde_json::json!({ "path": "src/b.rs" }),
            ],
            &[],
            &args(serde_json::json!({})),
        );
        assert_eq!(paths, vec!["src/a.rs", "src/b.rs"]);
    }

    /// The shape that broke Timeline capture, taken from real captured rows.
    ///
    /// codex acp and cursor acp both report an edit with `locations: []` and no
    /// `rawInput` at all — the ONLY place the file is named is the call's diff
    /// content block. Without reading that, the write is never recorded, the
    /// Session nominates no paths, and no commit can ever link to it: the
    /// Session produces Timeline entries but never a checkpoint.
    #[test]
    fn a_diff_block_names_the_file_when_the_agent_sent_no_location() {
        let paths = extract_paths(
            &[],
            &["/Users/dev/project/index.html".to_string()],
            &args(serde_json::Value::Null),
        );
        assert_eq!(paths, vec!["/Users/dev/project/index.html"]);
    }

    /// Pre-extracted locations still win: they are the agent's own answer to
    /// "which files", and a diff block is one block of possibly several.
    #[test]
    fn locations_are_preferred_over_a_diff_block() {
        let paths = extract_paths(
            &[serde_json::json!({ "path": "src/a.rs" })],
            &["src/b.rs".to_string()],
            &args(serde_json::json!({})),
        );
        assert_eq!(paths, vec!["src/a.rs"]);
    }

    /// A diff block is structural — the agent named the file it edited — so it
    /// beats sniffing a path-shaped key out of free-form arguments.
    #[test]
    fn a_diff_block_is_preferred_over_the_arguments() {
        let paths = extract_paths(
            &[],
            &["src/a.rs".to_string()],
            &args(serde_json::json!({ "file_path": "src/b.rs" })),
        );
        assert_eq!(paths, vec!["src/a.rs"]);
    }

    /// A blank path is not a file. It must not become a touch, and it must not
    /// stop the arguments from being consulted either.
    #[test]
    fn a_blank_diff_path_is_not_a_file() {
        assert!(extract_paths(&[], &["   ".to_string()], &args(serde_json::Value::Null)).is_empty());
        assert_eq!(
            extract_paths(
                &[],
                &["".to_string()],
                &args(serde_json::json!({ "file_path": "src/b.rs" })),
            ),
            vec!["src/b.rs"]
        );
    }

    /// One call may edit several files, and every one of them has to nominate
    /// the Session or the commit links to only part of its own work.
    #[test]
    fn every_diff_block_in_a_call_is_extracted() {
        let paths = extract_paths(
            &[],
            &["src/a.rs".to_string(), "src/b.rs".to_string()],
            &args(serde_json::Value::Null),
        );
        assert_eq!(paths, vec!["src/a.rs", "src/b.rs"]);
    }
}
