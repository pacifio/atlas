//! Layer 6 — bounded credential key/value pairs.
//!
//! `API_KEY=supersecretvalue`, `GITHUB_TOKEN: ghp_…`, `db_password="hunter2"`.
//! The value carries no recognisable format and may be a memorable low-entropy
//! word, so nothing above catches it — but the *key* names it as a credential,
//! and that is evidence enough.
//!
//! Only the value is replaced. `API_KEY=[REDACTED]` still tells a reader which
//! variable was involved, which is most of what makes a transcript useful for
//! debugging; blanking the whole assignment throws that away for no extra
//! safety.
//!
//! This is the layer most exposed to false positives, so it is bounded three
//! ways: the key must be a whole identifier token (not a substring of a longer
//! word), a bare `:` separator is only honoured for identifier-shaped keys or a
//! quoted value so ordinary prose like "the secret: it was a race" is
//! untouched, and the value must survive the placeholder gate.
//!
//! Quoted keys — `"password": "hunter2"`, the JSON spelling — are matched too.
//! JSON *documents* go through the structure-preserving walker, but a JSON
//! fragment quoted inside a prose body never parses as a document, and this
//! layer is the only thing standing between such a fragment and disk.

use std::sync::OnceLock;

use regex::Regex;

use crate::placeholder::is_real_secret_value;
use crate::region::Region;
use crate::Category;

/// Shortest value worth flagging. Below this the "secret" is a flag or an enum
/// (`token=1`, `auth=on`) far more often than a credential.
const MIN_VALUE_LEN: usize = 4;

/// Key segments that name a credential outright.
const SECRET_WORDS: &[&str] = &[
    "secret",
    "secrets",
    "token",
    "tokens",
    "password",
    "passwords",
    "passwd",
    "passphrase",
    "credential",
    "credentials",
    "apikey",
    "authtoken",
];

/// `key` is far too common to stand alone — `cache_key`, `primary_key`,
/// `sort_key` are all ordinary. It only names a credential when qualified.
const KEY_QUALIFIERS: &[&str] = &[
    "api", "secret", "access", "private", "signing", "encryption", "auth", "client", "app",
    "service", "license", "subscription", "consumer", "publishable",
];

/// Any assignment's *key and separator* — deliberately not its value. Which of
/// them is a credential is decided in code below, because the deciding rule —
/// *the key must end in a credential word* — is not something a single regex
/// expresses without becoming unreadable and unmaintainable.
///
/// Two things are deliberately left out of this pattern, both for the same
/// reason: regex iteration is non-overlapping, so anything a match consumes is
/// hidden from every later match.
///
/// * **The value.** Consuming it made the scan blind to nested assignments:
///   `out = f("API_KEY=hunter2xyz")` matched as one assignment whose key is
///   `out`, and because `out` is not a credential the whole thing was skipped —
///   `API_KEY=` inside it was never examined. That silently leaked the shapes
///   agents record most often, `url=https://h/p?api_key=…` among them.
/// * **The character before the key.** Consuming it ate the separator the *next*
///   key needs: in `x=API_KEY=hunter2xyz` the `=` belongs to both. The boundary
///   is checked in code by [`starts_a_token`] instead.
///
/// What is left is short enough that a nested assignment is always still ahead
/// of the cursor.
fn key_separator() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"([A-Za-z0-9_.-]{1,64})[ \t]*(=|:)[ \t]*"#).expect("static pattern")
    })
}

/// The value, anchored at the offset the separator left off.
fn value_at_start() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^("[^"]*"|'[^']*'|[^\s,;&]+)"#).expect("static pattern"))
}

/// The value form for a quoted key, which stops at a JSON closing bracket too.
fn quoted_value_at_start() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^("[^"]*"|'[^']*'|[^\s,;&}\]]+)"#).expect("static pattern"))
}

/// Is the key a whole token, rather than the tail of a longer identifier?
///
/// Replaces the leading `(?:^|[^A-Za-z0-9_])` the pattern used to carry. Same
/// rule, but checked without consuming the character, so it stays available as
/// the boundary for the next key.
fn starts_a_token(input: &str, start: usize) -> bool {
    if start == 0 {
        return true;
    }
    let previous = input.as_bytes()[start - 1];
    !(previous.is_ascii_alphanumeric() || previous == b'_')
}

