//! Corrective error strings — tuned (after opencode, MIT) for weak-model
//! self-correction (L4 of `plans/atlas-cersei-edit-solution.md`). On a safe
//! failure these show the *real* nearby file lines so the model can re-issue a
//! correct call, and steer small files toward a whole-file `Write`.

/// Files at/under this many lines get a "consider Write" steer on edit failure.
const SMALL_FILE_LINES: usize = 40;
const WINDOW: usize = 4;

/// Render a 1-indexed numbered window of `content` around `center` (0-indexed).
fn numbered_window(content: &str, center: usize) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let start = center.saturating_sub(WINDOW);
    let end = (center + WINDOW + 1).min(lines.len());
    lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{:>5}: {}", start + i + 1, l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Best-effort: find the file line most similar to `old_string`'s first
/// non-empty (trimmed) line, to anchor the corrective window.
fn anchor_line(content: &str, old_string: &str) -> Option<usize> {
    let needle = old_string
        .split('\n')
        .map(str::trim)
        .find(|l| !l.is_empty())?;
    let lines: Vec<&str> = content.split('\n').collect();
    // Prefer a containment hit.
    if let Some(i) = lines.iter().position(|l| {
        let t = l.trim();
        !t.is_empty() && (t.contains(needle) || needle.contains(t))
    }) {
        return Some(i);
    }
    // Fall back to the line sharing the longest common prefix with the needle.
    let mut best: Option<(usize, usize)> = None; // (line_index, shared_len)
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.is_empty() {
            continue;
        }
        let shared = t
            .chars()
            .zip(needle.chars())
            .take_while(|(a, b)| a == b)
            .count();
        if best.map_or(true, |(_, s)| shared > s) {
            best = Some((i, shared));
        }
    }
    // Require a meaningful overlap so we do not anchor on noise.
    best.filter(|&(_, s)| s >= 3).map(|(i, _)| i)
}

fn small_file_steer(content: &str) -> String {
    let n = content.split('\n').count();
    if n <= SMALL_FILE_LINES {
        format!(
            "\n\nThis file is small ({n} lines). If a precise old_string is hard to \
             pin down, you may instead call Write with the full corrected file contents."
        )
    } else {
        String::new()
    }
}

/// `old_string` was not found anywhere.
pub fn edit_not_found(rel_path: &str, old_string: &str, content: &str) -> String {
    let mut msg = format!(
        "Could not find old_string in {rel_path}. It must match the file exactly — \
         including whitespace, indentation, and line endings. (Atlas already tolerates \
         minor indentation/whitespace drift, so the text is genuinely not present.)"
    );
    if let Some(i) = anchor_line(content, old_string) {
        msg.push_str(&format!(
            "\n\nThe nearest region in the file is:\n{}",
            numbered_window(content, i)
        ));
        msg.push_str(
            "\n\nRe-read the file and copy the exact text (after the `N: ` line-number prefix) \
             into old_string.",
        );
    }
    msg.push_str(&small_file_steer(content));
    msg
}

/// `old_string` matched more than once and `replace_all` was not set.
pub fn edit_ambiguous(rel_path: &str) -> String {
    format!(
        "Found multiple matches for old_string in {rel_path}. Provide more surrounding \
         context to make the match unique, or set replace_all=true to change every occurrence."
    )
}

/// A candidate matched but its span was wildly larger than `old_string`.
pub fn edit_disproportionate(rel_path: &str) -> String {
    format!(
        "Refusing the edit in {rel_path}: the only match found spans far more of the file \
         than old_string, so applying it would risk corrupting unrelated code. Re-read the \
         file and provide the full, exact old_string for the intended span."
    )
}

/// The read-before-edit precondition failed: the file was never read this
/// session. Emitted by the guard *before* the write is attempted, so this
/// message and the file on disk always agree.
pub fn must_read_first(rel_path: &str) -> String {
    format!(
        "Read {rel_path} before modifying it. Nothing has read this file in this session, so \
         the exact current contents are unknown — call Read first, then re-issue the edit \
         against what it returns."
    )
}

/// The file changed on disk since the model last read it. Refusing is the point:
/// the alternative is silently overwriting whatever the user just did in their
/// editor.
pub fn file_changed(rel_path: &str) -> String {
    format!(
        "{rel_path} has changed since it was last read, so the edit was not applied. Someone \
         else — most likely the user's editor — modified it. Read it again and re-issue the \
         edit against the current contents."
    )
}

