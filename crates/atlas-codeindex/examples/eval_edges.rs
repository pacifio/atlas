//! Compare atlas-codeindex call edges with rust-analyzer's SCIP index.
//! Usage: rust-analyzer scip . && cargo run -p atlas-codeindex --release --example eval_edges -- . index.scip [truth.tsv]
//!
//! Only edges from files the SCIP index covers are judged, so a SCIP index of part of a
//! workspace (vendored crates emptied, say) measures that part. `truth.tsv` (optional) gets
//! every SCIP reference to a project definition: `ref_rel line col symbol def_rel def_line`.
//!
//! Definitions are compared by line: SCIP's is the identifier's, ours starts at the item's
//! first attribute or doc comment, so a target matches at ±3 lines of our start or on the
//! line that names it. SCIP gives every test target of a package one symbol namespace, so
//! two `tests/*.rs` with an `fn helper` share a symbol: a reference prefers the definition
//! in its own file and otherwise accepts any of them.
//!
//! Recall is printed three ways. "at our reference sites" is the historical number: every
//! SCIP reference on a line where we wrote a call edge, types, fields, modules and enum
//! variants included, which a call graph never links. "call recall" counts only references
//! to functions and methods (`().` symbols): at our sites, then at every site SCIP saw,
//! which also counts non-call mentions (`use` lines, `map(f)`).
use std::collections::{HashMap, HashSet};
use std::path::Path;

use protobuf::Message;
use rusqlite::Connection;