/// Match the value that begins at `offset`, as a byte range into `input`.
fn value_after(pattern: &Regex, input: &str, offset: usize) -> Option<(usize, usize)> {
    let found = pattern.find(input.get(offset..)?)?;
    Some((offset + found.start(), offset + found.end()))
}

/// The JSON spelling of an assignment: `"password": "hunter2"`. The pattern
/// above cannot see it — the closing quote sits between the key and the colon —
/// and a JSON fragment pasted into prose never reaches the JSON-aware walker,
/// so without this form a `{"password": "hunter2"}` snippet inside a chat
/// message would pass through the flat redactor untouched.
///
/// A quoted key needs no identifier-shape gate: the quotes themselves are the
/// evidence that this is config or data, not a word in a sentence.
/// Key and separator only, for the same non-overlapping reason as above.
fn quoted_key_separator() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?:"([A-Za-z0-9_.-]{1,64})"|'([A-Za-z0-9_.-]{1,64})')[ \t]*:[ \t]*"#)
            .expect("static pattern")
    })
}

/// Does this key name a credential?
///
/// The rule is that a credential word must be the key's **final** segment, which
/// is what separates `GITHUB_TOKEN` and `db_password` from `token_count`,
/// `secret_santa_name` and `password_policy` — all of which a substring match
/// would happily redact. Segments split on `_`, `-`, `.` and camelCase humps, so
/// `authToken` and `x-api-key` classify the same as their snake-case spellings.
fn is_credential_key(key: &str) -> bool {
    let segments = segments(key);
    let Some(last) = segments.last() else {
        return false;
    };

    if SECRET_WORDS.contains(&last.as_str()) {
        return true;
    }
    // Bare `PWD` is the shell's present-working-directory variable; redacting
    // every developer's `PWD=/Users/…` would be a daily, visible wrong answer.
    // Qualified (`db_pwd`, `mysql-pwd`) it is a password.
    if last == "pwd" && segments.len() > 1 {
        return true;
    }
    if matches!(last.as_str(), "key" | "keys") {
        return segments
            .get(segments.len().wrapping_sub(2))
            .is_some_and(|prev| KEY_QUALIFIERS.contains(&prev.as_str()));
    }
    false
}

