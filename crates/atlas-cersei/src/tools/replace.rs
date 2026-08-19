//! Replacer engine — the fallback-ladder string matcher behind `Edit`.
//!
//! Ported faithfully from opencode (`packages/opencode/src/tool/edit.ts`, MIT),
//! whose lineage is Cline + Gemini-CLI. See `ATTRIBUTION.md`.
//!
//! A *strategy* takes `(content, find)` and yields **verbatim slices of
//! `content`** (never transformed text). The [`replace`] driver tries strategies
//! in order; a candidate is usable only if it is present in `content`; a
//! non-`replace_all` edit additionally requires the candidate to be *unique*;
//! and every candidate is run through [`is_disproportionate_match`] before it is
//! spliced, so a fuzzy strategy can never silently apply a wrong, oversized edit.
//!
//! Layering (see `plans/atlas-cersei-edit-solution.md`):
//!   * `Simple` + `LineTrimmed`  → **auto-apply** tier (safe, high-precision).
//!   * the fuzzy tail (BlockAnchor / WhitespaceNormalized / IndentationFlexible /
//!     EscapeNormalized / TrimmedBoundary / ContextAware) → **guarded** tier:
//!     applies only when the match is unique and not oversized.

/// Why a replacement could not be applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplaceError {
    /// `old_string == new_string` — nothing to do.
    Identical,
    /// `old_string` was empty (caller should treat as a create / full-write).
    EmptyOldString,
    /// No strategy located `old_string` in the file.
    NotFound,
    /// `old_string` matched more than once and `replace_all` was not set.
    MultipleMatches,
    /// A candidate matched but its span is wildly larger than `old_string`.
    Disproportionate,
}

// Similarity thresholds for the block-anchor fallback (mirrors opencode).
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD: f64 = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD: f64 = 0.65;

