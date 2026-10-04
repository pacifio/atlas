//! An Aider-style repository map: files ranked by personalized PageRank over
//! the resolved reference graph, then their most-referenced definitions
//! rendered with signatures until the token budget is met
//! (docs/research/codeindex-search/06 §2.6).

use std::collections::{BTreeMap, HashMap};

use rusqlite::Connection;

use crate::{CodeIndex, IndexError};

#[derive(Debug, Clone, Default)]
pub struct RepoMapFocus {
    /// Root-relative files already in the agent's context: they personalize the
    /// rank and are left out of the map.
    pub files: Vec<String>,
    /// Identifiers mentioned in the task: edges to them weigh more.
    pub idents: Vec<String>,
}

const DAMPING: f64 = 0.85;
const ITERATIONS: usize = 100;
const TOLERANCE: f64 = 1e-10;

struct Def {
    id: i64,
    file: usize,
    rel: String,
    line: u32,
    text: String,
}

fn word_style(name: &str) -> bool {
    name.contains('_')
        || name.contains('-')
        || (name.chars().any(char::is_uppercase) && name.chars().any(char::is_lowercase))
}

fn rank(c: &Connection, focus: &RepoMapFocus) -> rusqlite::Result<(Vec<(f64, Def)>, Vec<String>)> {
    let files: Vec<(i64, String)> = c
        .prepare("SELECT id, rel FROM files ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let ix: HashMap<i64, usize> = files
        .iter()
        .enumerate()
        .map(|(i, (id, _))| (*id, i))
        .collect();
    let n = files.len();
    let defined_in: HashMap<String, i64> = c
        .prepare("SELECT name, COUNT(DISTINCT file_id) FROM symbols GROUP BY name")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let focus_file: Vec<bool> = files
        .iter()
        .map(|(_, rel)| focus.files.iter().any(|f| f == rel))
        .collect();
    // (src file, dst symbol) → (reference count, dst name, dst file)
    let mut refs: BTreeMap<(usize, i64), (u32, String, usize)> = BTreeMap::new();
    let mut stmt = c.prepare(
        "SELECT rs.file_id, e.dst_symbol_id, ds.name, ds.file_id FROM edges e
         JOIN symbols rs ON rs.id = e.src_symbol_id JOIN symbols ds ON ds.id = e.dst_symbol_id
         WHERE rs.file_id <> ds.file_id ORDER BY rs.file_id, e.dst_symbol_id",
    )?;
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })? {
        let (sf, dst, name, df) = row?;
        let (Some(&s), Some(&d)) = (ix.get(&sf), ix.get(&df)) else {
            continue;
        };
        refs.entry((s, dst)).or_insert((0, name, d)).0 += 1;
    }
    // Aider's edge weights.
    let mut weights: Vec<(usize, usize, i64, f64)> = Vec::with_capacity(refs.len());
    let mut out_w = vec![0.0f64; n];
    for ((s, dst), (count, name, d)) in &refs {
        let mut m = 1.0;
        if focus.idents.iter().any(|i| i == name) {
            m *= 10.0;
        }
        if name.chars().count() >= 8 && word_style(name) {
            m *= 10.0;
        }
        if name.starts_with('_') {
            m *= 0.1;
        }
        if defined_in.get(name).copied().unwrap_or(1) > 5 {
            m *= 0.1;
        }
        if focus_file[*s] {
            m *= 50.0;
        }
        let w = m * f64::from(*count).sqrt();
        out_w[*s] += w;
        weights.push((*s, *d, *dst, w));
    }
    // Personalization: focus files and files whose path names a focus ident.
    let mut p: Vec<f64> = files
        .iter()
        .enumerate()
        .map(|(i, (_, rel))| {
            let named = focus
                .idents
                .iter()
                .any(|id| rel.split(['/', '.']).any(|part| part == id));
            if focus_file[i] || named {
                1.0
            } else {
                0.0
            }
        })
        .collect();
    let ps: f64 = p.iter().sum();
    if ps == 0.0 {
        p.iter_mut().for_each(|x| *x = 1.0 / n.max(1) as f64);
    } else {
        p.iter_mut().for_each(|x| *x /= ps);
    }
    let mut r = p.clone();
    for _ in 0..ITERATIONS {
        let dangling: f64 = (0..n).filter(|&i| out_w[i] == 0.0).map(|i| r[i]).sum();
        let mut next: Vec<f64> = p
            .iter()
            .map(|pj| (1.0 - DAMPING) * pj + DAMPING * dangling * pj)
            .collect();
        for &(s, d, _, w) in &weights {
            next[d] += DAMPING * r[s] * w / out_w[s];
        }
        let diff: f64 = next.iter().zip(&r).map(|(a, b)| (a - b).abs()).sum();
        r = next;
        if diff < TOLERANCE {
            break;
        }
    }
    // Rank flows from each file to the definitions it references.
    let mut def_rank: BTreeMap<i64, f64> = BTreeMap::new();
    for &(s, d, dst, w) in &weights {
        if !focus_file[d] {
            *def_rank.entry(dst).or_default() += r[s] * w / out_w[s];
        }
    }
    if def_rank.is_empty() {
        // No graph yet: importance, then exported top-level definitions.
        let mut stmt = c.prepare(
            "SELECT id, importance + 0.001 * exported FROM symbols WHERE parent_id IS NULL AND kind <> 'impl' ORDER BY id",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)))? {
            let (id, w) = row?;
            def_rank.insert(id, w + 1e-9);
        }
    }
    let mut defs = Vec::with_capacity(def_rank.len());
    let mut stmt = c.prepare_cached(
        "SELECT s.file_id, f.rel, s.start_line, s.signature, s.kind, s.name FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?1",
    )?;
    for (&id, &score) in &def_rank {
        let (fid, rel, line, sig, kind, name): (i64, String, u32, String, String, String) = stmt
            .query_row([id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?;
        let Some(&file) = ix.get(&fid) else { continue };
        if focus_file[file] {
            continue;
        }
        let text = if sig.trim().is_empty() {
            format!("{kind} {name}")
        } else {
            sig
        };
        defs.push((
            score,
            Def {
                id,
                file,
                rel,
                line,
                text,
            },
        ));
    }
    defs.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| a.1.rel.cmp(&b.1.rel))
            .then(a.1.line.cmp(&b.1.line))
            .then(a.1.id.cmp(&b.1.id))
    });
    Ok((defs, files.into_iter().map(|(_, rel)| rel).collect()))
}