type Site = (String, i32);

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (root, scip_path) = (Path::new(&args[1]), Path::new(&args[2]));
    let ix = atlas_codeindex::CodeIndex::open(root).expect("open index");
    ix.full_build(&atlas_search::CancelToken::new(), &|_| {})
        .expect("build");
    let index = scip::types::Index::parse_from_bytes(&std::fs::read(scip_path).expect("read scip"))
        .expect("parse scip");
    // SCIP: definition locations of every symbol, and every reference occurrence.
    let mut def_at: HashMap<String, Vec<Site>> = HashMap::new();
    let mut refs: Vec<(Site, i32, String)> = Vec::new();
    let mut docs: HashSet<String> = HashSet::new();
    for doc in &index.documents {
        // rust-analyzer on Windows writes `\` separators; the index uses `/`.
        let rel = doc.relative_path.replace('\\', "/");
        docs.insert(rel.clone());
        for occ in &doc.occurrences {
            // `local N` symbols are numbered per document: never a cross-file definition.
            if occ.symbol.is_empty() || occ.symbol.starts_with("local ") {
                continue;
            }
            let line = occ.range.first().copied().unwrap_or(0) + 1;
            if occ.symbol_roles & (scip::types::SymbolRole::Definition as i32) != 0 {
                def_at
                    .entry(occ.symbol.clone())
                    .or_default()
                    .push((rel.clone(), line));
            } else {
                let col = occ.range.get(1).copied().unwrap_or(0);
                refs.push(((rel.clone(), line), col, occ.symbol.clone()));
            }
        }
    }
    // One truth group per (site, symbol): the definitions that reference may mean.
    let mut groups: HashMap<(Site, String), Vec<Site>> = HashMap::new();
    let mut rows: Vec<String> = Vec::new();
    for (at, col, sym) in &refs {
        let Some(defs) = def_at.get(sym) else {
            continue;
        };
        let own: Vec<Site> = defs.iter().filter(|d| d.0 == at.0).cloned().collect();
        let defs = if own.is_empty() { defs.clone() } else { own };
        for d in &defs {
            rows.push(format!(
                "{}\t{}\t{col}\t{sym}\t{}\t{}",
                at.0, at.1, d.0, d.1
            ));
        }
        groups.entry((at.clone(), sym.clone())).or_insert(defs);
    }
    if let Some(out) = args.get(3) {
        rows.sort();
        rows.dedup();
        std::fs::write(out, rows.join("\n") + "\n").expect("write truth");
    }
    let truth: HashSet<(Site, Site)> = groups
        .iter()
        .flat_map(|((at, _), defs)| defs.iter().map(|d| (at.clone(), d.clone())))
        .collect();

    let db = Connection::open(root.join(".atlas/code-index/index.db")).expect("db");
    let mut stmt = db
        .prepare(
            "SELECT rf.rel, r.line, df.rel, d.start_line, d.end_line, d.name FROM edges e
             JOIN refs r ON r.id = e.ref_id JOIN files rf ON rf.id = r.file_id
             JOIN symbols d ON d.id = e.dst_symbol_id JOIN files df ON df.id = d.file_id
             WHERE e.kind = 'call' AND rf.lang = 'rust'",
        )
        .expect("query");
    let mut lines: HashMap<String, Vec<String>> = HashMap::new();
    // Each edge: its site and the definition lines it may match.
    let ours: Vec<(Site, String, Vec<i32>)> = stmt
        .query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, i32>(1)?),
                r.get::<_, String>(2)?,
                r.get::<_, i32>(3)?,
                r.get::<_, i32>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .expect("rows")
        .filter_map(Result::ok)
        .filter(|o| docs.contains(&o.0 .0))
        .map(|(at, drel, start, end, name)| {
            let mut cand: Vec<i32> = (start - 3..=start + 3).collect();
            let text = lines.entry(drel.clone()).or_insert_with(|| {
                std::fs::read_to_string(root.join(&drel))
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_string)
                    .collect()
            });
            let named = (start..=end).find(|l| {
                text.get(*l as usize - 1).is_some_and(|t| {
                    let t = t.trim_start();
                    !t.starts_with("//")
                        && !t.starts_with("#[")
                        && t.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                            .any(|w| w == name)
                })
            });
            cand.extend(named);
            (at, drel, cand)
        })
        .collect();
    let hit = |o: &(Site, String, Vec<i32>)| {
        o.2.iter()
            .any(|l| truth.contains(&(o.0.clone(), (o.1.clone(), *l))))
    };
    let tp = ours.iter().filter(|o| hit(o)).count();
    println!(
        "edges: ours {} | matched {} | precision {:.3}",
        ours.len(),
        tp,
        tp as f64 / ours.len().max(1) as f64
    );

    let ref_lines: HashSet<&Site> = ours.iter().map(|o| &o.0).collect();
    let mut found: HashSet<(Site, Site)> = HashSet::new();
    for o in &ours {
        for l in &o.2 {
            found.insert((o.0.clone(), (o.1.clone(), *l)));
        }
    }
    let satisfied = |at: &Site, defs: &[Site]| {
        defs.iter()
            .any(|d| found.contains(&(at.clone(), d.clone())))
    };
    let (mut all_n, mut all_hit, mut site_n, mut site_hit) = (0, 0, 0, 0);
    let (mut call_n, mut call_hit, mut call_site_n, mut call_site_hit) = (0, 0, 0, 0);
    for ((at, sym), defs) in &groups {
        let ok = satisfied(at, defs);
        let at_ours = ref_lines.contains(at);
        let callable = sym.ends_with("().");
        if at_ours {
            site_n += 1;
            site_hit += ok as usize;
        }
        all_n += 1;
        all_hit += ok as usize;
        if callable {
            call_n += 1;
            call_hit += ok as usize;
            if at_ours {
                call_site_n += 1;
                call_site_hit += ok as usize;
            }
        }
    }
    let r = |a: usize, b: usize| a as f64 / b.max(1) as f64;
    println!(
        "recall at our reference sites (every symbol kind): {:.3} ({site_hit}/{site_n}; all sites {:.3})",
        r(site_hit, site_n),
        r(all_hit, all_n)
    );
    println!(
        "call recall at our reference sites: {:.3} ({call_site_hit}/{call_site_n})",
        r(call_site_hit, call_site_n)
    );
    println!(
        "call recall at every SCIP reference site: {:.3} ({call_hit}/{call_n})",
        r(call_hit, call_n)
    );
}
