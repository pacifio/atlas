//! The two indexes `memory_briefing` reads through (schema v7).
//!
//! The briefing runs `list(kind, .., Origin::Any)` once per durable kind before
//! the agent's first token, and `links_of` once per checked citation. Neither
//! order could be served by an index, so both were full scans that grew with
//! the store. These tests pin the indexes in place — a plan that stops using
//! one is a first-token regression nobody would otherwise notice — and the
//! `--ignored` one measures what they are worth.

use std::time::Instant;

use atlas_memory::record::{EntryKind, NewEntry, Origin, RecordStore, LINKS_OF_SQL, LIST_ANY_SQL};

fn store(dir: &std::path::Path, entries: usize) -> RecordStore {
    let s = RecordStore::open(dir).expect("open");
    for i in 0..entries {
        s.remember(
            NewEntry {
                kind: if i % 3 == 0 {
                    EntryKind::Fact
                } else if i % 3 == 1 {
                    EntryKind::Decision
                } else {
                    EntryKind::Preference
                },
                key: format!("k{i}"),
                content: format!(
                    "Memory number {i}: the retry helper keeps its signature and the \
                     timeout is bounded at the call site, which matters for the webhook path."
                ),
                source: "test".into(),
                agent: "atlas".into(),
                session_id: format!("ses{}", i % 20),
                confidence: 1.0,
                at: 1_700_000_000_000 + i as i64,
            },
            1_700_000_000_000 + i as i64,
        )
        .expect("remember");
    }
    s
}

#[test]
fn the_briefing_listing_is_served_by_an_index_not_a_scan() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path(), 50);
    // The store's own query text, not a copy of it.
    let plan = s.explain(LIST_ANY_SQL).expect("explain");
    assert!(
        plan.contains("entries_kind_updated"),
        "the briefing's listing must use entries_kind_updated, got: {plan}"
    );
    assert!(
        !plan.contains("SCAN entries"),
        "and must not scan the table: {plan}"
    );
}

#[test]
fn the_citation_link_lookup_is_indexed_in_both_directions() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path(), 10);
    let plan = s.explain(LINKS_OF_SQL).expect("explain");
    assert!(
        plan.contains("links_b"),
        "the `b` half of the citation lookup must use links_b, got: {plan}"
    );
}

#[test]
#[ignore = "measurement, not a gate"]
fn measure_the_briefing_listing() {
    const READS: usize = 200;
    println!();
    for n in [500usize, 2_000, 8_000] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path(), n);

        let t = Instant::now();
        for _ in 0..READS {
            for kind in [EntryKind::Fact, EntryKind::Decision, EntryKind::Preference] {
                std::hint::black_box(s.list(kind, 5_000, Origin::Any).unwrap());
            }
        }
        let with = t.elapsed().as_micros() as f64 / READS as f64;

        s.drop_index_for_test("entries_kind_updated").unwrap();
        let t = Instant::now();
        for _ in 0..READS {
            for kind in [EntryKind::Fact, EntryKind::Decision, EntryKind::Preference] {
                std::hint::black_box(s.list(kind, 5_000, Origin::Any).unwrap());
            }
        }
        let without = t.elapsed().as_micros() as f64 / READS as f64;

        println!(
            "  {n:>5} entries   scan: {without:>8.0} µs/briefing-listing   indexed: {with:>8.0} µs   {:.1}x",
            without / with
        );
    }
    println!();
}
