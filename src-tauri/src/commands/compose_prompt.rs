//! `compose_prompt` — turn (user prose, list of @-mentions) into the
//! final wire string sent to the agent.
//!
//! Used to live in `src/features/chat/lib/mentions.ts::composePrompt`:
//! N sequential `invoke("read_file_content")` calls (one IPC per
//! mention) + JS string assembly. For a message with 5 mentions
//! that's 5 round-trips JS → Tauri → file read → IPC → JS before the
//! agent even sees the prompt.
//!
//! Now: one Tauri command. File reads fan out in parallel on the
//! tokio blocking pool, the wire string is assembled in Rust, the
//! frontend just ships `(prose, mentions[])` and awaits the composed
//! result. Net IPC roundtrips per send: 1 (was N+1).

use std::path::Path;

use serde::Deserialize;

use crate::commands::org_server::OrgLink;

/// Cap how much body content a single mention can dump into the
/// context block. Tuned for chat agents: ~32 KB is enough for a
/// medium source file.
const MENTION_BODY_BUDGET_BYTES: usize = 32 * 1024;

/// Discriminated mention spec — mirrors the TS `MentionData` union
/// in `src/features/chat/lib/mentions.ts`. `kind` is the tag; field
/// names use camelCase on the wire (TS source of truth). Fields the
/// Rust side doesn't need (e.g. branch metadata, paper authors that
/// only display) are still accepted but ignored where appropriate.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[allow(dead_code)]
pub enum MentionSpec {
    File {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Folder {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Symbol {
        id: String,
        display_name: String,
        signature: String,
        symbol_kind: String,
        file_path: String,
        line: u32,
    },
    Knowledge {
        id: String,
        display_name: String,
        file_path: String,
        /// The frontend already has the entry body in the knowledge
        /// store; passing it here avoids a redundant disk read. When
        /// absent we fall back to reading `file_path`.
        #[serde(default)]
        inline_body: Option<String>,
    },
    /// A pack-delivered component invoked with `#<kind>:<name>` — `command`,
    /// `agent`, or `rule`. Its body (frontmatter stripped) is inlined as a
    /// context block so it reaches any ACP agent. The frontend pre-fills
    /// `inline_body`; `file_path` is the read fallback.
    Component {
        id: String,
        display_name: String,
        component_kind: String,
        file_path: String,
        #[serde(default)]
        inline_body: Option<String>,
    },
    Repo {
        id: String,
        display_name: String,
        abs_path: String,
        has_readme: bool,
    },
    /// Another project in the app, referenced with `@workspace:<name>`.
    /// Hands the agent that project's absolute path so it can inspect a sibling
    /// project without the user copy-pasting the path.
    ///
    /// The variant name is a WIRE KEY, not a concept: `rename_all` turns it
    /// into the `"workspace"` tag the frontend sends, and `@workspace:<name>`
    /// is already sitting in saved prompts. Atlas calls these projects.
    Workspace {
        id: String,
        display_name: String,
        abs_path: String,
        #[serde(default)]
        org_name: Option<String>,
    },
    Paper {
        id: String,
        display_name: String,
        authors: Vec<String>,
        metadata_path: String,
    },
    Branch {
        id: String,
        display_name: String,
    },
    PastMessage {
        id: String,
        display_name: String,
        session_title: String,
        content: String,
    },
    /// A whole past agent session's transcript, referenced with
    /// `@session:<title>`. The frontend pre-reads + formats the JSONL
    /// transcript into `inline_body` (like `Component`); there is no Rust
    /// read fallback since formatting a transcript lives on the JS side.
    PastSession {
        id: String,
        display_name: String,
        session_title: String,
        #[serde(default)]
        inline_body: Option<String>,
    },
    /// A member of the chat's organisation, referenced with `@member:<name>`.
    /// Rides as an organisation link carrying the user id
    /// (`atlas-org://member/<user id>`), which the org tools take wherever
    /// they take a member — so "send it to @Grace" needs no name resolution.
    /// No body: the id is the payload.
    Member {
        /// The member's user id (never the membership id).
        id: String,
        display_name: String,
    },
    /// A channel, DM or group DM, referenced with `@conversation:<name>`;
    /// rides as `atlas-org://conversation/<id>`.
    Conversation {
        id: String,
        display_name: String,
    },
    /// A **recorded session** on the Workspace's board (the Timeline),
    /// referenced with `@recorded-session:<title>`; rides as
    /// `atlas-org://recorded-session/<Workspace id>/<session id>`.
    ///
    /// Not a [`MentionSpec::PastSession`]: that is a local transcript, read
    /// from this disk and inlined; this is the organisation's record, which
    /// the org tools read by id. The two never share a tag, a short form, a
    /// dedupe key or a link.
    RecordedSession {
        /// The session id — the same on the board and on the server.
        id: String,
        display_name: String,
        /// The server's Workspace id the session is recorded in.
        workspace_id: String,
    },
}

impl MentionSpec {
    fn id(&self) -> &str {
        match self {
            MentionSpec::File { id, .. }
            | MentionSpec::Folder { id, .. }
            | MentionSpec::Symbol { id, .. }
            | MentionSpec::Knowledge { id, .. }
            | MentionSpec::Component { id, .. }
            | MentionSpec::Repo { id, .. }
            | MentionSpec::Workspace { id, .. }
            | MentionSpec::Paper { id, .. }
            | MentionSpec::Branch { id, .. }
            | MentionSpec::PastMessage { id, .. }
            | MentionSpec::PastSession { id, .. }
            | MentionSpec::Member { id, .. }
            | MentionSpec::Conversation { id, .. }
            | MentionSpec::RecordedSession { id, .. } => id,
        }
    }

    /// What a send dedupes on: the kind and the id, so two mentions of
    /// different kinds that happen to share an id — a recorded session and a
    /// local past session, say — are never collapsed into one.
    fn dedupe_key(&self) -> (std::mem::Discriminant<MentionSpec>, String) {
        (std::mem::discriminant(self), self.id().to_string())
    }

    fn short_form(&self) -> String {
        let v = short_form_value;
        match self {
            MentionSpec::File { display_name, .. } => format!("@file:{}", v(display_name)),
            MentionSpec::Folder { display_name, .. } => format!("@folder:{}", v(display_name)),
            MentionSpec::Symbol { display_name, .. } => format!("@symbol:{}", v(display_name)),
            MentionSpec::Knowledge { id, .. } => format!("@note:{id}"),
            MentionSpec::Component {
                component_kind,
                display_name,
                ..
            } => format!("#{component_kind}:{}", v(display_name)),
            MentionSpec::Repo { display_name, .. } => format!("@repo:{}", v(display_name)),
            MentionSpec::Workspace { display_name, .. } => {
                format!("@workspace:{}", v(display_name))
            }
            MentionSpec::Paper { display_name, .. } => format!("@paper:{}", v(display_name)),
            MentionSpec::Branch { display_name, .. } => format!("@branch:{}", v(display_name)),
            MentionSpec::PastMessage { id, .. } => format!("@msg:{id}"),
            MentionSpec::PastSession { display_name, .. } => {
                format!("@session:{}", v(display_name))
            }
            MentionSpec::Member { display_name, .. } => format!("@member:{}", v(display_name)),
            MentionSpec::Conversation { display_name, .. } => {
                format!("@conversation:{}", v(display_name))
            }
            MentionSpec::RecordedSession { display_name, .. } => {
                format!("@recorded-session:{}", v(display_name))
            }
        }
    }
}

/// A short-form value, quoted when it holds whitespace: a bare value ends at the
/// first space, so `@file:My Shot.png` would read back as `My`. Mirrors
/// `shortFormValue` in `src/features/chat/lib/mentions.ts`, which writes the
/// same token into the prose this function's output has to match.
fn short_form_value(v: &str) -> std::borrow::Cow<'_, str> {
    if v.chars().any(char::is_whitespace) {
        std::borrow::Cow::Owned(format!("\"{v}\""))
    } else {
        std::borrow::Cow::Borrowed(v)
    }
}

/// What `compose_prompt` hands back (P2.1).
///
/// Was a bare `String`. Path-bearing mentions now ALSO travel as structured
/// `resourceLinks`, which the caller turns into `ContentBlock::ResourceLink` —
/// the ACP-native way to say "here is a file, open it yourself". Every agent
/// MUST support that block type, so there is no capability to gate on.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedPrompt {
    /// Prose plus the context block for mentions that have no URI (knowledge
    /// entries, past sessions, papers) or whose block carries instructions
    /// rather than just a path.
    pub prose: String,
    pub resource_links: Vec<ResourceLinkSpec>,
}

