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
    /// Another workspace/project in the app, referenced with `@workspace:<name>`.
    /// Hands the agent that project's absolute path so it can inspect a sibling
    /// project without the user copy-pasting the path.
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
            | MentionSpec::PastSession { id, .. } => id,
        }
    }

    fn short_form(&self) -> String {
        match self {
            MentionSpec::File { display_name, .. } => format!("@file:{display_name}"),
            MentionSpec::Folder { display_name, .. } => format!("@folder:{display_name}"),
            MentionSpec::Symbol { display_name, .. } => format!("@symbol:{display_name}"),
            MentionSpec::Knowledge { id, .. } => format!("@note:{id}"),
            MentionSpec::Component {
                component_kind,
                display_name,
                ..
            } => format!("#{component_kind}:{display_name}"),
            MentionSpec::Repo { display_name, .. } => format!("@repo:{display_name}"),
            MentionSpec::Workspace { display_name, .. } => format!("@workspace:{display_name}"),
            MentionSpec::Paper { display_name, .. } => format!("@paper:{display_name}"),
            MentionSpec::Branch { display_name, .. } => format!("@branch:{display_name}"),
            MentionSpec::PastMessage { id, .. } => format!("@msg:{id}"),
            MentionSpec::PastSession { display_name, .. } => format!("@session:{display_name}"),
        }
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

/// One `@`-mention that points at something on disk.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLinkSpec {
    /// `file://` URI — ACP wants a URI, not a bare path.
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
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let uniq: Vec<MentionSpec> = mentions
        .into_iter()
        .filter(|m| seen.insert(m.id().to_string()))
        .collect();

    // Fan out body fetches in parallel. Each spawn_blocking is one
    // task on tokio's blocking pool; the join_all waits for all of
    // them. Branches have no body so they short-circuit without
    // spawning.
    // Structured links for everything with a path (P2.1). Built before the
    // bodies fan out, so the ordering matches what the user typed.
    let links: Vec<ResourceLinkSpec> = uniq
        .iter()
        .filter_map(|m| {
            mention_path(m).map(|p| ResourceLinkSpec {
                uri: file_uri(p),
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
        // mentions (workspace/repo) keep their block AND get a link.
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
                "## {sf}\n\nThe workspace/project **{display_name}**{org} is located at the \
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
