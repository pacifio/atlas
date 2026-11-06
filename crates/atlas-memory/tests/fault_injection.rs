//! Fault injection (research H4/H8): every deterministic fault converges back
//! to a healthy store without a human, and no canonical data is lost. Faults
//! are injected the way a crash, a sync tool or a manual edit would: through
//! a second connection to the database, or by writing over a file.

use atlas_memory::record::{
    memory_dir, open_scope, EntryKind, NewEntry, Origin, RecordStore, DB_FILE,
};
use rusqlite::Connection;

fn root(label: &str) -> std::path::PathBuf {
    let r = std::env::temp_dir().join(format!("atlas-fault-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&r);
    std::fs::create_dir_all(&r).unwrap();
    r
}

fn fact(store: &RecordStore, content: &str, at: i64) -> i64 {
    store
        .remember(
            NewEntry {
                kind: EntryKind::Fact,
                key: String::new(),
                content: content.into(),
                source: "claude".into(),
                agent: "claude".into(),
                session_id: "s".into(),
                confidence: 1.0,
                at,
            },
            at,
        )
        .unwrap()
        .entry
        .id
}

fn raw(root: &std::path::Path) -> Connection {
    Connection::open(memory_dir(root).join(DB_FILE)).unwrap()
}

#[test]
fn a_tampered_view_is_rebuilt_from_history() {
    let r = root("tamper");
    let store = open_scope(&r).unwrap();
    let id = fact(&store, "Deploys go through Fly", 1);
    raw(&r)
        .execute("UPDATE entries SET content = 'evil' WHERE id = ?1", [id])
        .unwrap();
    store.heal(2).unwrap();
    assert_eq!(
        store.get(id, 3).unwrap().unwrap().content,
        "Deploys go through Fly"
    );
}

#[test]
fn a_deleted_row_comes_back_and_a_forgotten_one_does_not() {
    let r = root("rows");
    let store = open_scope(&r).unwrap();
    let kept = fact(&store, "Keep me", 1);
    let gone = fact(&store, "Forget me", 2);
    store.forget(gone, 3, "").unwrap();
    raw(&r)
        .execute("DELETE FROM entries WHERE id = ?1", [kept])
        .unwrap();
    store.heal(4).unwrap();
    let ids: Vec<i64> = store
        .list(EntryKind::Fact, 10, Origin::Any)
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, vec![kept]);
}

#[test]
fn lost_search_rows_are_restored() {
    let r = root("fts");
    let store = open_scope(&r).unwrap();
    fact(&store, "Set RUST_LOG to trace", 1);
    raw(&r)
        .execute_batch("INSERT INTO entries_fts(entries_fts) VALUES('delete-all');")
        .unwrap();
    assert!(store.search("RUST_LOG", &[], 5, 2).unwrap().is_empty());
    store.heal(3).unwrap();
    assert_eq!(store.search("RUST_LOG", &[], 5, 4).unwrap().len(), 1);
}

#[test]
fn a_damaged_file_restores_the_snapshot_and_keeps_the_evidence() {
    let r = root("damage");
    {
        let store = RecordStore::open(&r).unwrap();
        fact(&store, "Snapshotted", 1);
        store.snapshot_if_due(1).unwrap();
    }
    let db = memory_dir(&r).join(DB_FILE);
    let _ = std::fs::remove_file(memory_dir(&r).join(format!("{DB_FILE}-wal")));
    std::fs::write(&db, vec![0u8; 4096]).unwrap();
    let store = RecordStore::open(&r).unwrap();
    assert_eq!(
        store.list(EntryKind::Fact, 5, Origin::Any).unwrap().len(),
        1
    );
    assert!(std::fs::read_dir(memory_dir(&r))
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().contains(".corrupt-")));
}

#[test]
fn a_torn_corpus_vector_file_heals_without_a_model() {
    let r = root("corpus");
    let mut engine = atlas_memory::MemoryEngine::open(r.clone());
    let v = |i: usize| {
        let mut x = vec![0f32; atlas_memory::DIM];
        x[i] = 1.0;
        x
    };
    engine
        .add_embedded(&[(
            atlas_memory::CorpusDoc {
                id: "note:a".into(),
                text: "A\n\nalpha".into(),
                content_hash: "ha".into(),
                corpus: "note".into(),
            },
            v(1),
        )])
        .unwrap();
    drop(engine);
    let file = std::fs::read_dir(memory_dir(&r))
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "usearch"))
        .unwrap();
    std::fs::write(file, b"torn").unwrap();
    let engine = atlas_memory::MemoryEngine::open(r);
    assert_eq!(engine.search_ids(&v(1), 1, &[]).unwrap()[0].0, "note:a");
}
