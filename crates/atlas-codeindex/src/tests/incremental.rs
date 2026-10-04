//! Per-path updates and reconcile: the index never serves deleted symbols
//! and catches up after branch switches.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use atlas_search::CancelToken;

use super::{symbol_set, Project};

const A: &str = "pub fn alpha() {\n    1;\n}\n";
const B: &str = "pub struct Beta;\nimpl Beta {\n    pub fn go(&self) {}\n}\n";

fn seeded() -> Project {
    let p = Project::new();
    p.write("src/a.rs", A)
        .write("src/b.rs", B)
        .write("web/c.ts", "export function gamma() {}\n");
    p
}

fn paths(p: &Project, rels: &[&str]) -> Vec<PathBuf> {
    rels.iter().map(|r| p.path(r)).collect()
}

#[test]
fn edit_body_only_updates_ranges_and_generation() {
    let p = seeded();
    let ix = p.built();
    let g0 = ix.generation();
    p.write("src/a.rs", "pub fn alpha() {\n    1;\n    2;\n    3;\n}\n");
    let st = ix.update_paths(&paths(&p, &["src/a.rs"])).unwrap();
    assert_eq!((st.indexed, st.removed), (1, 0));
    assert!(symbol_set(&ix).contains("src/a.rs fn alpha 1-5"));
    assert!(ix.generation() > g0);
    // Nothing changed on disk: a second update is a stat or hash no-op.
    let again = ix.update_paths(&paths(&p, &["src/a.rs"])).unwrap();
    assert_eq!(again.indexed, 0);
}