/// One `@`-mention that points at something the agent reaches itself: a path
/// on disk (`file://`), or an organisation member, conversation or recorded
/// session (`atlas-org://`, read by the org tools).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLinkSpec {
    /// `file://` or `atlas-org://` URI — ACP wants a URI, not a bare path.
    pub uri: String,
    /// What the user typed, so the agent can echo it back recognisably.
    pub name: String,
}

/// `file://` URI for an absolute path.
///
/// Percent-encodes the characters that would otherwise terminate or re-scope
/// the URI. Deliberately narrow: over-encoding a path breaks agents that
/// naively strip the scheme and use the remainder as a path, which several do.
fn file_uri(abs_path: &str) -> String {
    let mut out = String::with_capacity(abs_path.len() + 8);
    out.push_str("file://");
    for ch in abs_path.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            '%' => out.push_str("%25"),
            c => out.push(c),
        }
    }
    out
}

/// The on-disk target of a mention, when it has one.
fn mention_path(m: &MentionSpec) -> Option<&str> {
    match m {
        MentionSpec::File { abs_path, .. }
        | MentionSpec::Folder { abs_path, .. }
        | MentionSpec::Workspace { abs_path, .. }
        | MentionSpec::Repo { abs_path, .. } => Some(abs_path),
        _ => None,
    }
}

