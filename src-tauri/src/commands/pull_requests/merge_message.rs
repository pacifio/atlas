//! A merge commit's message with the agents' credits taken out: the
//! `Co-authored-by:` trailers coding agents add, and their "Generated with"
//! footers. People named as co-authors stay, as does anything inside a code
//! fence or an indented block, where an example of a trailer is only an
//! example.

/// The addresses agents sign their trailers with. GitHub's generic noreply
/// address is also used by people, so it counts only beside Copilot's name.
/// The Copilot app's own noreply address is what GitHub itself writes into
/// a merge message for commits Copilot co-authored.
const AGENT_EMAILS: [&str; 8] = [
    "noreply@anthropic.com",
    "claude@anthropic.com",
    "noreply@openai.com",
    "codex@openai.com",
    "cursoragent@cursor.com",
    "copilot@github.com",
    "223556219+copilot@users.noreply.github.com",
    "noreply@github.com",
];

/// Who a "Generated with …" footer may name.
const GENERATORS: [&str; 9] = [
    "claude code",
    "claude",
    "codex",
    "cursor",
    "github copilot",
    "copilot",
    "opencode",
    "grok",
    "antigravity",
];

/// The sites a footer's link may point at, which a footer is read without.
const FOOTER_HOSTS: [&str; 10] = [
    "claude.ai",
    "claude.com",
    "www.anthropic.com",
    "chatgpt.com",
    "openai.com",
    "cursor.com",
    "github.com",
    "opencode.ai",
    "x.ai",
    "antigravity.google",
];

/// A fence line: up to three spaces, then three or more backticks or
/// tildes. Answers the run and what follows it.
fn fence_delimiter(line: &str) -> Option<(&str, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let mark = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = rest.len() - rest.trim_start_matches(mark).len();
    (run >= 3).then(|| rest.split_at(run))
}

/// `Co-authored-by: Name <email>` naming an agent.
fn is_agent_author(text: &str) -> bool {
    const PREFIX: &str = "co-authored-by:";
    let Some(head) = text.get(..PREFIX.len()) else {
        return false;
    };
    if !head.eq_ignore_ascii_case(PREFIX) {
        return false;
    }
    let rest = text[PREFIX.len()..].trim_end();
    let Some(inside) = rest.strip_suffix('>') else {
        return false;
    };
    let Some(open) = inside.rfind('<') else {
        return false;
    };
    let email = &inside[open + 1..];
    if email.is_empty() || email.contains(['<', '>']) {
        return false;
    }
    let name = inside[..open].trim();
    let email = email.to_ascii_lowercase();
    AGENT_EMAILS.contains(&email.as_str())
        && (email != "noreply@github.com"
            || name.eq_ignore_ascii_case("github copilot")
            || name.eq_ignore_ascii_case("copilot"))
}

