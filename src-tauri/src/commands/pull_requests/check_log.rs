//! A check's log, read on demand: which job a check's link names, and the
//! part of its log worth showing — the lines around the first error the
//! runner marked, cleaned of timestamps and terminal colour codes, and
//! bounded so it fits in a handoff prompt.
//!
//! Pure functions; the read itself is [`GitHub::check_log`](super::github).

/// Lines kept before the anchoring error line, and after it.
const BEFORE_ERROR: usize = 150;
const AFTER_ERROR: usize = 50;
/// Lines kept when nothing in the log is marked as an error: its end.
pub(crate) const TAIL_LINES: usize = BEFORE_ERROR + AFTER_ERROR;
/// The most a tail may weigh, after cleaning.
pub(crate) const TAIL_MAX_BYTES: usize = 32 * 1024;

const ERROR_MARK: &str = "##[error]";
/// The error line every failing step ends on; it says a step failed, not why.
const EXIT_CODE_LINE: &str = "Process completed with exit code";

/// The job a GitHub Actions check links to
/// (`https://<host>/<owner>/<name>/actions/runs/<run>/job/<job>`), when the
/// link is to this repository's own Actions. Anything else (a third-party
/// status, another repository's run) has no log this surface reads.
pub(crate) fn job_id(url: &str, host: &str, owner: &str, name: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let rest = rest.split(['?', '#']).next()?;
    let mut parts = rest.split('/');
    let same = |part: Option<&str>, want: &str| part.is_some_and(|p| p.eq_ignore_ascii_case(want));
    if !(same(parts.next(), host) && same(parts.next(), owner) && same(parts.next(), name)) {
        return None;
    }
    fn digits(part: Option<&str>) -> Option<&str> {
        part.filter(|p| (1..=20).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    }
    if parts.next() != Some("actions") || parts.next() != Some("runs") {
        return None;
    }
    digits(parts.next())?;
    if parts.next() != Some("job") {
        return None;
    }
    let job = digits(parts.next())?;
    match parts.next() {
        None | Some("") => Some(job.to_string()),
        _ => None,
    }
}

/// The runner's `2026-10-23T17:18:13.7987888Z ` in front of every line.
fn strip_timestamp(line: &str) -> &str {
    let Some((stamp, rest)) = line.split_once(' ') else {
        return line;
    };
    let bytes = stamp.as_bytes();
    let looks_like = bytes.len() >= 20
        && bytes.len() <= 40
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && stamp.ends_with('Z')
        && bytes[11..bytes.len() - 1]
            .iter()
            .all(|b| b.is_ascii_digit() || matches!(b, b':' | b'.'));
    if looks_like {
        rest
    } else {
        line
    }
}

/// Terminal escape sequences and other control characters out; tabs stay.
fn strip_controls(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek() {
                // CSI: parameters, then one final byte in `@`..=`~`.
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ESC `\`.
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

/// The part of a job's log worth reading, whether lines were left out, and
/// whether it is anchored on an error line.
///
/// The anchor is the first error line that says more than "exit code 1";
/// failing that, the last error line; failing that, the log's end.
pub(crate) fn tail(raw: &[u8]) -> (String, bool, bool) {
    let text = String::from_utf8_lossy(raw);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let lines: Vec<String> = text
        .lines()
        .map(|line| strip_controls(strip_timestamp(line)))
        .filter(|line| line != "##[endgroup]")
        .collect();
    let is_error = |line: &String| line.contains(ERROR_MARK);
    let anchor = lines
        .iter()
        .position(|l| is_error(l) && !l.contains(EXIT_CODE_LINE))
        .or_else(|| lines.iter().rposition(is_error));
    let (start, end) = match anchor {
        Some(at) => (
            at.saturating_sub(BEFORE_ERROR),
            (at + 1 + AFTER_ERROR).min(lines.len()),
        ),
        None => (lines.len().saturating_sub(TAIL_LINES), lines.len()),
    };
    let mut truncated = start > 0 || end < lines.len();
    let mut window = &lines[start..end];
    // Over the byte bound, lines go from the front: what led to the error
    // matters less than the error.
    let weight = |w: &[String]| w.iter().map(|l| l.len() + 1).sum::<usize>();
    while window.len() > 1 && weight(window) > TAIL_MAX_BYTES {
        window = &window[1..];
        truncated = true;
    }
    let mut out = window.join("\n");
    if out.len() > TAIL_MAX_BYTES {
        let mut cut = out.len() - TAIL_MAX_BYTES;
        while !out.is_char_boundary(cut) {
            cut += 1;
        }
        out = out[cut..].to_string();
        truncated = true;
    }
    (out, truncated, anchor.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_is_read_from_this_repository_s_actions_link_only() {
        let url = "https://github.com/cli/cli/actions/runs/39993862786/job/120552200774";
        assert_eq!(
            job_id(url, "github.com", "cli", "cli").as_deref(),
            Some("120552200774")
        );
        assert_eq!(
            job_id(&format!("{url}?pr=12#step:4:1"), "github.com", "CLI", "Cli").as_deref(),
            Some("120552200774")
        );
        // Another repository, another host, a run with no job, a status.
        assert_eq!(job_id(url, "github.com", "cli", "go-gh"), None);
        assert_eq!(job_id(url, "ghe.example.com", "cli", "cli"), None);
        assert_eq!(
            job_id(
                "https://github.com/cli/cli/actions/runs/39993862786",
                "github.com",
                "cli",
                "cli"
            ),
            None
        );
        assert_eq!(
            job_id(
                "https://ci.example.com/cli/cli/actions/runs/1/job/2",
                "github.com",
                "cli",
                "cli"
            ),
            None
        );
        assert_eq!(
            job_id(
                "https://github.com/cli/cli/actions/runs/1/job/2/../../x",
                "github.com",
                "cli",
                "cli"
            ),
            None
        );
        assert_eq!(
            job_id(
                "http://github.com/cli/cli/actions/runs/1/job/2",
                "github.com",
                "cli",
                "cli"
            ),
            None
        );
    }

    /// A real job log from a public repository: its colour codes and
    /// timestamps come out, and the failure is what is kept.
    #[test]
    fn a_recorded_log_keeps_the_failure_and_drops_the_noise() {
        let raw = include_bytes!("fixtures/check-log.txt");
        let (text, truncated, found_error) = tail(raw);
        assert!(found_error);
        assert!(!truncated, "the whole log fits");
        assert!(!text.contains('\u{1b}'), "colour codes are taken out");
        assert!(!text.starts_with('\u{feff}'));
        assert!(
            !text.lines().any(|l| l.starts_with("2026-10-23T")),
            "timestamps are taken out"
        );
        assert!(text.contains("GraphQL: Something went wrong"));
        assert!(text.ends_with("Cleaning up orphan processes"));
        assert!(text.contains("cat << 'EOF' | gh issue comment"));
        assert!(!text.lines().any(|l| l == "##[endgroup]"));
    }

    #[test]
    fn the_window_is_anchored_on_the_first_error_that_says_why() {
        let mut log = String::new();
        for i in 0..400 {
            log.push_str(&format!("2026-10-23T17:18:13.7987888Z line {i}\n"));
        }
        log.push_str("2026-10-23T17:18:13.7987888Z ##[error]assertion failed: left == right\n");
        for i in 0..400 {
            log.push_str(&format!("after {i}\n"));
        }
        log.push_str("##[error]Process completed with exit code 1.\n");
        let (text, truncated, found) = tail(log.as_bytes());
        assert!(found && truncated);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), BEFORE_ERROR + 1 + AFTER_ERROR);
        assert_eq!(
            lines[BEFORE_ERROR],
            "##[error]assertion failed: left == right"
        );
        assert_eq!(lines[0], "line 250");
        assert_eq!(*lines.last().unwrap(), "after 49");
    }

    #[test]
    fn with_no_error_the_end_is_kept_and_the_bytes_are_bounded() {
        let long = "x".repeat(400);
        let log: String = (0..500).map(|i| format!("{i} {long}\n")).collect();
        let (text, truncated, found) = tail(log.as_bytes());
        assert!(!found && truncated);
        assert!(text.len() <= TAIL_MAX_BYTES);
        assert!(text.ends_with(&format!("499 {long}")));
        // One enormous line is cut to its end, on a character boundary.
        let huge = "é".repeat(TAIL_MAX_BYTES);
        let (text, truncated, _) = tail(huge.as_bytes());
        assert!(truncated && text.len() <= TAIL_MAX_BYTES);
        assert!(text.chars().all(|c| c == 'é'));
    }

    #[test]
    fn escape_sequences_and_controls_are_stripped() {
        assert_eq!(
            strip_controls("\u{1b}[36;1mred\u{1b}[0m\tok\u{7}"),
            "red\tok"
        );
        assert_eq!(
            strip_controls("\u{1b}]8;;https://x\u{1b}\\link\u{1b}]8;;\u{7}"),
            "link"
        );
        assert_eq!(strip_timestamp("2026-10-23T17:18:13Z hello"), "hello");
        assert_eq!(strip_timestamp("not a stamp"), "not a stamp");
    }
}
