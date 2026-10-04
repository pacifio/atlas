//! Index a project and print timings.
//!
//! `cargo run -p atlas-codeindex --release --example build_index -- <project-root> [query]`
//!
//! Writes `<root>/.atlas/code-index/index.db` like the app does. Prints the
//! full-build time, a no-op reconcile, a one-file update, and one query.

use std::path::PathBuf;
use std::time::Instant;

use atlas_codeindex::{CodeIndex, SymbolQuery};
use atlas_search::CancelToken;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(
        args.next()
            .ok_or("usage: build_index <project-root> [query]")?,
    );
    let query = args.next().unwrap_or_else(|| "CodeIndex".to_string());

    let ix = CodeIndex::open(&root)?;
    let t = Instant::now();
    let stats = ix.full_build(&CancelToken::new(), &|_| {})?;
    println!(
        "full build: {} files, {} symbols, {} imports, {} partial, {} skipped in {:?}",
        stats.files,
        stats.symbols,
        stats.imports,
        stats.partial,
        stats.skipped.len(),
        t.elapsed()
    );
    for (reason, n) in ix.status()?.skipped {
        println!("  skipped {reason}: {n}");
    }

    let t = Instant::now();
    let st = ix.reconcile(&CancelToken::new())?;
    println!("no-op reconcile: {st:?} in {:?}", t.elapsed());

    if let Some(hit) = ix.picker_symbols(1)?.first() {
        let path = ix.root().join(&hit.rel);
        let t = Instant::now();
        let st = ix.update_paths(&[path])?;
        println!("one-file update ({}): {st:?} in {:?}", hit.rel, t.elapsed());
    }

    let t = Instant::now();
    let (hits, page) = ix.find_symbol(&SymbolQuery {
        query: query.clone(),
        limit: 5,
        ..SymbolQuery::default()
    })?;
    println!(
        "find_symbol {query:?}: {} of {} in {:?}",
        hits.len(),
        page.total,
        t.elapsed()
    );
    for h in hits {
        println!(
            "  {} {} {}:{}-{}",
            h.kind, h.qualified_name, h.rel, h.start_line, h.end_line
        );
    }
    Ok(())
}