/// The organisation link a mention rides as, when it is an organisation
/// mention ([`OrgLink`], the one definition the org tools also parse).
fn mention_org_link(m: &MentionSpec) -> Option<OrgLink> {
    match m {
        MentionSpec::Member { id, .. } => Some(OrgLink::Member { user_id: id.clone() }),
        MentionSpec::Conversation { id, .. } => Some(OrgLink::Conversation { id: id.clone() }),
        MentionSpec::RecordedSession { id, workspace_id, .. } => Some(OrgLink::RecordedSession {
            workspace_id: workspace_id.clone(),
            session_id: id.clone(),
        }),
        _ => None,
    }
}

/// The URI a mention rides as, when it has one.
fn mention_uri(m: &MentionSpec) -> Option<String> {
    mention_path(m)
        .map(file_uri)
        .or_else(|| mention_org_link(m).map(|link| link.uri()))
}

#[tauri::command]
pub async fn compose_prompt(
    prose: String,
    mentions: Vec<MentionSpec>,
) -> Result<ComposedPrompt, String> {
    if mentions.is_empty() {
        return Ok(ComposedPrompt {
            prose,
            resource_links: Vec::new(),
        });
    }

    // Dedupe by id preserving first-seen order — a user can reference
    // the same file twice in one message but the context block should
    // only carry it once.
    let mut seen = std::collections::HashSet::new();
    let uniq: Vec<MentionSpec> = mentions
        .into_iter()
        .filter(|m| seen.insert(m.dedupe_key()))
        .collect();

    // Fan out body fetches in parallel. Each spawn_blocking is one
    // task on tokio's blocking pool; the join_all waits for all of
    // them. Branches have no body so they short-circuit without
    // spawning.
    // Structured links for everything with a path (P2.1) or an organisation
    // id (#122). Built before the bodies fan out, so the ordering matches
    // what the user typed.
    let links: Vec<ResourceLinkSpec> = uniq
        .iter()
        .filter_map(|m| {
            mention_uri(m).map(|uri| ResourceLinkSpec {
                uri,
                name: m.short_form(),
            })
        })
        .collect();

    let futures = uniq.into_iter().map(|m| async move {
        tokio::task::spawn_blocking(move || render_block(&m))
            .await
            .unwrap_or_else(|e| Some(format!("(spawn failed: {e})")))
    });
    let blocks: Vec<Option<String>> = futures::future::join_all(futures).await;
    let present: Vec<String> = blocks.into_iter().flatten().collect();
    let composed = if present.is_empty() {
        prose
    } else {
        format!(
            "{prose}\n\n---\n# Atlas context\n\n{joined}\n",
            joined = present.join("\n\n")
        )
    };

    Ok(ComposedPrompt {
        prose: composed,
        resource_links: links,
    })
}

