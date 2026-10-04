//! Compare atlas-codeindex call edges with rust-analyzer's SCIP index.
//! Usage: rust-analyzer scip . && cargo run -p atlas-codeindex --release --example eval_edges -- . index.scip
use std::collections::{HashMap, HashSet};
use std::path::Path;

use protobuf::Message;
use rusqlite::Connection;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (root, scip_path) = (Path::new(&args[1]), Path::new(&args[2]));
    let ix = atlas_codeindex::CodeIndex::open(root).expect("open index");
    ix.full_build(&atlas_search::CancelToken::new(), &|_| {})
        .expect("build");
    let index = scip::types::Index::parse_from_bytes(&std::fs::read(scip_path).expect("read scip"))
        .expect("parse scip");
    // SCIP: definition location of every symbol, and every reference occurrence (file, line) -> symbol.
    let mut def_at: HashMap<String, (String, i32)> = HashMap::new();
    let mut refs: HashMap<(String, i32), HashSet<String>> = HashMap::new();
    for doc in &index.documents {
        for occ in &doc.occurrences {
            // `local N` symbols are numbered per document: never a cross-file definition.
            if occ.symbol.is_empty() || occ.symbol.starts_with("local ") {
                continue;
            }
            let line = occ.range.first().copied().unwrap_or(0) + 1;
            if occ.symbol_roles & (scip::types::SymbolRole::Definition as i32) != 0 {
                def_at.insert(occ.symbol.clone(), (doc.relative_path.clone(), line));
            } else {
                refs.entry((doc.relative_path.clone(), line))
                    .or_default()
                    .insert(occ.symbol.clone());
            }
        }
    }
    let truth: HashSet<((String, i32), (String, i32))> = refs
        .iter()
        .flat_map(|(at, syms)| {
            syms.iter()
                .filter_map(|s| def_at.get(s).map(|d| (at.clone(), d.clone())))
        })
        .collect();
    let db = Connection::open(root.join(".atlas/code-index/index.db")).expect("db");
    let mut stmt = db
        .prepare(
            "SELECT rf.rel, r.line, df.rel, d.start_line FROM edges e JOIN refs r ON r.id = e.ref_id
             JOIN files rf ON rf.id = r.file_id JOIN symbols d ON d.id = e.dst_symbol_id JOIN files df ON df.id = d.file_id
             WHERE e.kind = 'call' AND rf.lang = 'rust'",
        )
        .expect("query");
    let ours: Vec<((String, i32), (String, i32))> = stmt
        .query_map([], |r| Ok(((r.get(0)?, r.get(1)?), (r.get(2)?, r.get(3)?))))
        .expect("rows")
        .filter_map(Result::ok)
        .collect();
    // A def line may differ by attributes/doc comments: accept ±3 lines.
    let hit = |o: &((String, i32), (String, i32))| {
        (-3..=3).any(|d| truth.contains(&(o.0.clone(), (o.1 .0.clone(), o.1 .1 + d))))
    };
    let tp = ours.iter().filter(|o| hit(o)).count();
    let ref_lines: HashSet<&(String, i32)> = ours.iter().map(|o| &o.0).collect();
    let truth_at_our_ref_sites = truth.iter().filter(|t| ref_lines.contains(&t.0)).count();
    println!(
        "edges: ours {} | matched {} | precision {:.3}",
        ours.len(),
        tp,
        tp as f64 / ours.len().max(1) as f64
    );
    println!(
        "recall at our reference sites: {:.3}",
        tp as f64 / truth_at_our_ref_sites.max(1) as f64
    );
}
