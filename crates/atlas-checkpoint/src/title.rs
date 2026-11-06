//! Session titles, derived rather than generated.
//!
//! The first meaningful line of the first user prompt — agent wrapper markup
//! taken out (see [`from_redacted`]) — trimmed, bounded, and **redacted**.
//! No model call: a title has to exist the instant a turn completes, has to work
//! offline, has to work in Local mode, and has to work for an Organisation with
//! no AI entitlement — which is the default state. Every one of those rules out
//! generation.
//!
//! The redaction is not defensive tidiness. The title is the single most visible
//! string in the product — it renders on the shared Organisation board — and
//! prompts are exactly where people paste a key to ask why it is failing.

/// Longest a title may be, in characters. Long enough to be a sentence, short
/// enough that a board row does not wrap.
pub const MAX_TITLE_CHARS: usize = 120;

/// Derive a title from a raw user prompt.
///
/// Returns `None` when there is nothing usable — an empty prompt, or one that
/// was entirely secret and redacted away to nothing meaningful. A Session with
/// no title is better than a Session titled `[REDACTED]`.
///
/// Calls the redactor **unguarded** — a pathological prompt that panics a regex
/// layer unwinds through here. The capture path must not use this directly; it
/// scrubs through its own `catch_unwind` guard and derives via
/// [`from_redacted`], so a redactor panic fails closed (no title, Session
/// flagged) instead of killing the capture worker. This entry point exists for
/// callers that have nowhere to route a redaction failure.
pub fn from_prompt(prompt: &str) -> Option<String> {
    from_redacted(&atlas_redact::redact(prompt).text)
}

/// Derive a title from an **already-redacted** prompt.
///
/// The redaction is the caller's job — deliberately, so the capture path can
/// run it inside the same panic guard that protects every other stored string.
/// Passing raw content here would put an unredacted title on the shared board.
///
/// Agents wrap a good deal of what lands in a "user" prompt in their own
/// markup: Claude Code fences a paste as `<pasted_content id="8a17">…
/// </pasted_content id="8a17">`, a slash command as `<command-name>` /
/// `<command-args>`, injected context as `<system-reminder>`, an attached image
/// as `[Image #1]`. Read line-literally, the first of those becomes the title
/// and the shared board fills with Sessions called `<pasted_content
/// id="8a17">`. So the title is, in order:
///
/// 1. a slash command, as `/name args`;
/// 2. the first line of what the person typed around the markup;
/// 3. the first line of the first paste, so a prompt that is only a pasted
///    stack trace is titled by the trace;
/// 4. a plain label (`Pasted text`, `Image`) rather than nothing, because the
///    Session did have a first prompt, it just was not prose.
pub fn from_redacted(text: &str) -> Option<String> {
    let prompt = parse_prompt(text);

    let title = prompt
        .command
        .as_deref()
        .and_then(first_meaningful_line)
        .or_else(|| first_meaningful_line(&prompt.prose))
        .or_else(|| {
            prompt
                .pastes
                .iter()
                .find_map(|paste| first_meaningful_line(paste))
        })
        .or_else(|| (!prompt.pastes.is_empty()).then(|| PASTED_TEXT_TITLE.to_string()))
        .or_else(|| prompt.had_image.then(|| IMAGE_TITLE.to_string()))?;

    Some(truncate(&title, MAX_TITLE_CHARS))
}

/// Title for a prompt that was nothing but pasted blocks with no usable line.
pub const PASTED_TEXT_TITLE: &str = "Pasted text";
/// Title for a prompt that was nothing but image attachments.
pub const IMAGE_TITLE: &str = "Image";

/// Tags whose whole block is harness machinery, never something a person
/// said. Dropped together with their content.
const DROPPED_BLOCKS: &[&str] = &[
    "system-reminder",
    "local-command-caveat",
    "local-command-stdout",
    "local-command-stderr",
    "command-message",
    "command-stdout",
    "command-stderr",
    "bash-stdout",
    "bash-stderr",
    "task-notification",
    "user-prompt-submit-hook",
    "ide_opened_file",
    "ide_selection",
    "ide_diagnostics",
    "atlas-memory",
];

