//! Conflict introspection helpers.
//!
//! `git diff --check` prints one line per leftover conflict marker
//! (`path:line: leftover conflict marker`); counting them per path is how
//! GitHub Desktop shows "N conflicts remaining" without reading file
//! contents (diff-check.ts). Exit code 2 means markers were found — an
//! expected outcome, not an error.

use std::collections::HashMap;

/// Parse `git diff --check` output into per-path marker counts.
pub fn parse_conflict_check(out: &str) -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for line in out.lines() {
        // "<path>:<line>: leftover conflict marker"
        let Some(rest) = line.strip_suffix(": leftover conflict marker") else {
            continue;
        };
        // Split from the RIGHT — paths may contain ':'.
        let Some((path, line_no)) = rest.rsplit_once(':') else {
            continue;
        };
        if line_no.chars().all(|c| c.is_ascii_digit()) && !line_no.is_empty() {
            *counts.entry(path.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

/// The two sides of an unmerged entry's XY code, e.g. "DU" = deleted by us,
/// modified by them. `'D'` on the chosen side means "that side deleted the
/// file" — resolving to it is a `git rm`, not a checkout.
pub fn unmerged_sides(xy: &str) -> (char, char) {
    let mut c = xy.chars();
    (c.next().unwrap_or('U'), c.next().unwrap_or('U'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_markers_per_path() {
        let out = "src/a.rs:10: leftover conflict marker\n\
                   src/a.rs:12: leftover conflict marker\n\
                   src/a.rs:14: leftover conflict marker\n\
                   note:with:colons.md:3: leftover conflict marker\n\
                   src/b.rs:1: trailing whitespace.\n";
        let c = parse_conflict_check(out);
        assert_eq!(c.get("src/a.rs"), Some(&3));
        assert_eq!(c.get("note:with:colons.md"), Some(&1));
        assert_eq!(c.get("src/b.rs"), None);
    }

    #[test]
    fn sides() {
        assert_eq!(unmerged_sides("DU"), ('D', 'U'));
        assert_eq!(unmerged_sides("UU"), ('U', 'U'));
    }
}