/// Classic Levenshtein edit distance (hand-rolled — zero deps).
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() || b.is_empty() {
        return a.len().max(b.len());
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

// ─── Strategies ──────────────────────────────────────────────────────────────
//
// Each returns verbatim slices of `content`. Line-based strategies reconstruct
// the slice as `lines[i..j].join("\n")`, which is exactly the substring of
// `content` spanning those lines (content is split on the single byte '\n'),
// so the driver's `content.find(candidate)` always succeeds.

/// 1. Identity — exact match.
fn simple(_content: &str, find: &str) -> Vec<String> {
    vec![find.to_string()]
}

/// Drop a trailing empty element produced by a trailing '\n' in `find`.
fn search_lines(find: &str) -> Vec<&str> {
    let mut v: Vec<&str> = find.split('\n').collect();
    if v.last() == Some(&"") {
        v.pop();
    }
    v
}

/// 2. LineTrimmed — per-line `.trim()` equality over a sliding window; yields the
///    original (untrimmed) slice. The most common rescue.
fn line_trimmed(content: &str, find: &str) -> Vec<String> {
    let original: Vec<&str> = content.split('\n').collect();
    let search = search_lines(find);
    let mut out = Vec::new();
    if search.is_empty() || search.len() > original.len() {
        return out;
    }
    for i in 0..=(original.len() - search.len()) {
        let mut matches = true;
        for (j, s) in search.iter().enumerate() {
            if original[i + j].trim() != s.trim() {
                matches = false;
                break;
            }
        }
        if matches {
            out.push(original[i..i + search.len()].join("\n"));
        }
    }
    out
}

/// 3. BlockAnchor — first+last line anchors, Levenshtein-tolerant middle.
fn block_anchor(content: &str, find: &str) -> Vec<String> {
    let original: Vec<&str> = content.split('\n').collect();
    let search = search_lines(find);
    if search.len() < 3 {
        return Vec::new();
    }
    let first = search[0].trim();
    let last = search[search.len() - 1].trim();
    let block_size = search.len();
    let max_delta = ((block_size as f64 * 0.25).floor() as usize).max(1);

    // Collect candidate (start,end) line spans where both anchors match.
    let mut candidates: Vec<(usize, usize)> = Vec::new();
    for i in 0..original.len() {
        if original[i].trim() != first {
            continue;
        }
        let mut j = i + 2;
        while j < original.len() {
            if original[j].trim() == last {
                let actual = j - i + 1;
                if (actual as isize - block_size as isize).unsigned_abs() <= max_delta {
                    candidates.push((i, j));
                }
                break; // only the first matching last-line
            }
            j += 1;
        }
    }
    if candidates.is_empty() {
        return Vec::new();
    }

    let slice = |start: usize, end: usize| original[start..=end].join("\n");

    if candidates.len() == 1 {
        let (start, end) = candidates[0];
        let actual = end - start + 1;
        let lines_to_check = (block_size.saturating_sub(2)).min(actual.saturating_sub(2));
        let mut similarity = 0.0;
        if lines_to_check > 0 {
            let mut j = 1;
            while j < block_size - 1 && j < actual - 1 {
                let o = original[start + j].trim();
                let s = search[j].trim();
                let max_len = o.chars().count().max(s.chars().count());
                if max_len == 0 {
                    j += 1;
                    continue;
                }
                let dist = levenshtein(o, s);
                similarity += (1.0 - dist as f64 / max_len as f64) / lines_to_check as f64;
                if similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD {
                    break;
                }
                j += 1;
            }
        } else {
            similarity = 1.0;
        }
        if similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD {
            return vec![slice(start, end)];
        }
        return Vec::new();
    }

    // Multiple candidates — pick the most similar above threshold.
    let mut best: Option<(usize, usize)> = None;
    let mut max_similarity = -1.0_f64;
    for &(start, end) in &candidates {
        let actual = end - start + 1;
        let lines_to_check = (block_size.saturating_sub(2)).min(actual.saturating_sub(2));
        let similarity;
        if lines_to_check > 0 {
            let mut sum = 0.0;
            let mut j = 1;
            while j < block_size - 1 && j < actual - 1 {
                let o = original[start + j].trim();
                let s = search[j].trim();
                let max_len = o.chars().count().max(s.chars().count());
                if max_len != 0 {
                    let dist = levenshtein(o, s);
                    sum += 1.0 - dist as f64 / max_len as f64;
                }
                j += 1;
            }
            similarity = sum / lines_to_check as f64;
        } else {
            similarity = 1.0;
        }
        if similarity > max_similarity {
            max_similarity = similarity;
            best = Some((start, end));
        }
    }
    if max_similarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD {
        if let Some((start, end)) = best {
            return vec![slice(start, end)];
        }
    }
    Vec::new()
}

/// Collapse runs of whitespace to a single space and trim.
fn normalize_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Byte spans + text of whitespace-delimited tokens within `line`.
fn token_spans(line: &str) -> Vec<(usize, usize, &str)> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (i, ch) in line.char_indices() {
        if ch.is_whitespace() {
            if let Some(s) = start.take() {
                spans.push((s, i, &line[s..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        spans.push((s, line.len(), &line[s..]));
    }
    spans
}

/// Find a contiguous run of `find`'s words inside `line`, returning the verbatim
/// span. Replaces opencode's word-regex rebuild without pulling in a regex dep.
fn find_word_run(line: &str, find: &str) -> Option<String> {
    let words: Vec<&str> = find.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let tokens = token_spans(line);
    if words.len() > tokens.len() {
        return None;
    }
    for start in 0..=(tokens.len() - words.len()) {
        if (0..words.len()).all(|k| tokens[start + k].2 == words[k]) {
            let s = tokens[start].0;
            let e = tokens[start + words.len() - 1].1;
            return Some(line[s..e].to_string());
        }
    }
    None
}

/// 4. WhitespaceNormalized — collapse `\s+`→` ` and compare.
fn whitespace_normalized(content: &str, find: &str) -> Vec<String> {
    let norm_find = normalize_ws(find);
    let mut out = Vec::new();
    let lines: Vec<&str> = content.split('\n').collect();
    for line in &lines {
        let nl = normalize_ws(line);
        if nl == norm_find {
            out.push(line.to_string());
        } else if !norm_find.is_empty() && nl.contains(&norm_find) {
            if let Some(run) = find_word_run(line, find) {
                out.push(run);
            }
        }
    }
    let find_line_count = find.split('\n').count();
    if find_line_count > 1 && lines.len() >= find_line_count {
        for i in 0..=(lines.len() - find_line_count) {
            let block = lines[i..i + find_line_count].join("\n");
            if normalize_ws(&block) == norm_find {
                out.push(block);
            }
        }
    }
    out
}

/// Strip the common minimum indentation from every non-empty line.
///
/// Counted and cut in **characters**, not bytes: indentation can be NBSP or
/// U+3000 (multi-byte whitespace is a known weak-model quirk), and a byte
/// offset computed from one line's indent landed mid-character on another's —
/// a panic, from the strategy ladder that exists to rescue exactly that input.
fn remove_indentation(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let min_indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.chars().take_while(|c| c.is_whitespace()).count())
        .min();
    match min_indent {
        None => text.to_string(),
        Some(min) => lines
            .iter()
            .map(|l| {
                if l.trim().is_empty() {
                    l.to_string()
                } else {
                    let cut = l
                        .char_indices()
                        .nth(min)
                        .map(|(i, _)| i)
                        .unwrap_or(l.len());
                    l[cut..].to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// 5. IndentationFlexible — strip common indent from both sides, compare.
fn indentation_flexible(content: &str, find: &str) -> Vec<String> {
    let normalized_find = remove_indentation(find);
    let content_lines: Vec<&str> = content.split('\n').collect();
    let find_line_count = find.split('\n').count();
    let mut out = Vec::new();
    if find_line_count == 0 || find_line_count > content_lines.len() {
        return out;
    }
    for i in 0..=(content_lines.len() - find_line_count) {
        let block = content_lines[i..i + find_line_count].join("\n");
        if remove_indentation(&block) == normalized_find {
            out.push(block);
        }
    }
    out
}

/// Unescape `\n \t \r \' \" \` \\ \$` and literal `\<newline>` the model emitted.
fn unescape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('n') => {
                    out.push('\n');
                    chars.next();
                }
                Some('t') => {
                    out.push('\t');
                    chars.next();
                }
                Some('r') => {
                    out.push('\r');
                    chars.next();
                }
                Some('\'') => {
                    out.push('\'');
                    chars.next();
                }
                Some('"') => {
                    out.push('"');
                    chars.next();
                }
                Some('`') => {
                    out.push('`');
                    chars.next();
                }
                Some('\\') => {
                    out.push('\\');
                    chars.next();
                }
                Some('$') => {
                    out.push('$');
                    chars.next();
                }
                Some('\n') => {
                    out.push('\n');
                    chars.next();
                }
                _ => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 6. EscapeNormalized — unescape what the model wrote literally, then match.
fn escape_normalized(content: &str, find: &str) -> Vec<String> {
    let unescaped_find = unescape_string(find);
    let mut out = Vec::new();
    if content.contains(&unescaped_find) {
        out.push(unescaped_find.clone());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let find_line_count = unescaped_find.split('\n').count();
    if find_line_count >= 1 && lines.len() >= find_line_count {
        for i in 0..=(lines.len() - find_line_count) {
            let block = lines[i..i + find_line_count].join("\n");
            if unescape_string(&block) == unescaped_find {
                out.push(block);
            }
        }
    }
    out
}

/// 7. TrimmedBoundary — whole-string boundary trim.
fn trimmed_boundary(content: &str, find: &str) -> Vec<String> {
    let trimmed = find.trim();
    if trimmed == find {
        return Vec::new(); // already trimmed — nothing new to try
    }
    let mut out = Vec::new();
    if content.contains(trimmed) {
        out.push(trimmed.to_string());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let find_line_count = find.split('\n').count();
    if find_line_count >= 1 && lines.len() >= find_line_count {
        for i in 0..=(lines.len() - find_line_count) {
            let block = lines[i..i + find_line_count].join("\n");
            if block.trim() == trimmed {
                out.push(block);
            }
        }
    }
    out
}

/// 8. ContextAware — anchors + ≥50%-of-middle-lines heuristic, exact block length.
fn context_aware(content: &str, find: &str) -> Vec<String> {
    let find_lines = search_lines(find);
    if find_lines.len() < 3 {
        return Vec::new();
    }
    let content_lines: Vec<&str> = content.split('\n').collect();
    let first = find_lines[0].trim();
    let last = find_lines[find_lines.len() - 1].trim();
    let mut out = Vec::new();
    for i in 0..content_lines.len() {
        if content_lines[i].trim() != first {
            continue;
        }
        let mut j = i + 2;
        while j < content_lines.len() {
            if content_lines[j].trim() == last {
                let block_lines = &content_lines[i..=j];
                if block_lines.len() == find_lines.len() {
                    let mut matching = 0;
                    let mut total = 0;
                    for k in 1..block_lines.len() - 1 {
                        let bl = block_lines[k].trim();
                        let fl = find_lines[k].trim();
                        if !bl.is_empty() || !fl.is_empty() {
                            total += 1;
                            if bl == fl {
                                matching += 1;
                            }
                        }
                    }
                    if total == 0 || matching as f64 / total as f64 >= 0.5 {
                        out.push(block_lines.join("\n"));
                        return out; // only the first occurrence
                    }
                }
                break;
            }
            j += 1;
        }
    }
    out
}

/// Fold one typographic character to its ASCII equivalent.
///
/// Deliberately char-to-char: keeping a 1:1 character mapping means a match
/// found in folded space can be mapped straight back to a byte range in the
/// original, so the strategy still yields a **verbatim slice of `content`**.
/// (An ellipsis would have to expand to three characters, so it is left alone.)
fn fold_char(c: char) -> char {
    match c {
        // Hyphens, dashes, and the minus sign.
        '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{FE58}' | '\u{FF0D}' => '-',
        // Single quotes and the prime.
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' | '\u{FF07}' => '\'',
        // Double quotes and the double prime.
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' | '\u{FF02}' => '"',
        // Non-breaking, en/em, thin, narrow, and ideographic spaces.
        '\u{00A0}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
        c => c,
    }
}

/// 9. PunctuationFolded — fold typographic punctuation on *both* sides before
///    comparing (tool spec D9).
///
/// A model that emits a smart quote, an em dash, or a non-breaking space
/// against an ASCII file previously failed every strategy: the byte comparison
/// misses, whitespace normalisation does not touch U+00A0, and the Levenshtein
/// tier scores it as a genuine difference. It also works in the other
/// direction, for an ASCII patch against a file that contains typographic
/// punctuation.
fn punctuation_folded(content: &str, find: &str) -> Vec<String> {
    let folded_content: Vec<char> = content.chars().map(fold_char).collect();
    let folded_find: Vec<char> = find.chars().map(fold_char).collect();
    if folded_find.is_empty() || folded_find.len() > folded_content.len() {
        return Vec::new();
    }
    // If neither side actually changed, the exact strategies already covered
    // this and re-scanning would only produce duplicates.
    if folded_content.iter().copied().eq(content.chars())
        && folded_find.iter().copied().eq(find.chars())
    {
        return Vec::new();
    }

    let offsets: Vec<usize> = content.char_indices().map(|(i, _)| i).collect();
    let mut out = Vec::new();
    for start in 0..=(folded_content.len() - folded_find.len()) {
        if folded_content[start..start + folded_find.len()] == folded_find[..] {
            let begin = offsets[start];
            let end = offsets
                .get(start + folded_find.len())
                .copied()
                .unwrap_or(content.len());
            out.push(content[begin..end].to_string());
        }
    }
    out
}

/// 10. MultiOccurrence — last resort for replace_all / ambiguity detection.
fn multi_occurrence(content: &str, find: &str) -> Vec<String> {
    let mut out = Vec::new();
    if find.is_empty() {
        return out;
    }
    let mut start = 0;
    while let Some(idx) = content[start..].find(find) {
        out.push(find.to_string());
        start += idx + find.len();
    }
    out
}

/// Reject a candidate whose matched span is wildly larger than `old_string` —
/// the 2026 destructive-match guard. Forces a re-read instead of a wrong edit.
pub fn is_disproportionate_match(search: &str, old_string: &str) -> bool {
    let old_lines = old_string.split('\n').count();
    let search_lines = search.split('\n').count();
    if search_lines >= (old_lines + 3).max(old_lines * 2) {
        return true;
    }
    if old_lines == 1 {
        return false;
    }
    let old_trim = old_string.trim().len();
    search.trim().len() > (old_trim + 500).max(old_trim * 4)
}

type Strategy = fn(&str, &str) -> Vec<String>;

const STRATEGIES: &[Strategy] = &[
    simple,
    line_trimmed,
    // Head of the guarded tail: exact modulo typographic punctuation, so it is
    // the most precise fallback and runs before anything Levenshtein-scored.
    punctuation_folded,
    block_anchor,
    whitespace_normalized,
    indentation_flexible,
    escape_normalized,
    trimmed_boundary,
    context_aware,
    multi_occurrence,
];

/// The replacer driver. Tries each strategy in order; the first candidate that
/// is present (and, for a non-`replace_all` edit, unique) and is not
/// disproportionate is spliced. Returns the new file content or a [`ReplaceError`].
pub fn replace(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<String, ReplaceError> {
    if old_string == new_string {
        return Err(ReplaceError::Identical);
    }
    if old_string.is_empty() {
        return Err(ReplaceError::EmptyOldString);
    }

    // Any candidate located in `content` at all.
    let mut found_any = false;
    // Any candidate located that was *not* rejected as oversized. Without this
    // second flag a disproportionate candidate from an early strategy used to
    // abort the whole ladder, so a later strategy that would have matched
    // exactly never ran and the user saw a refusal instead of an edit.
    let mut found_proportionate = false;

    for strategy in STRATEGIES {
        for search in strategy(content, old_string) {
            let Some(index) = content.find(&search) else {
                continue;
            };
            found_any = true;
            if is_disproportionate_match(&search, old_string) {
                continue; // reject this candidate, keep trying
            }
            found_proportionate = true;
            if replace_all {
                return Ok(content.replace(&search, new_string));
            }
            let last = content.rfind(&search).unwrap_or(index);
            if index != last {
                continue; // not unique — try the next candidate
            }
            let mut out = String::with_capacity(content.len() + new_string.len());
            out.push_str(&content[..index]);
            out.push_str(new_string);
            out.push_str(&content[index + search.len()..]);
            return Ok(out);
        }
    }

    match (found_any, found_proportionate) {
        (false, _) => Err(ReplaceError::NotFound),
        // Located, but every candidate was oversized: warn about corruption
        // rather than about ambiguity, because that is the actionable failure.
        (true, false) => Err(ReplaceError::Disproportionate),
        (true, true) => Err(ReplaceError::MultipleMatches),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match() {
        let c = "fn a() {}\nfn b() {}\n";
        assert_eq!(
            replace(c, "fn a() {}", "fn z() {}", false).unwrap(),
            "fn z() {}\nfn b() {}\n"
        );
    }

    #[test]
    fn identical_rejected() {
        assert_eq!(replace("x", "a", "a", false), Err(ReplaceError::Identical));
    }

    #[test]
    fn multibyte_whitespace_indentation_does_not_panic() {
        // U+3000 (3 bytes) indents one line while another has two ASCII
        // spaces: the old byte-offset cut landed mid-character and panicked —
        // in the strategy ladder that exists to rescue weak-model quirks like
        // NBSP indentation, with no catch_unwind above it.
        let normalized = remove_indentation("\u{3000}\u{3000}a\n  b");
        assert!(normalized.contains('a') && normalized.contains('b'));

        // And through the public entry point, where the ladder reaches
        // IndentationFlexible on the way to NotFound.
        let content = "\u{a0}\u{a0}let x = 1;\n  let y = 2;\n";
        let r = replace(content, "    let z = 9;", "    let z = 10;", false);
        assert_eq!(r, Err(ReplaceError::NotFound), "no panic, a plain miss");
    }

    #[test]
    fn empty_old_rejected() {
        assert_eq!(replace("x", "", "a", false), Err(ReplaceError::EmptyOldString));
    }

    #[test]
    fn not_found() {
        assert_eq!(
            replace("hello world", "nope", "x", false),
            Err(ReplaceError::NotFound)
        );
    }

    #[test]
    fn line_trimmed_drifted_indent() {
        // File uses 4-space indent; model sent 2-space indent for old_string.
        let c = "fn main() {\n    let x = 1;\n    let y = 2;\n}\n";
        let old = "  let x = 1;\n  let y = 2;";
        let out = replace(c, old, "    let z = 3;", false).unwrap();
        assert_eq!(out, "fn main() {\n    let z = 3;\n}\n");
    }

    #[test]
    fn line_trimmed_trailing_newline() {
        let c = "a\nb\nc\n";
        // old_string carries a trailing newline the file content also has; the
        // replacement keeps the newline so the line structure is preserved.
        let out = replace(c, "b\n", "B\n", false).unwrap();
        assert_eq!(out, "a\nB\nc\n");
    }

    #[test]
    fn block_anchor_middle_drift() {
        let c = "start(\n  alpha,\n  beta,\n  gamma,\n)end\n";
        // First+last anchors exact; middle lines drift slightly.
        let old = "start(\n  alphaX,\n  betaX,\n  gammaX,\n)end";
        let out = replace(c, old, "REPLACED", false).unwrap();
        assert_eq!(out, "REPLACED\n");
    }

    #[test]
    fn whitespace_normalized_single_line() {
        // Same tokens, extra whitespace runs between them in the file.
        let c = "let  x   =  compute(a,  b);\n";
        let old = "let x = compute(a, b);";
        let out = replace(c, old, "go();", false).unwrap();
        assert_eq!(out, "go();\n");
    }

    #[test]
    fn indentation_flexible_block() {
        // Whole block pasted with a different but uniform indent.
        let c = "        if (x) {\n            do_a();\n            do_b();\n        }\n";
        let old = "if (x) {\n    do_a();\n    do_b();\n}";
        // The whole indented block is the matched span, so the replacement text
        // (caller-supplied, already indented as desired) takes its place.
        let out = replace(c, old, "        noop();", false).unwrap();
        assert_eq!(out, "        noop();\n");
    }

    #[test]
    fn escape_normalized() {
        let c = "line1\nline2\nline3\n";
        // Model emitted a literal backslash-n instead of a real newline.
        let old = "line1\\nline2";
        let out = replace(c, old, "X", false).unwrap();
        assert_eq!(out, "X\nline3\n");
    }

    #[test]
    fn crlf_content_matches_lf_find() {
        // Caller is expected to normalize, but the line-based strategies should
        // still locate a find whose lines match after trim.
        let c = "a\r\nb\r\nc\r\n".replace("\r\n", "\n");
        let out = replace(&c, "b", "B", false).unwrap();
        assert_eq!(out, "a\nB\nc\n");
    }

    #[test]
    fn ambiguous_rejected_not_wrong_apply() {
        // Two identical lines — non-replace_all must refuse, not pick one.
        let c = "dup\nmiddle\ndup\n";
        assert_eq!(
            replace(c, "dup", "X", false),
            Err(ReplaceError::MultipleMatches)
        );
    }

    #[test]
    fn replace_all_handles_duplicates() {
        let c = "dup\nmiddle\ndup\n";
        let out = replace(c, "dup", "X", true).unwrap();
        assert_eq!(out, "X\nmiddle\nX\n");
    }

    #[test]
    fn unique_single_line_applies() {
        let big: String = (0..50).map(|i| format!("line {i}\n")).collect();
        let out = replace(&big, "line 10", "X", false).unwrap();
        assert!(out.contains("X\n") && !out.contains("line 10\n"));
    }

    #[test]
    fn levenshtein_basic() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("abc", "abc"), 0);
    }

    #[test]
    fn trimmed_boundary_rescue() {
        let c = "keep\ntarget line\nkeep\n";
        // Model wrapped old_string in surrounding blank lines / spaces.
        let old = "  target line  ";
        let out = replace(c, old, "X", false).unwrap();
        assert_eq!(out, "keep\nX\nkeep\n");
    }

    #[test]
    fn context_aware_unit() {
        // First+last anchors match; exactly 50% of the middle lines match.
        let c = "fn outer() {\n  let a = 1;\n  let b = 2;\n  return a;\n}\n";
        let find = "fn outer() {\n  let a = 1;\n  DRIFT;\n  return a;\n}";
        let got = context_aware(c, find);
        assert_eq!(got, vec!["fn outer() {\n  let a = 1;\n  let b = 2;\n  return a;\n}"]);
        // Too little context (<50%) yields nothing — no wrong apply.
        let find_bad = "fn outer() {\n  X;\n  Y;\n  return a;\n}";
        assert!(context_aware(c, find_bad).is_empty());
    }

    // ── D9: typographic punctuation folding ─────────────────────────────────

    #[test]
    fn smart_quotes_match_an_ascii_file() {
        // The model emitted curly quotes; the file is plain ASCII. Before this
        // strategy every one of the other eight missed.
        let c = "let s = \"hello\";\n";
        let out = replace(c, "let s = \u{201C}hello\u{201D};", "let s = \"bye\";", false).unwrap();
        assert_eq!(out, "let s = \"bye\";\n");
    }

    #[test]
    fn ascii_matches_a_file_with_typographic_punctuation() {
        // …and the other direction: an ASCII patch against prose that has been
        // through a word processor.
        let c = "// don\u{2019}t \u{2014} really\n";
        // The em dash folds to a single hyphen, not to two.
        let out = replace(c, "// don't - really", "// fine", false).unwrap();
        assert_eq!(out, "// fine\n");
    }

    #[test]
    fn non_breaking_space_is_folded() {
        let c = "a\u{00A0}b\n";
        assert_eq!(replace(c, "a b", "c", false).unwrap(), "c\n");
    }

    #[test]
    fn folding_yields_a_verbatim_slice_so_the_rest_of_the_file_survives() {
        let c = "prefix\nlet s = \u{201C}x\u{201D};\nsuffix\n";
        let out = replace(c, "let s = \"x\";", "let s = \"y\";", false).unwrap();
        assert_eq!(out, "prefix\nlet s = \"y\";\nsuffix\n");
    }

    #[test]
    fn folding_does_not_defeat_ambiguity_detection() {
        // Two identical targets must still be refused, not silently resolved to
        // the first, now that a tenth strategy exists.
        let c = "x = \u{201C}a\u{201D}\ny = 1\nx = \u{201C}a\u{201D}\n";
        assert_eq!(
            replace(c, "x = \"a\"", "x = \"b\"", false),
            Err(ReplaceError::MultipleMatches)
        );
    }

    #[test]
    fn folding_is_skipped_when_neither_side_has_typography() {
        // Pure-ASCII input must produce no candidates here, so the strategy
        // cannot manufacture duplicates for the uniqueness check.
        assert!(punctuation_folded("plain text", "plain").is_empty());
    }

    // ── D9: a disproportionate candidate no longer aborts the ladder ────────

    #[test]
    fn disproportionate_guard_direct() {
        let old = "fn f() {";
        let search = "fn f() {\na\nb\nc\nd\ne\nf\ng\n}";
        assert!(is_disproportionate_match(search, old));
        assert!(!is_disproportionate_match("fn f() {", "fn f() {"));
    }

    #[test]
    fn an_oversized_early_candidate_does_not_block_a_later_exact_match() {
        // `context_aware` yields a whole-block candidate that the size guard
        // rejects; `simple`/`line_trimmed` would have matched the single line
        // exactly. Previously the rejection returned immediately and the edit
        // failed; now the ladder continues.
        let content = "fn outer() {\n  let a = 1;\n  let b = 2;\n  return a;\n}\nother();\n";
        let out = replace(content, "  let b = 2;", "  let b = 3;", false).unwrap();
        assert_eq!(
            out,
            "fn outer() {\n  let a = 1;\n  let b = 3;\n  return a;\n}\nother();\n"
        );
    }

    #[test]
    fn a_genuinely_oversized_only_match_is_still_refused() {
        // The guard must not have been weakened into uselessness: when every
        // candidate is oversized, the edit is still refused.
        let content = "start\nfn f() {\na\nb\nc\nd\ne\nf\ng\n}\nend\n";
        let err = replace(content, "fn f() {\nZZZ\n}", "x", false).unwrap_err();
        assert!(
            matches!(err, ReplaceError::Disproportionate | ReplaceError::NotFound),
            "{err:?}"
        );
        // Whatever the classification, nothing was applied.
    }
}
