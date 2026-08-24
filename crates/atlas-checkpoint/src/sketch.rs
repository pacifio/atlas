//! A compact fingerprint of file content, and the containment test the link
//! rule uses to decide whether a commit still carries an agent's work.
//!
//! # Why this exists
//!
//! The link rule's strict arm — for a file the agent *created* — used to demand
//! that the committed blob equal the agent's bytes exactly. That rejects the
//! most ordinary loop there is: the agent scaffolds a file, the developer reads
//! it and adjusts a line, then commits. One added comment and the Checkpoint
//! silently disappeared.
//!
//! Loosening it to path-alone is not an option either: the strict arm is what
//! stops "the agent created it, the human threw it away and wrote their own"
//! from being credited to the agent. So the question is not *whether* the
//! content matches but *how much* of it survived.
//!
//! # What is stored, and why not the content
//!
//! Answering that needs the agent's content at link time, which can be minutes
//! or days after the write. Keeping whole files would duplicate the worktree
//! inside `sessions.db` for every touch, so instead each write stores a
//! bounded **sketch**: the hashes of its distinct non-blank lines, lowest-value
//! first, capped at [`MAX_LINES`].
//!
//! That is a bottom-k sample, so truncation is *stable*: two versions of a file
//! that share most lines also share most of the sample, because both sides keep
//! the same low-hashed lines rather than an arbitrary prefix. A plain "first
//! N lines" cap would have made an edit near the top look like a total rewrite.
//!
//! # Containment, not similarity
//!
//! The test is asymmetric on purpose. We ask *"how much of what the agent wrote
//! is still in the commit?"* — not *"how alike are these two files?"*. A
//! developer who appends 500 lines of their own to the agent's 20 has still
//! committed the agent's work; a symmetric measure (Jaccard) would score that
//! pair as barely related and drop the link.

/// Cap on sketched lines. Bounds the stored string for generated files while
/// leaving ordinary source far below the limit.
const MAX_LINES: usize = 512;

/// Fraction of the agent's lines that must survive into the commit.
///
/// 0.5 follows git's own rename/copy-detection default: git calls a file "the
/// same file, modified" at 50% similarity, and this is the same judgement about
/// the same kind of edit. Anything stricter re-breaks the review-and-tweak loop
/// this threshold exists to support; anything looser starts crediting the agent
/// for files a human substantially rewrote.
pub const MIN_CONTAINMENT: f64 = 0.5;

/// FNV-1a. Chosen for being dependency-free, stable across runs and platforms,
/// and stored on disk — a `DefaultHasher` is explicitly not guaranteed stable
/// across Rust versions, which would silently invalidate every stored sketch on
/// a toolchain bump.
fn hash_line(line: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in line.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Sketch `content`, or `None` when there is nothing meaningful to compare.
///
/// Blank and whitespace-only lines are dropped and each line is trimmed, so
/// reindentation and trailing-whitespace churn don't count as divergence. An
/// all-blank or empty file yields `None` — a sketch of nothing would trivially
/// be contained in everything.
pub fn sketch(content: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(content).ok()?;

    let mut hashes: Vec<u32> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(hash_line)
        .collect();

    if hashes.is_empty() {
        return None;
    }

    // Sorted + deduped gives the bottom-k sample and makes the stored form
    // canonical, so the same content always produces the same string.
    hashes.sort_unstable();
    hashes.dedup();
    hashes.truncate(MAX_LINES);

    let mut out = String::with_capacity(hashes.len() * 9);
    for (i, h) in hashes.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!("{h:x}"));
    }
    Some(out)
}

fn parse(sketch: &str) -> Vec<u32> {
    sketch
        .split(',')
        .filter_map(|s| u32::from_str_radix(s, 16).ok())
        .collect()
}

