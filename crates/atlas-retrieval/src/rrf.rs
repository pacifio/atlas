//! Reciprocal-rank fusion. `score(id) = Σ_legs weight / (K + rank)` with a
//! 1-based rank; priors add only to ids some leg already found. Output is
//! in a total order: score descending, then id ascending.

use std::collections::HashMap;
use std::hash::Hash;

/// The standard damping constant; the code index uses the same.
pub const K: f64 = 60.0;

pub struct Fused<Id> {
    pub id: Id,
    pub score: f64,
    /// `(leg name, 1-based rank)` for every leg (not prior) that found it.
    pub legs: Vec<(&'static str, usize)>,
}

/// A running score and the `(leg, rank)` pairs behind it.
type Entry = (f64, Vec<(&'static str, usize)>);

pub struct Fusion<Id: Eq + Hash + Clone + Ord> {
    scores: HashMap<Id, Entry>,
}

impl<Id: Eq + Hash + Clone + Ord> Default for Fusion<Id> {
    fn default() -> Self {
        Self {
            scores: HashMap::new(),
        }
    }
}

impl<Id: Eq + Hash + Clone + Ord> Fusion<Id> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn leg(&mut self, name: &'static str, weight: f64, ranked: impl IntoIterator<Item = Id>) {
        for (i, id) in ranked.into_iter().enumerate() {
            let e = self.scores.entry(id).or_insert((0.0, Vec::new()));
            if e.1.iter().any(|(n, _)| *n == name) {
                continue; // an id counts once per leg
            }
            e.0 += weight / (K + (i + 1) as f64);
            e.1.push((name, i + 1));
        }
    }

    pub fn prior(
        &mut self,
        _name: &'static str,
        weight: f64,
        ranked: impl IntoIterator<Item = Id>,
    ) {
        for (i, id) in ranked.into_iter().enumerate() {
            if let Some(e) = self.scores.get_mut(&id) {
                e.0 += weight / (K + (i + 1) as f64);
            }
        }
    }

    pub fn finish(self) -> Vec<Fused<Id>> {
        let mut out: Vec<Fused<Id>> = self
            .scores
            .into_iter()
            .map(|(id, (score, legs))| Fused { id, score, legs })
            .collect();
        out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
        out
    }
}