fn render(defs: &[(f64, Def)], take: usize) -> String {
    // Files in order of their best definition; definitions by line within a file.
    let mut order: Vec<usize> = Vec::new();
    let mut by_file: BTreeMap<usize, Vec<&Def>> = BTreeMap::new();
    for (_, d) in defs.iter().take(take) {
        if !by_file.contains_key(&d.file) {
            order.push(d.file);
        }
        by_file.entry(d.file).or_default().push(d);
    }
    let mut out = String::new();
    for f in order {
        let mut ds = by_file.remove(&f).unwrap_or_default();
        ds.sort_by_key(|d| (d.line, d.id));
        out.push_str(&ds[0].rel);
        out.push_str(":\n");
        for d in ds {
            let one_line: String = d
                .text
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect();
            out.push_str(&format!("{:>6}│ {}\n", d.line, one_line.trim_end()));
        }
    }
    out
}

impl CodeIndex {
    /// The map that fits `token_budget` (≈ bytes / 4), most important first.
    pub fn repo_map(
        &self,
        focus: &RepoMapFocus,
        token_budget: usize,
    ) -> Result<String, IndexError> {
        let (defs, _) = self.with_reader(|c| rank(c, focus))?;
        let fits = |k: usize| render(&defs, k).len() / 4 <= token_budget;
        let (mut lo, mut hi) = (0usize, defs.len());
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if fits(mid) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Ok(render(&defs, lo))
    }
}