/// Lowercase segments of a key, split on separators and camelCase humps.
fn segments(key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut prev_upper = false;
    let mut prev_lower = false;
    let mut chars = key.chars().peekable();
    while let Some(ch) = chars.next() {
        if matches!(ch, '_' | '-' | '.') {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            prev_upper = false;
            prev_lower = false;
            continue;
        }
        let next_lower = chars.peek().is_some_and(|nc| nc.is_ascii_lowercase());
        if ch.is_ascii_uppercase() && prev_lower && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        } else if ch.is_ascii_uppercase() && prev_upper && next_lower && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        prev_upper = ch.is_ascii_uppercase();
        prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        current.push(ch.to_ascii_lowercase());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

pub(crate) fn detect(input: &str) -> Vec<Region> {
    let mut regions = Vec::new();
    for captures in key_separator().captures_iter(input) {
        let (Some(whole), Some(key), Some(separator)) =
            (captures.get(0), captures.get(1), captures.get(2))
        else {
            continue;
        };

        if !starts_a_token(input, key.start()) || !is_credential_key(key.as_str()) {
            continue;
        }
        let Some((start, end)) = value_after(value_at_start(), input, whole.end()) else {
            continue;
        };
        // A bare `:` after a lone credential word is usually prose — unless the
        // value is quoted, which is the YAML spelling (`password: "hunter2"`);
        // prose does not quote what follows its colon.
        if separator.as_str() == ":"
            && !is_identifier_shaped(key.as_str())
            && !is_quoted(&input[start..end])
        {
            continue;
        }

        regions.extend(value_region(input, start, end));
    }
    for captures in quoted_key_separator().captures_iter(input) {
        let (Some(whole), Some(key)) = (
            captures.get(0),
            captures.get(1).or_else(|| captures.get(2)),
        ) else {
            continue;
        };
        if !is_credential_key(key.as_str()) {
            continue;
        }
        let Some((start, end)) = value_after(quoted_value_at_start(), input, whole.end()) else {
            continue;
        };
        regions.extend(value_region(input, start, end));
    }
    regions
}

/// Vet a matched value and turn it into a region, or decline: too short, purely
/// numeric, or a placeholder.
fn value_region(input: &str, start: usize, end: usize) -> Option<Region> {
    let (start, end) = strip_quotes(input, start, end);
    let raw = trim_trailing_delimiters(&input[start..end]);
    let end = start + raw.len();
    if raw.len() < MIN_VALUE_LEN || is_numeric(raw) || !is_real_secret_value(raw) {
        return None;
    }
    Some(Region::new(start, end, Category::CredentialValue))
}

/// Drop closing delimiters the value ran past.
///
/// An unquoted value ends at whitespace, which is right for a shell line or a
/// `.env` file and wrong everywhere else: in `f("API_KEY=hunter2xyz")` the run
/// swallows the trailing `")`, and replacing that span leaves
/// `f("API_KEY=[REDACTED]` — a corrupted line, which is the over-redaction
/// failure this crate takes as seriously as a leak. A bracket the value could
/// not itself have opened, an unpaired quote, or a trailing escape belongs to
/// the syntax around the value, so it survives the replacement.
///
/// Only ASCII bytes are trimmed, so the range stays on a character boundary.
fn trim_trailing_delimiters(value: &str) -> &str {
    let count = |bytes: &[u8], needle: u8| bytes.iter().filter(|b| **b == needle).count();
    let mut end = value.len();
    while let Some(&last) = value.as_bytes()[..end].last() {
        let bytes = &value.as_bytes()[..end];
        let runs_past = match last {
            b')' => count(bytes, b')') > count(bytes, b'('),
            b']' => count(bytes, b']') > count(bytes, b'['),
            b'}' => count(bytes, b'}') > count(bytes, b'{'),
            b'>' => count(bytes, b'>') > count(bytes, b'<'),
            b'"' | b'\'' => count(bytes, last) % 2 == 1,
            b'\\' => true,
            _ => false,
        };
        if !runs_past {
            break;
        }
        end -= 1;
    }
    &value[..end]
}

/// A purely numeric value is a port, a count, a limit — `max_tokens=4096`,
/// `"expires_in": 3600` — never a credential, whatever its key is called.
fn is_numeric(value: &str) -> bool {
    value.chars().any(|c| c.is_ascii_digit())
        && value.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Is the raw matched value wrapped in quotes?
fn is_quoted(value: &str) -> bool {
    value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
}

/// A key that reads as a variable rather than a word in a sentence: it is
/// multi-segment (`api_key`, `authToken`, `db-password`) or shouted (`SECRET`).
///
/// This gate applies only to the `:` separator, where a credential word is just
/// as likely to be prose — "the secret: it was a race condition" — as a config
/// key. `=` needs no such gate; nobody writes an equals sign in a sentence.
fn is_identifier_shaped(key: &str) -> bool {
    segments(key).len() > 1
        || (key.chars().any(|c| c.is_ascii_alphabetic())
            && !key.chars().any(|c| c.is_ascii_lowercase()))
}

/// Narrow a matched value to the inside of its quotes, so the quotes survive
/// replacement and the surrounding syntax stays valid.
fn strip_quotes(input: &str, start: usize, end: usize) -> (usize, usize) {
    if end - start < 2 {
        return (start, end);
    }
    let bytes = input.as_bytes();
    let (first, last) = (bytes[start], bytes[end - 1]);
    if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
        return (start + 1, end - 1);
    }
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(input: &str) -> Vec<&str> {
        detect(input)
            .into_iter()
            .map(|r| &input[r.start..r.end])
            .collect()
    }

    #[test]
    fn an_env_assignment_flags_only_the_value() {
        assert_eq!(spans("API_KEY=supersecretvalue123"), vec!["supersecretvalue123"]);
    }

    #[test]
    fn a_quoted_value_is_flagged_inside_its_quotes() {
        assert_eq!(spans(r#"db_password="hunter2xyz""#), vec!["hunter2xyz"]);
    }

    #[test]
    fn a_colon_separator_works_for_identifier_shaped_keys() {
        assert_eq!(spans("GITHUB_TOKEN: abcdefgh1234"), vec!["abcdefgh1234"]);
        assert_eq!(spans("api_key: abcdefgh1234"), vec!["abcdefgh1234"]);
    }

    #[test]
    fn prose_using_a_credential_word_before_a_colon_is_left_alone() {
        assert!(spans("the secret: it was a race condition all along").is_empty());
        assert!(spans("token: the parser emits one per line").is_empty());
    }

    #[test]
    fn the_present_working_directory_variable_is_not_a_password() {
        assert!(spans("PWD=/Users/nafiz/Development/atlas").is_empty());
    }

    #[test]
    fn a_prefixed_pwd_key_is_still_a_password() {
        assert_eq!(spans("db_pwd=hunter2xyz"), vec!["hunter2xyz"]);
    }

    #[test]
    fn a_key_that_merely_contains_the_word_is_not_matched_mid_identifier() {
        // `mypasswordhelper` is one identifier; the boundary rule requires the
        // key to be a whole token, and here the whole token is still matched —
        // what must not happen is matching only the `password` substring.
        let found = spans("notatoken_field=value1234");
        assert!(found.is_empty(), "unexpected: {found:?}");
    }

    #[test]
    fn placeholder_values_are_left_alone() {
        assert!(spans("API_KEY=<your-api-key>").is_empty());
        assert!(spans("db_password=changeme").is_empty());
        assert!(spans("API_KEY=[REDACTED]").is_empty());
    }

    #[test]
    fn very_short_values_are_left_alone() {
        assert!(spans("token=1").is_empty());
    }

    #[test]
    fn a_json_quoted_key_is_caught_by_the_flat_layer() {
        for (input, expected) in [
            (r#"{"password": "hunter2"}"#, "hunter2"),
            (r#"{'password': 'hunter2'}"#, "hunter2"),
            (r#""client_secret":"hunter2xyz""#, "hunter2xyz"),
            (r#"the tool sent {"api_key": "abcdefgh1234"} and failed"#, "abcdefgh1234"),
        ] {
            assert_eq!(spans(input), vec![expected], "missed: {input}");
        }
    }

    #[test]
    fn a_yaml_credential_key_with_a_quoted_value_is_caught() {
        assert_eq!(spans(r#"password: "hunter2""#), vec!["hunter2"]);
        assert_eq!(spans("secret: 'correct-horse-battery'"), vec!["correct-horse-battery"]);
    }

    #[test]
    fn quoted_non_credential_keys_are_left_alone() {
        for input in [
            r#"{"message_id": "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"}"#,
            r#"{"role": "assistant", "content": "done"}"#,
            r#"{"password_policy": "strict-rotation"}"#,
            r#"{"token_count": "many"}"#,
        ] {
            assert!(spans(input).is_empty(), "over-redacted: {input}");
        }
    }

    #[test]
    fn quoted_credential_keys_with_placeholder_values_are_left_alone() {
        assert!(spans(r#"{"password": "[REDACTED]"}"#).is_empty());
        assert!(spans(r#"{"api_key": "<your-api-key>"}"#).is_empty());
        assert!(spans(r#"{"client_secret": "changeme"}"#).is_empty());
    }

    #[test]
    fn caps_acronym_prefix_camel_keys_are_detected() {
        for (input, expected) in [
            ("APIToken=hunter2xyz", "hunter2xyz"),
            ("APISecret=hunter2xyz", "hunter2xyz"),
            ("JWTSecret=hunter2xyz", "hunter2xyz"),
            ("JWTToken=hunter2xyz", "hunter2xyz"),
            ("GCPSecret=hunter2xyz", "hunter2xyz"),
            ("DBPassword=hunter2xyz", "hunter2xyz"),
        ] {
            assert_eq!(spans(input), vec![expected], "missed: {input}");
        }
    }

    #[test]
    fn purely_numeric_values_are_not_credentials() {
        for input in [
            r#"{"max_tokens": 4096}"#,
            "max_tokens=4096",
            r#""tokens": 51234"#,
            "request_tokens: 8192.5",
        ] {
            assert!(spans(input).is_empty(), "over-redacted: {input}");
        }
    }
}