/// `[label](https://<footer host>/…)` read as its label.
fn unlink_footer(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let linked = after.find(']').and_then(|close| {
            let label = &after[..close];
            let target = after[close + 1..].strip_prefix("(https://")?;
            let end = target.find(')')?;
            let url = &target[..end];
            let host = url.split('/').next().unwrap_or_default();
            let path = &url[host.len()..];
            let known = FOOTER_HOSTS.iter().any(|h| h.eq_ignore_ascii_case(host));
            let clean_path = path.is_empty()
                || (path.starts_with('/') && !path.chars().any(char::is_whitespace));
            (!label.is_empty() && known && clean_path)
                .then(|| (label, close + 1 + "(https://".len() + end + 1))
        });
        match linked {
            Some((label, consumed)) => {
                out.push_str(label);
                rest = &after[consumed..];
            }
            None => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `🤖 Generated with Claude Code`, and its kin.
fn is_generated_footer(text: &str) -> bool {
    let text = match text.strip_prefix('🤖') {
        Some(rest) => rest.trim_start(),
        None => text,
    };
    let lower = text.to_lowercase();
    let Some(rest) = lower.strip_prefix("generated ") else {
        return false;
    };
    let Some(rest) = rest
        .strip_prefix("with")
        .or_else(|| rest.strip_prefix("by"))
    else {
        return false;
    };
    if !rest.starts_with(char::is_whitespace) {
        return false;
    }
    let rest = rest.trim_start();
    let name = rest
        .strip_suffix('.')
        .or_else(|| rest.strip_suffix('!'))
        .unwrap_or(rest);
    GENERATORS.contains(&name)
}

/// The message with every agent credit outside code taken out, and the
/// blank lines they leave at the end trimmed. A message with none comes
/// back exactly as it was.
pub(crate) fn remove_agent_credits(message: &str) -> String {
    let newline = if message.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut fence: Option<String> = None;
    let mut removed = false;
    let mut kept: Vec<&str> = Vec::new();
    for raw in message.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.starts_with("    ") || line.starts_with('\t') {
            kept.push(line);
            continue;
        }
        if let Some((marker, remainder)) = fence_delimiter(line) {
            match &fence {
                None => {
                    if marker.starts_with('~') || !remainder.contains('`') {
                        fence = Some(marker.to_string());
                    }
                }
                Some(open) => {
                    if marker.chars().next() == open.chars().next()
                        && marker.len() >= open.len()
                        && remainder.chars().all(|c| c == ' ' || c == '\t')
                    {
                        fence = None;
                    }
                }
            }
            kept.push(line);
            continue;
        }
        if fence.is_some() {
            kept.push(line);
            continue;
        }
        let trimmed = line.trim();
        let text = trimmed
            .strip_prefix(['-', '*'])
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .map_or(trimmed, str::trim_start);
        if is_agent_author(text) || is_generated_footer(&unlink_footer(text)) {
            removed = true;
            continue;
        }
        kept.push(line);
    }
    if !removed {
        return message.to_string();
    }
    let mut out = kept.join(newline);
    // Trailing line breaks, and blank lines' spaces, go.
    loop {
        let without = out.trim_end_matches([' ', '\t']);
        match without.strip_suffix('\n') {
            Some(rest) => out = rest.strip_suffix('\r').unwrap_or(rest).to_string(),
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_trailers_and_footers_go_and_people_stay() {
        let message = [
            "Details about Claude support.",
            "",
            "",
            "Co-authored-by: Alice <alice@example.com>",
            "Co-authored-by: Claude <noreply@anthropic.com>",
            "* Co-authored-by: Codex <noreply@openai.com>",
            "co-authored-by: Cursor <cursoragent@cursor.com>",
            "Co-authored-by: Copilot <copilot@github.com>",
            "",
            "🤖 Generated with [Claude Code](https://claude.ai/code)",
        ]
        .join("\n");
        assert_eq!(
            remove_agent_credits(&message),
            "Details about Claude support.\n\n\nCo-authored-by: Alice <alice@example.com>"
        );
    }

    #[test]
    fn the_footer_written_today_links_to_claude_com() {
        let message = [
            "Details",
            "",
            "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
            "",
            "Co-Authored-By: Claude <noreply@anthropic.com>",
        ]
        .join("\n");
        assert_eq!(remove_agent_credits(&message), "Details");
    }

    #[test]
    fn unknown_identities_namesakes_and_prose_are_kept() {
        let message = [
            "Co-authored-by: Claude <claude@example.com>",
            "Co-authored-by: Alice <noreply@github.com>",
            "Co-authored-by: Release Bot <release@example.com>",
            "Generated by our new Claude integration.",
            "Generated with [Claude Code](https://example.com)",
            "",
        ]
        .join("\n");
        assert_eq!(remove_agent_credits(&message), message);
    }

    #[test]
    fn fences_and_quotes_keep_their_examples() {
        let example = "Co-authored-by: Claude <noreply@anthropic.com>";
        let message = format!("Example:\n\n```text\n{example}\n```\n\n> {example}\n\n{example}");
        assert_eq!(
            remove_agent_credits(&message),
            format!("Example:\n\n```text\n{example}\n```\n\n> {example}")
        );
    }

    #[test]
    fn a_line_that_cannot_open_a_fence_does_not() {
        for line in ["``` text ```", "    ```", "\t~~~"] {
            assert_eq!(
                remove_agent_credits(&format!(
                    "{line}\n\nCo-authored-by: Claude <noreply@anthropic.com>"
                )),
                line,
                "{line:?}"
            );
        }
    }

    #[test]
    fn a_false_closing_fence_keeps_the_examples_after_it() {
        let example = "Co-authored-by: Claude <noreply@anthropic.com>";
        for fence in ["```", "~~~"] {
            let two = &fence[..2];
            let first = fence.chars().next().unwrap();
            let content = format!(
                "{fence}text\n{fence} trailing text\n{example}\n    {fence}\n{example}\n{two}\n{example}\n   {fence}{first} \t"
            );
            assert_eq!(
                remove_agent_credits(&format!("{content}\n\n{example}")),
                content,
                "{fence}"
            );
        }
    }

    #[test]
    fn crlf_line_endings_are_kept() {
        assert_eq!(
            remove_agent_credits(
                "Details\r\n\r\nCo-authored-by: Claude <noreply@anthropic.com>\r\nCo-authored-by: Alice <alice@example.com>"
            ),
            "Details\r\n\r\nCo-authored-by: Alice <alice@example.com>"
        );
    }

    /// What GitHub wrote for a real pull request's squash, recorded.
    #[test]
    fn github_s_own_copilot_trailer_goes() {
        assert_eq!(
            remove_agent_credits(
                "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
            ),
            ""
        );
    }

    #[test]
    fn only_credits_leave_an_empty_message() {
        assert_eq!(
            remove_agent_credits(
                "Co-authored-by: Claude <noreply@anthropic.com>\n\nGenerated by Codex\n"
            ),
            ""
        );
    }
}