/// Synchronous body renderer for a single mention. Runs on the
/// blocking pool. Returns `None` for mentions that don't contribute
/// a body block (only branches today — the short form alone is the
/// payload).
fn render_block(m: &MentionSpec) -> Option<String> {
    match m {
        // P2.1: files and folders contribute NO prose block any more — their
        // entire payload was the path, and that now rides as a structured
        // `ResourceLink` the agent parses instead of a sentence it has to
        // read. The long-standing decision NOT to inline file bodies is
        // unchanged and is exactly what ResourceLink expresses natively:
        // "here is the file, open the part you need". Instruction-bearing
        // mentions (project/repo) keep their block AND get a link.
        MentionSpec::File { .. } | MentionSpec::Folder { .. } => None,
        MentionSpec::Workspace {
            abs_path,
            display_name,
            org_name,
            ..
        } => {
            let org = org_name
                .as_deref()
                .map(|o| format!(" (in the “{o}” organisation)"))
                .unwrap_or_default();
            Some(format!(
                "## {sf}\n\nThe project **{display_name}**{org} is located at the \
                 absolute path:\n`{abs_path}`\n\n\
                 Use your filesystem tools to inspect it — list its tree, read the relevant \
                 source, and apply what you find to this request. It is a SEPARATE project from \
                 the current working directory; reference it by this absolute path.",
                sf = m.short_form(),
            ))
        }
        MentionSpec::Repo {
            abs_path,
            display_name,
            has_readme,
            ..
        } => {
            // Lead with an explicit directive so the agent actually EXPLORES the
            // codebase (reads the tree + source), not just the README. The
            // absolute path is given so it can `ls`/read directly.
            let instruction = format!(
                "## {sf}\n\nA cloned repository is available locally at the absolute path:\n\
                 `{abs_path}`\n\n\
                 **Explore this codebase** using your filesystem tools — list its directory \
                 tree, open the key source files, and trace how the pieces fit together to \
                 understand what it does and how it works. Do NOT rely on the README alone; \
                 read the actual source. Apply this understanding to the rest of this request.",
                sf = m.short_form(),
            );
            let readme = if *has_readme {
                match read_repo_readme_body(abs_path, display_name) {
                    Some(b) => format!(
                        "\n\nIts README is included below as a starting point only — \
                         keep exploring the source beyond it:\n\n{}",
                        clip_body(&b)
                    ),
                    None => String::new(),
                }
            } else {
                String::new()
            };
            Some(format!("{instruction}{readme}"))
        }
        MentionSpec::Knowledge {
            file_path,
            inline_body,
            ..
        } => {
            let body = match inline_body.as_deref() {
                Some(b) if !b.is_empty() => b.to_string(),
                _ => std::fs::read_to_string(file_path)
                    .unwrap_or_else(|_| "(unable to read knowledge entry)".to_string()),
            };
            Some(format!(
                "## {sf}\n\n{body}",
                sf = m.short_form(),
                body = clip_body(&body),
            ))
        }
        MentionSpec::Component {
            file_path,
            inline_body,
            ..
        } => {
            // Inline the component body (a command/agent/rule markdown,
            // frontmatter stripped) so any ACP agent receives it. The
            // frontend pre-fills `inline_body`; fall back to reading the
            // file and stripping its frontmatter otherwise.
            let body = match inline_body.as_deref() {
                Some(b) if !b.is_empty() => b.to_string(),
                _ => read_component_body(file_path),
            };
            Some(format!(
                "## {sf}\n\n{lead}{body}",
                sf = m.short_form(),
                lead = describe_lead(file_path),
                body = clip_body(&body),
            ))
        }
        MentionSpec::Paper {
            authors,
            metadata_path,
            ..
        } => {
            let body = std::fs::read_to_string(metadata_path)
                .unwrap_or_else(|_| "(unable to read paper metadata)".to_string());
            let authors_line = if authors.is_empty() {
                String::new()
            } else {
                format!("Authors: {}\n\n", authors.join(", "))
            };
            Some(format!(
                "## {sf}\n\n{authors_line}{body}",
                sf = m.short_form(),
                body = clip_body(&body),
            ))
        }
        MentionSpec::Symbol {
            signature,
            symbol_kind,
            file_path,
            line,
            ..
        } => Some(format!(
            "## {sf}\n\n{signature}\n\n_({symbol_kind} at {file_path}:{line})_",
            sf = m.short_form(),
        )),
        MentionSpec::PastMessage {
            session_title,
            content,
            ..
        } => Some(format!(
            "## {sf} _(from session {session_title})_\n\n{body}",
            sf = m.short_form(),
            body = clip_body(content),
        )),
        MentionSpec::PastSession {
            session_title,
            inline_body,
            ..
        } => {
            let body = match inline_body.as_deref() {
                Some(b) if !b.is_empty() => b,
                _ => "(unable to read session transcript)",
            };
            Some(format!(
                "## {sf} _(transcript of session {session_title})_\n\n{body}",
                sf = m.short_form(),
                body = clip_body(body),
            ))
        }
        MentionSpec::Branch { .. } => None,
        // Organisation mentions carry ids only: the link is the whole
        // payload, and the org tools read what it names on demand.
        MentionSpec::Member { .. }
        | MentionSpec::Conversation { .. }
        | MentionSpec::RecordedSession { .. } => None,
    }
}

