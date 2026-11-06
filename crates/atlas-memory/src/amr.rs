//! The Agent Memory Repo line format (github.com/AgentMemoryRepo/agentmemoryrepo,
//! SPEC.md): one bullet per entry, optional trailing `[key: value; ...]`
//! metadata, `[[path]]` links between files. Render and parse only (M4).
//!
//! The spec has no escaping: in values Atlas writes, `;` becomes `,`, `[`
//! becomes `(` and `]` becomes `)`, so a value never opens or closes a group.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmrEntry {
    pub text: String,
    pub meta: Vec<(String, String)>,
}

fn safe_value(v: &str) -> String {
    v.replace(';', ",")
        .replace('[', "(")
        .replace(']', ")")
        .replace(['\n', '\r'], " ")
}

/// `- <text> [k: v; k: v]`, the text's whitespace collapsed.
pub fn render_line(e: &AmrEntry) -> String {
    let text = e.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if e.meta.is_empty() {
        return format!("- {text}");
    }
    let meta: Vec<String> = e
        .meta
        .iter()
        .map(|(k, v)| format!("{k}: {}", safe_value(v)))
        .collect();
    format!("- {text} [{}]", meta.join("; "))
}

/// `key: value; key: value` as pairs, or `None` when any part is not one.
fn meta_group(inner: &str) -> Option<Vec<(String, String)>> {
    inner
        .split(';')
        .map(|part| {
            let (k, v) = part.split_once(':')?;
            let k = k.trim();
            let ok = !k.is_empty()
                && k.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
            ok.then(|| (k.to_string(), v.trim().to_string()))
        })
        .collect()
}

/// One bullet (`- ` or `* `). Trailing bracket groups are metadata only when
/// every `;`-separated part is `key: value`, so a text ending in `[draft]`
/// keeps it. Several trailing groups are read; repeated keys stay in order.
pub fn parse_line(line: &str) -> Option<AmrEntry> {
    let trimmed = line.trim_start();
    let body = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))?;
    let mut text = body.trim_end().to_string();
    let mut groups: Vec<Vec<(String, String)>> = Vec::new();
    while text.ends_with(']') && !text.ends_with("]]") {
        let Some(open) = text.rfind('[') else {
            break;
        };
        let Some(pairs) = meta_group(&text[open + 1..text.len() - 1]) else {
            break;
        };
        groups.push(pairs);
        text.truncate(open);
        text = text.trim_end().to_string();
    }
    groups.reverse();
    Some(AmrEntry {
        text,
        meta: groups.into_iter().flatten().collect(),
    })
}

/// `[[path]]` targets in a line (relative to the memory root; `.md` implied
/// when there is no extension).
pub fn links(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(a) = rest.find("[[") {
        let Some(b) = rest[a + 2..].find("]]") else {
            break;
        };
        let target = rest[a + 2..a + 2 + b].trim();
        if !target.is_empty() {
            out.push(if std::path::Path::new(target).extension().is_some() {
                target.to_string()
            } else {
                format!("{target}.md")
            });
        }
        rest = &rest[a + 2 + b + 2..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_round_trips_through_the_line_format() {
        let e = AmrEntry {
            text: "Use bun, not npm; the lockfile is bun.lock".into(),
            meta: vec![
                ("source".into(), "atlas-session:claude-code/s-a".into()),
                ("added".into(), "2026-10-06".into()),
            ],
        };
        let line = render_line(&e);
        assert_eq!(
            line,
            "- Use bun, not npm; the lockfile is bun.lock [source: atlas-session:claude-code/s-a; added: 2026-10-06]"
        );
        assert_eq!(parse_line(&line), Some(e));
    }

    #[test]
    fn metadata_is_only_a_trailing_key_value_group() {
        assert_eq!(parse_line("- Ship the draft [draft]").unwrap().meta, vec![]);
        assert_eq!(
            parse_line("- Ship the draft [draft]").unwrap().text,
            "Ship the draft [draft]"
        );
        let two =
            parse_line("- Cause found [source: https://x/301] [source: https://x/302]").unwrap();
        assert_eq!(two.meta.iter().filter(|(k, _)| k == "source").count(), 2);
        assert_eq!(two.text, "Cause found");
        assert!(parse_line("Not a bullet").is_none());
        let index = parse_line("- [[decisions]] Decisions and why (3)").unwrap();
        assert_eq!(index.text, "[[decisions]] Decisions and why (3)");
    }

    #[test]
    fn values_with_separators_are_made_safe() {
        let e = AmrEntry {
            text: "x".into(),
            meta: vec![("code".into(), "a;b]c".into())],
        };
        assert_eq!(render_line(&e), "- x [code: a,b)c]");
    }

    #[test]
    fn a_bracketed_path_keeps_the_metadata_parseable() {
        let e = AmrEntry {
            text: "Auth guard lives in the page".into(),
            meta: vec![
                ("atlas-id".into(), "3".into()),
                ("code".into(), "app/[id]/page.tsx#L1-5".into()),
            ],
        };
        let parsed = parse_line(&render_line(&e)).unwrap();
        assert_eq!(parsed.text, "Auth guard lives in the page");
        assert_eq!(
            parsed.meta,
            vec![
                ("atlas-id".to_string(), "3".to_string()),
                ("code".to_string(), "app/(id)/page.tsx#L1-5".to_string()),
            ]
        );
    }

    #[test]
    fn links_name_their_files() {
        assert_eq!(
            links("- [[decisions]] and [[notes/a.txt]]"),
            vec!["decisions.md".to_string(), "notes/a.txt".to_string()]
        );
    }
}
