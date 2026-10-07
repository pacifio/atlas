//! Layer 1 — Shannon entropy over long alphanumeric-ish tokens.
//!
//! This is the only layer that catches a key format nobody has written a rule
//! for yet, which is why it runs first and unconditionally. It is also the
//! bluntest, so its threshold is the single most consequential number in the
//! crate: too low and every git SHA and base64 asset in a transcript is
//! destroyed, too high and real keys walk through.

use std::sync::OnceLock;

use regex::Regex;

use crate::region::Region;
use crate::Category;

/// Minimum Shannon entropy (bits/byte) for a token to read as a secret.
///
/// 4.5 is an empirical threshold, and a well-established one for this job:
/// above common English words and identifiers, below the ~5.0+ that real API
/// keys and tokens sit at. The negative test cases in `tests/negatives.rs` are
/// what hold this number honest — changing it without running them is how a
/// transcript corpus quietly turns into `[REDACTED]` soup.
pub(crate) const ENTROPY_THRESHOLD: f64 = 4.5;

/// Candidate token shape. `/` is deliberately excluded so a long file path is
/// not swallowed as one token; base64 and JWTs still surface as high-entropy
/// segments between the slashes and dots.
fn token_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9+_=-]{10,}").expect("static pattern"))
}

pub(crate) fn detect(input: &str) -> Vec<Region> {
    let mut regions = Vec::new();
    for found in token_pattern().find_iter(input) {
        let (mut start, end) = (found.start(), found.end());

        // Don't eat the letter of a JSON escape sequence. In `"a.go\nmodel_id"`
        // the token regex can start at the `n` of `\n`; replacing from there
        // leaves a dangling `\` in front of the placeholder and produces invalid
        // JSON. Only the known escape letters are skipped, so a real secret that
        // merely follows a literal backslash still gets caught.
        if start > 0 && input.as_bytes()[start - 1] == b'\\' {
            let first = input.as_bytes()[start];
            if matches!(
                first,
                b'n' | b't' | b'r' | b'b' | b'f' | b'u' | b'"' | b'\\' | b'/'
            ) {
                start += 1;
                if end - start < 10 {
                    continue;
                }
            }
        }

        if shannon_entropy(&input[start..end]) > ENTROPY_THRESHOLD {
            regions.push(Region::new(start, end, Category::Entropy));
        }
    }
    regions
}

/// Shannon entropy in bits per byte. Byte-wise rather than char-wise: the input
/// is a credential candidate restricted to ASCII by `token_pattern`, and bytes
/// keep this allocation-free on the hot path.
pub(crate) fn shannon_entropy(value: &str) -> f64 {
    if value.is_empty() {
        return 0.0;
    }
    let mut freq = [0u32; 256];
    for &byte in value.as_bytes() {
        freq[byte as usize] += 1;
    }
    let len = value.len() as f64;
    freq.iter()
        .filter(|&&count| count > 0)
        .map(|&count| {
            let p = f64::from(count) / len;
            -p * p.log2()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entropy_of_a_uniform_string_is_zero() {
        assert_eq!(shannon_entropy("aaaaaaaa"), 0.0);
    }

    #[test]
    fn entropy_of_an_empty_string_is_zero() {
        assert_eq!(shannon_entropy(""), 0.0);
    }

    #[test]
    fn a_random_looking_key_clears_the_threshold() {
        assert!(shannon_entropy("xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA") > ENTROPY_THRESHOLD);
    }

    #[test]
    fn ordinary_prose_and_identifiers_do_not_clear_the_threshold() {
        for value in ["session_manager", "getUserByIdentifier", "documentation"] {
            assert!(
                shannon_entropy(value) <= ENTROPY_THRESHOLD,
                "{value} would be redacted"
            );
        }
    }

    #[test]
    fn a_json_escape_letter_is_not_consumed() {
        // The token regex would otherwise start at the `n` of `\n`.
        let input = r"controller.go\nxJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA";
        let regions = detect(input);
        assert_eq!(regions.len(), 1);
        assert_eq!(
            &input[regions[0].start..regions[0].end],
            "xJ3kQ9vB2mZ7pL5rT8wN4cF6yH1sD0gA"
        );
    }
}