/// What fraction of `agent`'s lines appear in `committed`, in `0.0..=1.0`.
///
/// Both inputs are sorted and deduped by [`sketch`], so this is a linear merge.
/// An unparseable or empty `agent` sketch yields `0.0` — absence of evidence
/// must not read as a match.
pub fn containment(agent: &str, committed: &str) -> f64 {
    let a = parse(agent);
    let b = parse(committed);
    if a.is_empty() {
        return 0.0;
    }

    let (mut i, mut j, mut shared) = (0usize, 0usize, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Equal => {
                shared += 1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    shared as f64 / a.len() as f64
}

/// Does `committed` retain enough of `agent` to count as carrying its work?
pub fn retains_agent_work(agent: &str, committed: &str) -> bool {
    containment(agent, committed) >= MIN_CONTAINMENT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sk(s: &str) -> String {
        sketch(s.as_bytes()).expect("sketchable")
    }

    #[test]
    fn identical_content_is_fully_contained() {
        let s = sk("fn a() {}\nfn b() {}\nfn c() {}\n");
        assert_eq!(containment(&s, &s), 1.0);
        assert!(retains_agent_work(&s, &s));
    }

    #[test]
    fn the_review_and_tweak_loop_links() {
        // The exact case the old exact-match rule dropped.
        let agent = sk("pub fn generated() {}\n");
        let committed = sk("pub fn generated() {}\n// reviewed\n");
        assert!(retains_agent_work(&agent, &committed), "{}", containment(&agent, &committed));
    }

    #[test]
    fn a_full_rewrite_does_not_link() {
        // The case the strict arm exists to reject: human threw it away.
        let agent = sk("fn agent_one() {}\nfn agent_two() {}\nfn agent_three() {}\n");
        let committed = sk("fn human_one() {}\nfn human_two() {}\nfn human_three() {}\n");
        assert_eq!(containment(&agent, &committed), 0.0);
        assert!(!retains_agent_work(&agent, &committed));
    }

    #[test]
    fn half_rewritten_sits_on_the_threshold() {
        let agent = sk("a()\nb()\nc()\nd()\n");
        // Two of the agent's four lines survive → exactly 0.5, which links.
        let committed = sk("a()\nb()\nX()\nY()\n");
        assert_eq!(containment(&agent, &committed), 0.5);
        assert!(retains_agent_work(&agent, &committed));

        // One of four → 0.25, which does not.
        let mostly_gone = sk("a()\nX()\nY()\nZ()\n");
        assert_eq!(containment(&agent, &mostly_gone), 0.25);
        assert!(!retains_agent_work(&agent, &mostly_gone));
    }

    #[test]
    fn appending_human_work_still_links() {
        // Containment, not Jaccard: the agent's 3 lines all survive under 20
        // lines of human work. A symmetric measure would score this ~0.13.
        let agent = sk("fn agent_a() {}\nfn agent_b() {}\nfn agent_c() {}\n");
        let mut big = String::from("fn agent_a() {}\nfn agent_b() {}\nfn agent_c() {}\n");
        for i in 0..20 {
            big.push_str(&format!("fn human_{i}() {{}}\n"));
        }
        let committed = sk(&big);
        assert_eq!(containment(&agent, &committed), 1.0);
        assert!(retains_agent_work(&agent, &committed));
    }

    #[test]
    fn reindentation_and_trailing_space_are_not_divergence() {
        let agent = sk("fn a() {}\nfn b() {}\n");
        let committed = sk("    fn a() {}   \n\tfn b() {}\n");
        assert_eq!(containment(&agent, &committed), 1.0);
    }

    #[test]
    fn blank_lines_are_ignored() {
        let a = sk("fn a() {}\nfn b() {}\n");
        let b = sk("fn a() {}\n\n\n\nfn b() {}\n\n");
        assert_eq!(containment(&a, &b), 1.0);
    }

    #[test]
    fn empty_or_blank_content_has_no_sketch() {
        // Sketching nothing would be contained in everything, so it must be
        // `None` and fall back to the exact-hash path rather than link freely.
        assert!(sketch(b"").is_none());
        assert!(sketch(b"\n\n   \n\t\n").is_none());
    }

    #[test]
    fn binary_content_has_no_sketch() {
        assert!(sketch(&[0xff, 0xfe, 0x00, 0x01]).is_none());
    }

    #[test]
    fn an_empty_agent_sketch_never_matches() {
        // Absence of evidence must not read as a match.
        assert_eq!(containment("", &sk("fn a() {}\n")), 0.0);
        assert!(!retains_agent_work("", &sk("fn a() {}\n")));
    }

    #[test]
    fn the_sketch_is_bounded_and_canonical() {
        let mut huge = String::new();
        for i in 0..5000 {
            huge.push_str(&format!("line_{i}()\n"));
        }
        let s = sketch(huge.as_bytes()).unwrap();
        assert_eq!(s.split(',').count(), MAX_LINES);

        // Same content → same string, every time (stored on disk).
        assert_eq!(s, sketch(huge.as_bytes()).unwrap());
    }

    #[test]
    fn truncation_is_stable_under_edits() {
        // A bottom-k sample keeps the SAME lines on both sides, so a small edit
        // to a large file stays highly contained. A "first N lines" cap would
        // have scored an edit near the top as a rewrite.
        let mut agent = String::new();
        for i in 0..2000 {
            agent.push_str(&format!("line_{i}()\n"));
        }
        let mut edited = String::from("// a new header comment\n");
        edited.push_str(&agent);

        let c = containment(&sketch(agent.as_bytes()).unwrap(), &sketch(edited.as_bytes()).unwrap());
        assert!(c > 0.99, "containment collapsed under truncation: {c}");
    }

    #[test]
    fn duplicate_lines_do_not_inflate_the_score() {
        // Deduping means a file of 100 identical lines is one line of evidence,
        // so repetition can't manufacture a match.
        let agent = sk("same()\nsame()\nsame()\nunique_a()\n");
        let committed = sk("same()\ndifferent()\n");
        // Agent has 2 distinct lines; 1 survives.
        assert_eq!(containment(&agent, &committed), 0.5);
    }
}
