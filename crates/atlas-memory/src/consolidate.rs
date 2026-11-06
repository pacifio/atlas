//! Idle-time consolidation (M4): find what the record would be better
//! without (near-duplicates) and what it must not hide (contradictions).
//! Deterministic, and never a rewrite: merges are proposals the user
//! approves; contradictions become links every reader sees.

use std::collections::{BTreeSet, HashMap};

use anyhow::Result;

use crate::record::{Entry, RecordStore, LINK_CONTRADICTS, LINK_DISTINCT, LINK_SUPERSEDES};

/// Two memories this similar are proposed as one. No upper bound: keyed,
/// folded, imported and pre-model entries never merged when written, and a
/// pair that did is one entry now.
pub const PROPOSE_MERGE_AT: f32 = 0.85;
/// Two memories this similar that disagree on a number, a key or a negation
/// contradict each other.
pub const CONFLICT_AT: f32 = 0.80;
const NEGATIONS: [&str; 7] = [
    "not",
    "never",
    "no longer",
    "don't",
    "doesn't",
    "isn't",
    "instead of",
];

/// Pairs of memories that contradict each other.
pub type Conflicts = Vec<(Entry, Entry)>;

/// Near-duplicates the user may merge into `keep`.
#[derive(Debug, Clone)]
pub struct MergeProposal {
    pub keep: Entry,
    pub drop: Vec<Entry>,
}

fn numbers(s: &str) -> Vec<String> {
    let mut v: Vec<String> = s
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .filter(|t| t.chars().any(|c| c.is_ascii_digit()))
        .map(|t| t.trim_matches('.').to_string())
        .collect();
    v.sort();
    v
}