/// Tags whose content *is* the person's input, merely fenced. Unwrapped.
const UNWRAPPED_BLOCKS: &[&str] = &["bash-input", "user_query"];

/// Inline placeholders an agent leaves where an attachment was.
const IMAGE_PLACEHOLDER: &str = "[Image #";
const PASTE_PLACEHOLDER: &str = "[Pasted text #";

/// A prompt with the agent markup taken apart.
#[derive(Debug, Default)]
struct ParsedPrompt {
    /// What remains once every recognised block is removed or unwrapped.
    prose: String,
    /// `/name args`, when the prompt was a slash-command envelope.
    command: Option<String>,
    /// The bodies of `<pasted_content>` blocks, in order — plus one empty entry
    /// per `[Pasted text #N]` placeholder, whose body the prompt does not carry.
    pastes: Vec<String>,
    had_image: bool,
}

fn parse_prompt(text: &str) -> ParsedPrompt {
    let mut parsed = ParsedPrompt::default();
    let mut command_name: Option<String> = None;
    let mut command_args: Option<String> = None;
    let mut prose = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(lt) = rest.find('<') {
        prose.push_str(&rest[..lt]);
        let at = &rest[lt..];
        let known = opening_tag(at).filter(|(name, _)| {
            matches!(*name, "pasted_content" | "command-name" | "command-args")
                || DROPPED_BLOCKS.contains(name)
                || UNWRAPPED_BLOCKS.contains(name)
        });
        let Some((name, open_len)) = known else {
            // Prose `<`, or a tag this module does not know: keep it verbatim.
            prose.push('<');
            rest = &at[1..];
            continue;
        };
        let after_open = &at[open_len..];

        // An unclosed paste runs to the end of the prompt — the agent fenced
        // everything after it. Any other unclosed tag drops only the tag
        // itself, so a stray opener cannot swallow the person's words.
        let (inner, consumed) = match closing_tag(after_open, name) {
            Some((start, len)) => (&after_open[..start], open_len + start + len),
            None if name == "pasted_content" => (after_open, at.len()),
            None => ("", open_len),
        };

        match name {
            "pasted_content" => parsed.pastes.push(inner.to_string()),
            "command-name" => command_name = Some(inner.trim().to_string()),
            "command-args" => command_args = Some(inner.trim().to_string()),
            name if UNWRAPPED_BLOCKS.contains(&name) => {
                prose.push(' ');
                prose.push_str(inner);
            }
            _ => {}
        }
        // A space, not a newline: an inline block's neighbours stay one line
        // (`why does <paste> fail` → `why does fail`); a block on its own
        // line already has its own line breaks around it.
        prose.push(' ');
        rest = &at[consumed..];
    }
    prose.push_str(rest);

    parsed.prose = strip_placeholders(&prose, &mut parsed);
    parsed.command = command_name.filter(|name| !name.is_empty()).map(|name| {
        match command_args
            .as_deref()
            .and_then(|args| args.lines().map(str::trim).find(|l| !l.is_empty()))
        {
            Some(args) => format!("{name} {args}"),
            None => name,
        }
    });
    parsed
}

/// Remove `[Image #N]` / `[Pasted text #N +M lines]` placeholders, recording
/// what each stood for.
fn strip_placeholders(text: &str, parsed: &mut ParsedPrompt) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let (at, is_image) = match (rest.find(IMAGE_PLACEHOLDER), rest.find(PASTE_PLACEHOLDER)) {
            (Some(image), Some(paste)) if image < paste => (image, true),
            (Some(image), None) => (image, true),
            (_, Some(paste)) => (paste, false),
            (None, None) => break,
        };
        let Some(end) = rest[at..].find(']') else {
            break;
        };
        out.push_str(&rest[..at]);
        if is_image {
            parsed.had_image = true;
        } else {
            parsed.pastes.push(String::new());
        }
        rest = &rest[at + end + 1..];
    }
    out.push_str(rest);
    out
}