#[test]
fn deleted_file_symbols_gone() {
    let p = seeded();
    let ix = p.built();
    p.remove("src/b.rs");
    let st = ix.update_paths(&paths(&p, &["src/b.rs"])).unwrap();
    assert_eq!(st.removed, 1);
    assert!(symbol_set(&ix).iter().all(|s| !s.starts_with("src/b.rs")));
    // The FTS rows went with them: search cannot return a deleted symbol.
    let fts: i64 = ix
        .with_reader(|c| {
            c.query_row(
                "SELECT count(*) FROM symbols_fts WHERE symbols_fts MATCH 'beta'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(fts, 0);
}

#[test]
fn rename_moves_symbols() {
    let p = seeded();
    let ix = p.built();
    p.rename("src/b.rs", "src/beta/mod.rs");
    ix.update_paths(&paths(&p, &["src/b.rs", "src/beta/mod.rs"]))
        .unwrap();
    let set = symbol_set(&ix);
    assert!(set.contains("src/beta/mod.rs struct Beta 1-1"), "{set:?}");
    assert!(set.iter().all(|s| !s.starts_with("src/b.rs")));
}

#[test]
fn deleted_directory_removes_everything_under_it() {
    let p = seeded();
    let ix = p.built();
    std::fs::remove_dir_all(p.path("src")).unwrap();
    let st = ix.update_paths(&paths(&p, &["src"])).unwrap();
    assert_eq!(st.removed, 2);
    assert!(symbol_set(&ix).iter().all(|s| s.starts_with("web/")));
}

#[test]
fn created_directory_is_walked() {
    let p = seeded();
    let ix = p.built();
    p.write("pkg/x/one.go", "package x\nfunc One() {}\n")
        .write("pkg/x/two.go", "package x\nfunc Two() {}\n");
    let st = ix.update_paths(&paths(&p, &["pkg"])).unwrap();
    assert_eq!(st.indexed, 2);
}

#[test]
fn reconcile_after_branch_switch() {
    let p = seeded();
    let ix = p.built();
    // A checkout rewrites, adds and deletes files with no per-file events.
    p.write("src/a.rs", "pub fn alpha_v2() {}\n");
    p.remove("web/c.ts");
    p.write("src/new.rs", "pub enum Fresh { A }\n");
    let st = ix.reconcile(&CancelToken::new()).unwrap();
    assert_eq!((st.indexed, st.removed), (2, 1));
    let fresh = Project::new();
    fresh
        .write("src/a.rs", "pub fn alpha_v2() {}\n")
        .write("src/b.rs", B)
        .write("src/new.rs", "pub enum Fresh { A }\n");
    assert_eq!(symbol_set(&ix), symbol_set(&fresh.built()));
}

#[test]
fn same_size_edit_inside_mtime_granularity_is_seen() {
    let p = seeded();
    let ix = p.built();
    let stamp = std::fs::metadata(p.path("src/a.rs"))
        .unwrap()
        .modified()
        .unwrap();
    // Same length, same mtime: only the hash can tell.
    p.write("src/a.rs", "pub fn omega() {\n    1;\n}\n");
    let f = std::fs::File::options()
        .write(true)
        .open(p.path("src/a.rs"))
        .unwrap();
    f.set_modified(stamp).unwrap();
    ix.update_paths(&paths(&p, &["src/a.rs"])).unwrap();
    assert!(symbol_set(&ix).contains("src/a.rs fn omega 1-3"));
}

#[test]
fn stat_gate_skips_hashing_old_unchanged_files() {
    let p = seeded();
    // Back-date every file beyond the racy window so the stat gate applies.
    let old = SystemTime::now() - Duration::from_secs(60);
    for rel in ["src/a.rs", "src/b.rs", "web/c.ts"] {
        std::fs::File::options()
            .write(true)
            .open(p.path(rel))
            .unwrap()
            .set_modified(old)
            .unwrap();
    }
    let ix = p.built();
    let st = ix.reconcile(&CancelToken::new()).unwrap();
    assert_eq!((st.indexed, st.unchanged, st.removed), (0, 3, 0));
}

#[test]
fn ignored_and_internal_paths_are_not_indexed() {
    let p = seeded();
    p.write(".gitignore", "out/\n");
    let ix = p.built();
    p.write("out/gen.rs", "pub fn generated() {}\n");
    p.write(".atlas/notes.rs", "pub fn internal() {}\n");
    let st = ix
        .update_paths(&paths(&p, &["out/gen.rs", ".atlas/notes.rs"]))
        .unwrap();
    assert_eq!(st.indexed, 0);
    // A newly ignored file that was indexed is dropped.
    p.write(".gitignore", "out/\nweb/\n");
    ix.update_paths(&paths(&p, &[".gitignore"])).unwrap();
    assert!(symbol_set(&ix).iter().all(|s| !s.starts_with("web/")));
}

#[test]
fn relative_and_outside_paths() {
    let p = seeded();
    let ix = p.built();
    p.write("src/a.rs", "pub fn alpha() {}\npub fn beta() {}\n");
    assert_eq!(
        ix.update_paths(&[PathBuf::from("src/a.rs")])
            .unwrap()
            .indexed,
        1
    );
    assert_eq!(
        ix.update_paths(&[PathBuf::from("/definitely/elsewhere/x.rs")])
            .unwrap()
            .indexed,
        0
    );
    // `..` cannot climb out of the root, even when it lands back inside.
    let sneaky = PathBuf::from("../")
        .join(p.root().file_name().unwrap())
        .join("src/a.rs");
    assert_eq!(ix.update_paths(&[sneaky]).unwrap().indexed, 0);
}

#[test]
fn one_file_update_under_200ms() {
    let p = Project::new();
    for i in 0..300 {
        p.write(
            &format!("src/m{i:03}.rs"),
            &format!("pub struct S{i};\nimpl S{i} {{\n    pub fn f(&self) -> u32 {{ {i} }}\n}}\n"),
        );
    }
    let ix = p.built();
    p.write("src/m150.rs", "pub struct S150;\npub fn added() {}\n");
    let t = Instant::now();
    ix.update_paths(&paths(&p, &["src/m150.rs"])).unwrap();
    let took = t.elapsed();
    assert!(
        took < Duration::from_millis(200),
        "1-file update took {took:?}"
    );
    assert!(symbol_set(&ix).contains("src/m150.rs fn added 2-2"));
}