/// An identical read of a file that has not changed since it was last read.
///
/// The content is already in the conversation, so returning it again tells the
/// model nothing it does not have and costs a full copy of the file in context
/// — on a large file that is tens of thousands of tokens per repeat. The
/// message has to name the alternatives, or a model that wanted the file will
/// simply reach for `cat` instead, which is strictly worse.
pub fn already_read(rel_path: &str) -> String {
    format!(
        "{rel_path} has not changed since you read it earlier in this session, so its contents \
         are already in this conversation — use them rather than reading it again. To see a \
         different part of the file, call Read with offset/limit. To find something in it, call \
         Grep. To modify it, call Edit now: the read-before-edit precondition is already \
         satisfied."
    )
}

/// A write failed and the original file is intact, because writes go through a
/// temporary file and a rename.
pub fn write_failed(rel_path: &str, err: &str) -> String {
    format!("Failed to write {rel_path}: {err}. The original file is unchanged.")
}

/// Read miss with sibling suggestions.
pub fn read_did_you_mean(file_path: &str, siblings: &[String]) -> String {
    if siblings.is_empty() {
        format!("File not found: {file_path}")
    } else {
        format!(
            "File not found: {file_path}\n\nDid you mean one of these?\n{}",
            siblings.join("\n")
        )
    }
}

/// Decode-failure message that re-prompts the model with the *concrete* shape it
/// must send. `example` is a minimal valid arguments object for `tool` — naming
/// the required fields and showing JSON types is what lets weak models recover
/// (a bare serde error like "expected struct Input" does not).
pub fn decode_failure(tool: &str, err: &str, example: &str) -> String {
    format!(
        "Invalid input for {tool}: {err}. Call {tool} with a JSON object that matches its \
         schema — for example: {example}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_shows_window_and_steer() {
        let content = "fn a() {\n    let x = 1;\n    let y = 2;\n}\n";
        let msg = edit_not_found("a.rs", "    let x = 99;", content);
        assert!(msg.contains("Could not find old_string"));
        assert!(msg.contains("let x = 1;")); // nearby real line shown
        assert!(msg.contains("This file is small")); // 5 lines -> steer
    }

    #[test]
    fn big_file_no_steer() {
        let content: String = (0..100).map(|i| format!("line {i}\n")).collect();
        let msg = edit_not_found("big.rs", "nope", &content);
        assert!(!msg.contains("This file is small"));
    }

    #[test]
    fn decode_failure_shows_example() {
        let msg = decode_failure(
            "Read",
            "invalid type: null, expected struct Input",
            r#"{"file_path": "src/main.rs"}"#,
        );
        assert!(msg.contains("Invalid input for Read"));
        // The concrete example (with the required field name) must be present.
        assert!(msg.contains(r#"{"file_path": "src/main.rs"}"#));
    }

    #[test]
    fn precondition_messages_say_what_to_do_next() {
        let unread = must_read_first("src/lib.rs");
        assert!(unread.contains("src/lib.rs"));
        assert!(unread.contains("Read"), "must name the recovery action");

        let stale = file_changed("src/lib.rs");
        assert!(stale.contains("changed"));
        assert!(
            stale.contains("was not applied"),
            "the model must know the write did not land"
        );
    }

    #[test]
    fn the_repeat_read_message_names_every_way_forward() {
        // A model that is told "no" without being told "instead" falls back to
        // a shell `cat`, which costs the same tokens and skips the registry.
        let msg = already_read("src/lib.rs");
        assert!(msg.contains("src/lib.rs"));
        for way_out in ["offset/limit", "Grep", "Edit"] {
            assert!(msg.contains(way_out), "no mention of {way_out}: {msg}");
        }
    }

    #[test]
    fn write_failure_says_the_original_survived() {
        let msg = write_failed("a.rs", "disk full");
        assert!(msg.contains("disk full"));
        assert!(msg.contains("unchanged"));
    }

    #[test]
    fn did_you_mean_formats() {
        let s = read_did_you_mean("/p/main.rs", &["/p/main.rss".into(), "/p/maine.rs".into()]);
        assert!(s.contains("Did you mean"));
        assert!(s.contains("/p/main.rss"));
    }
}