/// `<name …>` at the start of `text`: the tag name and the opener's length.
fn opening_tag(text: &str) -> Option<(&str, usize)> {
    let body = text.strip_prefix('<')?;
    if !body.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let name_len = body
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .unwrap_or(body.len());
    let after_name = &body[name_len..];
    if !(after_name.starts_with('>') || after_name.starts_with(char::is_whitespace)) {
        return None;
    }
    let gt = after_name.find('>')?;
    // An attribute list never spans a line; refusing one that does keeps a
    // prose `<` from reaching a `>` paragraphs later.
    if after_name[..gt].contains('\n') {
        return None;
    }
    Some((&body[..name_len], 1 + name_len + gt + 1))
}

/// The first `</name …>` in `text`: its byte offset and length. Claude Code
/// repeats the opener's attributes on the closer (`</pasted_content
/// id="8a17">`), so anything up to the `>` is accepted.
fn closing_tag(text: &str, name: &str) -> Option<(usize, usize)> {
    let needle = format!("</{name}");
    let mut from = 0;
    while let Some(found) = text[from..].find(&needle) {
        let start = from + found;
        let after = &text[start + needle.len()..];
        if after.starts_with('>') || after.starts_with(char::is_whitespace) {
            let gt = after.find('>')?;
            return Some((start, needle.len() + gt + 1));
        }
        from = start + needle.len();
    }
    None
}