fn negated(s: &str) -> bool {
    let words: String = s
        .to_lowercase()
        .chars()
        .map(|c| match c {
            // Typographic apostrophes, as models often write them.
            '\'' | '\u{2018}' | '\u{2019}' => '\'',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    let padded = format!(
        " {} ",
        words.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    NEGATIONS.iter().any(|n| padded.contains(&format!(" {n} ")))
}

/// Whether two texts disagree on a number or a negation: the conflict
/// signal without the key (texts carry none) and without any similarity.
pub(crate) fn contradicts_text(a: &str, b: &str) -> bool {
    numbers(a) != numbers(b) || negated(a) != negated(b)
}

fn conflicts(a: &Entry, b: &Entry) -> bool {
    (!a.key.is_empty() && a.key == b.key && a.content != b.content)
        || contradicts_text(&a.content, &b.content)
}

fn cos(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let n = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n(a) == 0.0 || n(b) == 0.0 {
        0.0
    } else {
        dot / (n(a) * n(b))
    }
}

/// `(merges, conflicts)` among the active durable entries of one kind that
/// have a vector for the installed model. A pair already linked (superseded,
/// contradicting, or told apart by the user) is skipped. Merge groups are
/// single-link clusters; the survivor is the most used, then the most
/// trusted, then the newest.
pub fn proposals(store: &RecordStore) -> Result<(Vec<MergeProposal>, Conflicts)> {
    let active: Vec<(Entry, Vec<f32>)> = store
        .durable_active()?
        .into_iter()
        .filter_map(|e| store.vector_for_text(&e.content).map(|v| (e, v)))
        .collect();
    let skip = store.linked_pairs(&[LINK_SUPERSEDES, LINK_DISTINCT, LINK_CONTRADICTS])?;
    let pair = |a: i64, b: i64| (a.min(b), a.max(b));
    let mut conflicts_out = Vec::new();
    let mut edges: HashMap<i64, Vec<i64>> = HashMap::new();
    for (i, (a, va)) in active.iter().enumerate() {
        for (b, vb) in &active[i + 1..] {
            if a.kind != b.kind || skip.contains(&pair(a.id, b.id)) {
                continue;
            }
            let sim = cos(va, vb);
            if sim >= CONFLICT_AT && conflicts(a, b) {
                conflicts_out.push((a.clone(), b.clone()));
            } else if sim >= PROPOSE_MERGE_AT {
                edges.entry(a.id).or_default().push(b.id);
                edges.entry(b.id).or_default().push(a.id);
            }
        }
    }
    let by_id: HashMap<i64, &Entry> = active.iter().map(|(e, _)| (e.id, e)).collect();
    let mut seen = BTreeSet::new();
    let mut merges = Vec::new();
    let mut ids: Vec<i64> = edges.keys().copied().collect();
    ids.sort_unstable();
    for start in ids {
        if !seen.insert(start) {
            continue;
        }
        let mut group = vec![start];
        let mut i = 0;
        while i < group.len() {
            for n in edges.get(&group[i]).into_iter().flatten() {
                if seen.insert(*n) {
                    group.push(*n);
                }
            }
            i += 1;
        }
        let mut members: Vec<&Entry> = group.iter().map(|id| by_id[id]).collect();
        members.sort_by(|x, y| {
            y.uses
                .cmp(&x.uses)
                .then(y.confidence.total_cmp(&x.confidence))
                .then(y.updated_at.cmp(&x.updated_at))
                .then(x.id.cmp(&y.id))
        });
        merges.push(MergeProposal {
            keep: members[0].clone(),
            drop: members[1..].iter().map(|e| (*e).clone()).collect(),
        });
    }
    Ok((merges, conflicts_out))
}

/// Write a `contradicts` link for every conflicting pair not yet linked.
/// Idempotent; returns how many links are new.
pub fn link_contradictions(store: &RecordStore, at: i64) -> Result<usize> {
    let (_, conflicts) = proposals(store)?;
    let mut n = 0;
    for (a, b) in conflicts {
        n += usize::from(store.link(
            a.id.min(b.id),
            a.id.max(b.id),
            LINK_CONTRADICTS,
            at,
            "atlas",
        )?);
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::record::{open_scope, Embedder, Embedding, EntryKind, NewEntry, State};

    /// Texts mapped to chosen vectors, so every cosine is exact.
    struct Table(Vec<(&'static str, Vec<f32>)>);

    impl Embedder for Table {
        fn embed(&self, text: &str) -> Option<Embedding> {
            self.0
                .iter()
                .find(|(t, _)| *t == text)
                .map(|(_, v)| Embedding {
                    model: "t".into(),
                    vector: v.clone(),
                })
        }

        fn model_id(&self) -> Option<String> {
            Some("t".into())
        }
    }

    fn store_with(
        label: &str,
        table: Vec<(&'static str, Vec<f32>)>,
    ) -> (std::path::PathBuf, Arc<RecordStore>) {
        let root = std::env::temp_dir().join(format!(
            "atlas-consolidate-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(Arc::new(Table(table))));
        (root, store)
    }

    /// Keyed, so no two of them near-duplicate-merge at write time.
    fn fact(store: &RecordStore, key: &str, content: &str, session: &str, at: i64) -> Entry {
        store
            .remember(
                NewEntry {
                    kind: EntryKind::Fact,
                    key: key.into(),
                    content: content.into(),
                    source: "claude".into(),
                    agent: "claude".into(),
                    session_id: session.into(),
                    confidence: 1.0,
                    at,
                },
                at,
            )
            .unwrap()
            .entry
    }

    #[test]
    fn the_signals_read_numbers_and_negations() {
        assert_ne!(numbers("main needs Java 21"), numbers("main needs Java 17"));
        assert_eq!(numbers("Release 1.2."), vec!["1.2".to_string()]);
        assert!(negated("We don't use Redis."));
        assert!(negated("The worker doesn\u{2019}t use Redis"));
        assert!(!negated("Notes live in docs/"));
    }

    #[test]
    fn texts_contradict_on_a_number_or_a_negation() {
        assert!(contradicts_text("main needs Java 21", "main needs Java 17"));
        assert!(contradicts_text(
            "The worker doesn\u{2019}t use Redis",
            "The worker uses Redis"
        ));
        assert!(!contradicts_text(
            "Keep pull requests small",
            "Prefer small PRs"
        ));
    }

    /// Entries that never merged when written (here: two keys) are proposed
    /// however close they are.
    #[test]
    fn a_pair_above_the_write_time_threshold_is_proposed() {
        let (root, store) = store_with(
            "close",
            vec![
                ("Use tabs for indentation", vec![1.0, 0.0, 0.0]),
                ("Indent with tabs", vec![0.95, 0.312, 0.0]),
            ],
        );
        fact(&store, "indent.a", "Use tabs for indentation", "s1", 1);
        fact(&store, "indent.b", "Indent with tabs", "s1", 2);
        let (merges, conflicts) = proposals(&store).unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(merges.len(), 1);
        assert_eq!(merges[0].drop.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn contradicting_versions_are_linked_not_merged() {
        let (root, store) = store_with(
            "conflict",
            vec![
                ("main needs Java 21", vec![1.0, 0.0, 0.0]),
                ("main needs Java 17", vec![0.95, 0.312, 0.0]),
            ],
        );
        let a = fact(&store, "java.main", "main needs Java 21", "s1", 1);
        let b = fact(&store, "java.ci", "main needs Java 17", "s1", 2);
        assert_eq!(link_contradictions(&store, 3).unwrap(), 1);
        assert_eq!(link_contradictions(&store, 4).unwrap(), 0, "idempotent");
        assert_eq!(store.get(a.id, 5).unwrap().unwrap().state, State::Active);
        assert_eq!(store.get(b.id, 5).unwrap().unwrap().state, State::Active);
        assert!(
            proposals(&store).unwrap().0.is_empty(),
            "a conflict is never a merge"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn near_duplicates_become_one_proposal() {
        let (root, store) = store_with(
            "merge",
            vec![
                ("Keep pull requests small", vec![1.0, 0.0, 0.0]),
                ("Prefer small PRs", vec![0.88, 0.475, 0.0]),
                ("Small PRs are preferred", vec![0.88, -0.475, 0.0]),
            ],
        );
        let keep = fact(&store, "pr.a", "Keep pull requests small", "s1", 1);
        fact(&store, "pr.b", "Prefer small PRs", "s1", 2);
        fact(&store, "pr.c", "Small PRs are preferred", "s1", 3);
        // Restated by another session: the most-used survives.
        fact(&store, "pr.a", "Keep pull requests small", "s2", 4);
        let (merges, conflicts) = proposals(&store).unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(merges.len(), 1);
        assert_eq!(merges[0].keep.id, keep.id);
        assert_eq!(merges[0].drop.len(), 2);
        assert_eq!(
            store.durable_active().unwrap().len(),
            3,
            "nothing archived until the user merges"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dismissed_pair_is_not_proposed_again() {
        let (root, store) = store_with(
            "distinct",
            vec![
                ("Keep pull requests small", vec![1.0, 0.0, 0.0]),
                ("Prefer small PRs", vec![0.88, 0.475, 0.0]),
            ],
        );
        let a = fact(&store, "pr.a", "Keep pull requests small", "s1", 1);
        let b = fact(&store, "pr.b", "Prefer small PRs", "s1", 2);
        assert_eq!(proposals(&store).unwrap().0.len(), 1);
        store
            .link(a.id.min(b.id), a.id.max(b.id), LINK_DISTINCT, 3, "user")
            .unwrap();
        assert!(proposals(&store).unwrap().0.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