/// Read a component markdown file (`command`/`agent`/`rule`) and return just
/// its body, stripping a leading `---` frontmatter block. The frontend
/// normally pre-fills the already-parsed body, so this is only the fallback
/// path; it intentionally mirrors the minimal frontmatter handling in
/// `commands::skills::parse_frontmatter` without depending on it.
fn read_component_body(path: &str) -> String {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return "(unable to read component)".to_string();
    };
    strip_frontmatter(&raw)
}

/// Build the optional one-line lead (the component `description:`, in
/// italics) prepended to an inlined body, or empty when there's no description.
fn describe_lead(file_path: &str) -> String {
    match std::fs::read_to_string(file_path) {
        Ok(raw) => match frontmatter_description(&raw) {
            d if d.is_empty() => String::new(),
            d => format!("_{}_\n\n", clip_body(&d)),
        },
        Err(_) => String::new(),
    }
}

/// Extract the single-line `description:` frontmatter field (quotes trimmed).
/// Empty when there's no frontmatter or no such field. Mirrors the minimal
/// handling in `strip_frontmatter` without depending on `commands::skills`.
fn frontmatter_description(raw: &str) -> String {
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return String::new();
    }
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if let Some(v) = line.trim_start().strip_prefix("description:") {
            return v.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    String::new()
}

fn strip_frontmatter(raw: &str) -> String {
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return raw.to_string(); // no frontmatter → all body
    }
    let mut body_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed {
            if line.trim_end() == "---" {
                closed = true;
            }
            continue;
        }
        body_lines.push(line);
    }
    if !closed {
        return raw.to_string(); // unterminated frontmatter → treat all as body
    }
    let body = body_lines.join("\n");
    body.trim_start_matches(['\n', '\r']).to_string()
}