/// The first line that carries words: trimmed, markdown prefix dropped,
/// whitespace collapsed. A line that is only a tag — an agent wrapper this
/// module does not know by name — is skipped rather than becoming the title.
fn first_meaningful_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !is_lone_tag(line))
        .map(|line| {
            strip_markdown_prefix(line)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .find(|line| !line.is_empty())
}

/// `<tag>`, `</tag attr="x">`, `<tag/>`: a line that is markup and nothing
/// else.
fn is_lone_tag(line: &str) -> bool {
    let Some(inner) = line.strip_prefix('<').and_then(|l| l.strip_suffix('>')) else {
        return false;
    };
    let inner = inner.strip_prefix('/').unwrap_or(inner);
    inner.starts_with(|c: char| c.is_ascii_alphabetic())
        && !inner.contains(['<', '>'])
        && inner.split_whitespace().next().is_some_and(|name| {
            name.trim_end_matches('/')
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
        })
}

/// Drop leading markdown noise so a prompt that opens with a heading or bullet
/// titles as its text rather than its punctuation.
fn strip_markdown_prefix(line: &str) -> &str {
    line.trim_start_matches(['#', '>', '-', '*', ' ', '\t'])
        .trim()
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    // Reserve one character for the ellipsis so the result is exactly bounded.
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    // Prefer cutting at a word boundary when one is close, so the title reads as
    // a truncated sentence rather than a truncated word. `rfind` returns a byte
    // index, so the "is it close enough" comparison counts the characters before
    // it rather than comparing bytes against a character budget — multi-byte
    // text would otherwise mis-place the cut.
    if let Some(space) = out.rfind(' ') {
        if out[..space].chars().count() > max_chars * 2 / 3 {
            out.truncate(space);
        }
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_line_becomes_the_title() {
        assert_eq!(
            from_prompt("Add rate limiting to the upload endpoint\n\nUse a token bucket."),
            Some("Add rate limiting to the upload endpoint".to_string())
        );
    }

    #[test]
    fn leading_blank_lines_are_skipped() {
        assert_eq!(
            from_prompt("\n\n   \nFix the flaky auth test"),
            Some("Fix the flaky auth test".to_string())
        );
    }

    #[test]
    fn markdown_prefixes_are_stripped() {
        assert_eq!(
            from_prompt("## Investigate the watcher"),
            Some("Investigate the watcher".to_string())
        );
        assert_eq!(
            from_prompt("- fix the rename detection"),
            Some("fix the rename detection".to_string())
        );
    }

    #[test]
    fn a_secret_pasted_into_the_prompt_never_reaches_the_title() {
        let title = from_prompt("here's my key sk-ABCDEF0123456789ABCDEF, why is it failing")
            .expect("title");
        assert!(!title.contains("sk-ABCDEF0123456789ABCDEF"), "{title}");
        assert!(title.contains("[REDACTED]"), "{title}");
    }

    #[test]
    fn a_long_prompt_is_bounded_and_ends_in_an_ellipsis() {
        let prompt = "word ".repeat(200);
        let title = from_prompt(&prompt).expect("title");
        assert!(title.chars().count() <= MAX_TITLE_CHARS);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn a_long_prompt_is_cut_at_a_word_boundary_when_one_is_near() {
        let title =
            from_prompt(&format!("{} finally", "alpha beta gamma ".repeat(20))).expect("title");
        assert!(!title.trim_end_matches('…').ends_with(' '));
        assert!(title.ends_with('…'));
    }

    #[test]
    fn an_empty_prompt_yields_no_title() {
        assert_eq!(from_prompt(""), None);
        assert_eq!(from_prompt("   \n\n  "), None);
        assert_eq!(from_prompt("###"), None);
    }

    #[test]
    fn a_title_is_deterministic() {
        let prompt = "Add rate limiting to the upload endpoint";
        assert_eq!(from_prompt(prompt), from_prompt(prompt));
    }

    #[test]
    fn from_redacted_derives_without_touching_the_redactor() {
        // The capture path scrubs under its own panic guard and hands the
        // scrubbed text here — the two entry points must agree on derivation.
        assert_eq!(
            from_redacted("Fix the flaky auth test"),
            Some("Fix the flaky auth test".to_string())
        );
        assert_eq!(
            from_prompt("Fix the flaky auth test"),
            from_redacted("Fix the flaky auth test")
        );
        assert_eq!(from_redacted("   \n  "), None);
    }

    // ── Agent markup. The inputs below are the shapes Claude Code writes to its
    //    transcripts, which is what an imported Session's first prompt is. ──

    #[test]
    fn a_prompt_that_is_only_a_paste_is_titled_by_the_pastes_first_line() {
        let prompt = "\n\n<pasted_content id=\"8a17\">\n## Error Type\nConsole Error\n\n## Error Message\nBase UI: render is not a function\n</pasted_content id=\"8a17\">\n";
        assert_eq!(from_prompt(prompt), Some("Error Type".to_string()));
    }

    #[test]
    fn text_typed_after_a_paste_wins_over_the_paste() {
        let prompt = "\n\n<pasted_content id=\"e223\">\n⚠ Blocked cross-origin request to Next.js dev resource\n</pasted_content id=\"e223\">\n\n fix it";
        assert_eq!(from_prompt(prompt), Some("fix it".to_string()));
    }

    #[test]
    fn text_typed_before_a_paste_wins_over_the_paste() {
        let prompt = "nova's page can be rescraped \n\n<pasted_content id=\"e3a0\">\nfc-token-goes-here\n</pasted_content id=\"e3a0\">\n\n here's the token";
        assert_eq!(
            from_prompt(prompt),
            Some("nova's page can be rescraped".to_string())
        );
    }

    #[test]
    fn an_inline_paste_leaves_the_surrounding_words_on_one_line() {
        assert_eq!(
            from_redacted(
                "why does <pasted_content id=\"01\">panic at main.rs</pasted_content id=\"01\"> fail"
            ),
            Some("why does fail".to_string())
        );
    }

    #[test]
    fn a_paste_with_no_usable_line_falls_back_to_a_label() {
        let prompt = "<pasted_content id=\"ff00\">\n\n   \n</pasted_content id=\"ff00\">";
        assert_eq!(from_prompt(prompt), Some(PASTED_TEXT_TITLE.to_string()));
        assert_eq!(
            from_redacted("[Pasted text #1 +42 lines]"),
            Some(PASTED_TEXT_TITLE.to_string())
        );
    }

    #[test]
    fn an_unclosed_paste_still_never_becomes_the_title() {
        assert_eq!(
            from_redacted("<pasted_content id=\"8a17\">\nTypeError: x is undefined\n  at foo"),
            Some("TypeError: x is undefined".to_string())
        );
    }

    #[test]
    fn a_bare_opening_tag_line_is_never_a_title() {
        // What the board actually shows today: the first line, alone.
        assert_eq!(
            from_redacted("<pasted_content id=\"8a17\">"),
            Some(PASTED_TEXT_TITLE.to_string())
        );
        assert_eq!(
            from_redacted("<some-new-wrapper kind=\"x\">\nthe real ask\n</some-new-wrapper>"),
            Some("the real ask".to_string())
        );
    }

    #[test]
    fn a_slash_command_reads_as_the_command_and_its_args() {
        let prompt = "<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>the auth branch\nthoroughly</command-args>";
        assert_eq!(
            from_prompt(prompt),
            Some("/review the auth branch".to_string())
        );
        assert_eq!(
            from_redacted("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
            Some("/clear".to_string())
        );
    }

    #[test]
    fn harness_blocks_are_dropped_with_their_content() {
        let prompt = "<system-reminder>\nThe user opened the file foo.ts in the IDE.\n</system-reminder>\n<local-command-stdout>Compacted</local-command-stdout>\nRefactor the uploader";
        assert_eq!(
            from_prompt(prompt),
            Some("Refactor the uploader".to_string())
        );
        assert_eq!(
            from_redacted(
                "<ide_opened_file>The user opened src/a.rs</ide_opened_file> explain this"
            ),
            Some("explain this".to_string())
        );
    }

    #[test]
    fn a_bash_input_is_the_persons_command() {
        assert_eq!(
            from_redacted("<bash-input>git status</bash-input>"),
            Some("git status".to_string())
        );
    }

    #[test]
    fn image_placeholders_are_stripped_and_an_image_only_prompt_is_labelled() {
        assert_eq!(
            from_redacted("[Image #1] why is this button misaligned"),
            Some("why is this button misaligned".to_string())
        );
        assert_eq!(
            from_redacted("[Image #1]\n[Image #2]"),
            Some(IMAGE_TITLE.to_string())
        );
    }

    #[test]
    fn whitespace_inside_the_line_is_collapsed() {
        assert_eq!(
            from_redacted("fix   the\tflaky    test"),
            Some("fix the flaky test".to_string())
        );
    }

    #[test]
    fn prose_angle_brackets_survive() {
        assert_eq!(
            from_redacted("why is a < b but <div> renders"),
            Some("why is a < b but <div> renders".to_string())
        );
        assert_eq!(
            from_redacted("convert Vec<String> to &[&str]"),
            Some("convert Vec<String> to &[&str]".to_string())
        );
    }

    #[test]
    fn a_markdown_only_line_gives_way_to_the_next() {
        assert_eq!(
            from_redacted("###\nreal title"),
            Some("real title".to_string())
        );
    }

    #[test]
    fn a_secret_inside_a_paste_never_reaches_the_title() {
        let title = from_prompt(
            "<pasted_content id=\"aa11\">\nsk-ABCDEF0123456789ABCDEF failing\n</pasted_content id=\"aa11\">",
        )
        .expect("title");
        assert!(!title.contains("sk-ABCDEF0123456789ABCDEF"), "{title}");
    }

    #[test]
    fn multibyte_titles_truncate_on_character_boundaries() {
        // `rfind` returns a byte index; the boundary check must count chars.
        let prompt = "héllo wörld ".repeat(30);
        let title = from_prompt(&prompt).expect("title");
        assert!(title.chars().count() <= MAX_TITLE_CHARS);
        assert!(title.ends_with('…'));
    }
}