fn clip_body(body: &str) -> String {
    if body.len() <= MENTION_BODY_BUDGET_BYTES {
        return body.to_string();
    }
    let head = &body[..MENTION_BODY_BUDGET_BYTES];
    let elided = body.len() - MENTION_BODY_BUDGET_BYTES;
    format!("{head}\n\n… (truncated, {elided} bytes elided)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_leading_frontmatter_block() {
        let raw = "---\nname: review-rust-diff\ndescription: Review a diff.\n---\n\nStep 1. Check unwrap().";
        assert_eq!(strip_frontmatter(raw), "Step 1. Check unwrap().");
    }

    #[test]
    fn no_frontmatter_is_passed_through() {
        let raw = "Just a body, no frontmatter.\nSecond line.";
        assert_eq!(strip_frontmatter(raw), raw);
    }

    #[test]
    fn component_mention_inlines_body_with_kind_token() {
        let spec = MentionSpec::Component {
            id: "global:command:demo:ship".to_string(),
            display_name: "ship".to_string(),
            component_kind: "command".to_string(),
            file_path: String::new(),
            inline_body: Some("Do the ship steps.".to_string()),
        };
        let block = render_block(&spec).expect("component renders a block");
        assert!(block.contains("## #command:ship"), "got: {block}");
        assert!(block.contains("Do the ship steps."), "got: {block}");
    }

    #[test]
    fn unterminated_frontmatter_is_treated_as_body() {
        let raw = "---\nname: x\nbody but no close";
        assert_eq!(strip_frontmatter(raw), raw);
    }

    #[test]
    fn frontmatter_description_reads_single_line_field() {
        let raw = "---\nname: x\ndescription: \"Does a thing\"\n---\n\nbody";
        assert_eq!(frontmatter_description(raw), "Does a thing");
        assert_eq!(frontmatter_description("no frontmatter here"), "");
        assert_eq!(frontmatter_description("---\nname: x\n---\nbody"), "");
    }
}

fn read_repo_readme_body(repo_abs: &str, _repo_name: &str) -> Option<String> {
    // Repos live at `<project>/.atlas/repos/<name>/` — the user
    // passes the abs path of the repo dir, so we look for README
    // variants directly under it. Order matches `github.rs::read_repo_readme`.
    let repo_dir = Path::new(repo_abs);
    for name in &[
        "README.md",
        "readme.md",
        "Readme.md",
        "README.rst",
        "README.txt",
        "README",
    ] {
        let path = repo_dir.join(name);
        if path.exists() {
            return std::fs::read_to_string(&path).ok();
        }
    }
    None
}

#[cfg(test)]
mod resource_link_tests {
    use super::file_uri;

    #[test]
    fn a_plain_path_becomes_a_file_uri() {
        assert_eq!(file_uri("/repo/src/main.rs"), "file:///repo/src/main.rs");
    }

    /// Spaces are the common case on macOS (`/Users/x/My Project`); an
    /// unencoded space truncates the URI at the first word for a strict parser.
    #[test]
    fn spaces_are_encoded() {
        assert_eq!(
            file_uri("/Users/x/My Project/a.rs"),
            "file:///Users/x/My%20Project/a.rs"
        );
    }

    /// `#` and `?` would otherwise re-scope the rest of the path as a fragment
    /// or query string, silently pointing the agent at the wrong file.
    #[test]
    fn fragment_and_query_delimiters_are_encoded() {
        assert_eq!(file_uri("/a/b#c.rs"), "file:///a/b%23c.rs");
        assert_eq!(file_uri("/a/b?c.rs"), "file:///a/b%3Fc.rs");
        assert_eq!(file_uri("/a/100%.rs"), "file:///a/100%25.rs");
    }

    /// Deliberately narrow encoding: several agents strip the scheme and use
    /// the remainder as a path, so over-encoding ordinary characters would
    /// hand them a path that no longer exists.
    #[test]
    fn ordinary_path_characters_are_left_alone() {
        for path in [
            "/a/b-c_d.rs",
            "/a/b.test.ts",
            "/a/@scope/pkg/index.js",
            "/a/b(1)/c.rs",
            "/Users/x/Ünïcodé/файл.rs",
        ] {
            assert_eq!(file_uri(path), format!("file://{path}"), "{path}");
        }
    }
}

#[cfg(test)]
mod org_mention_tests {
    use super::*;

    fn spec(value: serde_json::Value) -> MentionSpec {
        serde_json::from_value(value).expect("the frontend's mention shape")
    }

    fn member() -> serde_json::Value {
        serde_json::json!({ "kind": "member", "id": "u-grace", "displayName": "Grace Hopper", "email": "grace@acme.dev" })
    }

    fn conversation() -> serde_json::Value {
        serde_json::json!({ "kind": "conversation", "id": "c-general", "displayName": "general", "conversationKind": "channel" })
    }

    fn recorded() -> serde_json::Value {
        serde_json::json!({
            "kind": "recorded_session",
            "id": "rs-1",
            "displayName": "Fix the theme importer",
            "sessionId": "rs-1",
            "workspaceId": "ws-atlas",
        })
    }

    fn links(composed: &ComposedPrompt) -> Vec<(String, String)> {
        composed.resource_links.iter().map(|l| (l.uri.clone(), l.name.clone())).collect()
    }

    #[tokio::test]
    async fn organisation_mentions_ride_as_links_carrying_their_ids_with_a_short_label() {
        let composed = compose_prompt(
            "send it to them".into(),
            vec![spec(member()), spec(conversation()), spec(recorded())],
        )
        .await
        .unwrap();
        assert_eq!(
            links(&composed),
            [
                ("atlas-org://member/u-grace".to_string(), "@member:\"Grace Hopper\"".to_string()),
                ("atlas-org://conversation/c-general".to_string(), "@conversation:general".to_string()),
                (
                    "atlas-org://recorded-session/ws-atlas/rs-1".to_string(),
                    "@recorded-session:\"Fix the theme importer\"".to_string(),
                ),
            ],
        );
        assert_eq!(composed.prose, "send it to them", "ids only: nothing is inlined");
    }

    /// The links compose_prompt writes are the links the org tools read.
    #[tokio::test]
    async fn every_link_it_writes_parses_back_to_the_id_it_carries() {
        let composed = compose_prompt(String::new(), vec![spec(member()), spec(conversation()), spec(recorded())])
            .await
            .unwrap();
        let parsed: Vec<Option<OrgLink>> = composed.resource_links.iter().map(|l| OrgLink::parse(&l.uri)).collect();
        assert_eq!(
            parsed,
            [
                Some(OrgLink::Member { user_id: "u-grace".into() }),
                Some(OrgLink::Conversation { id: "c-general".into() }),
                Some(OrgLink::RecordedSession { workspace_id: "ws-atlas".into(), session_id: "rs-1".into() }),
            ],
        );
    }

    /// A recorded session and a local past session are different things, even
    /// with the same id: the past session is inlined as a transcript and gets
    /// no link; the recorded session is a link and inlines nothing.
    #[tokio::test]
    async fn a_recorded_session_and_a_past_session_are_never_conflated() {
        let past = spec(serde_json::json!({
            "kind": "past_session",
            "id": "rs-1",
            "displayName": "Fix the theme importer",
            "sessionTitle": "Fix the theme importer",
            "inlineBody": "### User\nfix it",
        }));
        let composed = compose_prompt("compare".into(), vec![spec(recorded()), past]).await.unwrap();
        assert_eq!(
            links(&composed),
            [(
                "atlas-org://recorded-session/ws-atlas/rs-1".to_string(),
                "@recorded-session:\"Fix the theme importer\"".to_string(),
            )],
            "only the recorded session is a link",
        );
        assert!(composed.prose.contains("## @session:\"Fix the theme importer\""), "{}", composed.prose);
        assert!(composed.prose.contains("fix it"), "the past session's transcript is still inlined");
        assert!(!composed.prose.contains("@recorded-session"), "the recorded session inlines nothing");
    }

    #[tokio::test]
    async fn the_same_member_twice_is_one_link() {
        let composed = compose_prompt(String::new(), vec![spec(member()), spec(member())]).await.unwrap();
        assert_eq!(composed.resource_links.len(), 1);
    }
}

#[cfg(test)]
mod short_form_tests {
    use super::short_form_value;

    /// A bare value ends at the first space, so a name with one must be quoted
    /// or `@file:My Shot.png` reads back as a mention of `My`.
    #[test]
    fn a_value_with_whitespace_is_quoted() {
        assert_eq!(
            short_form_value("CleanShot 2026-09-15 at 10.04.08 PM@2x.png"),
            "\"CleanShot 2026-09-15 at 10.04.08 PM@2x.png\""
        );
    }

    #[test]
    fn a_bare_value_is_left_alone() {
        assert_eq!(short_form_value("src/main.rs"), "src/main.rs");
        assert_eq!(short_form_value("Shot@2x.png"), "Shot@2x.png");
    }
}
