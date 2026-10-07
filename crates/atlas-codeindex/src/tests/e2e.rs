use crate::graph_fixtures::*;

fn last_stats(idx: &crate::CodeIndex) -> crate::graph_batch::GraphStats {
    idx.with_reader(|c| {
        let v: String =
            c.query_row("SELECT v FROM meta WHERE k = 'graph.last_stats'", [], |r| {
                r.get(0)
            })?;
        Ok(serde_json::from_str(&v).expect("stats json"))
    })
    .expect("stats")
}

#[test]
fn rust_modules_follow_mod_rs_lib_rs_and_path_attr() {
    let (_d, idx) = build_index(RUST_WORKSPACE);
    assert_eq!(module_of(&idx, "crates/core-lib/src/lib.rs"), "core_lib");
    assert_eq!(
        module_of(&idx, "crates/core-lib/src/engine/mod.rs"),
        "core_lib::engine"
    );
    assert_eq!(
        module_of(&idx, "crates/core-lib/src/engine/parts.rs"),
        "core_lib::engine::parts"
    );
    assert_eq!(
        module_of(&idx, "crates/core-lib/src/gen/wire_impl.rs"),
        "core_lib::wire"
    );
    assert_eq!(module_of(&idx, "crates/tool/src/main.rs"), "tool#bin");
}

#[test]
fn rust_imports_follow_pub_use_reexports() {
    let (_d, idx) = build_index(RUST_WORKSPACE);
    assert_eq!(
        import_target(&idx, "crates/tool/src/lib.rs", "Engine").as_deref(),
        Some("crates/core-lib/src/engine/mod.rs")
    );
    assert_eq!(
        import_target(&idx, "crates/core-lib/src/engine/mod.rs", "Part").as_deref(),
        Some("crates/core-lib/src/engine/parts.rs")
    );
    assert_eq!(
        import_target(&idx, "crates/core-lib/src/lib.rs", "*").as_deref(),
        Some("crates/core-lib/src/util.rs")
    );
}

#[test]
fn ts_imports_resolve_paths_workspaces_index_and_reexports() {
    let (_d, idx) = build_index(TS_PROJECT);
    assert_eq!(
        import_target(&idx, "src/app.tsx", "Button").as_deref(),
        Some("packages/ui/src/button.tsx")
    );
    assert_eq!(
        import_target(&idx, "src/app.tsx", "fmt").as_deref(),
        Some("src/lib/format.ts")
    );
    assert_eq!(
        import_target(&idx, "src/app.tsx", "api").as_deref(),
        Some("src/api/index.ts")
    );
    assert_eq!(
        import_target(&idx, "src/legacy.js", "api").as_deref(),
        Some("src/api/index.ts")
    );
}

#[test]
fn python_imports_resolve_relative_packages_and_init() {
    let (_d, idx) = build_index(PY_PROJECT);
    assert_eq!(
        import_target(&idx, "app/cli.py", "Engine").as_deref(),
        Some("app/engine.py")
    );
    assert_eq!(
        import_target(&idx, "app/cli.py", "engine").as_deref(),
        Some("app/engine.py")
    );
    assert_eq!(
        import_target(&idx, "app/cli.py", "app.engine").as_deref(),
        Some("app/engine.py")
    );
    assert_eq!(
        import_target(&idx, "tests/test_engine.py", "Engine").as_deref(),
        Some("app/engine.py")
    );
}

#[test]
fn go_imports_resolve_through_go_mod() {
    let (_d, idx) = build_index(GO_PROJECT);
    let t = import_target(&idx, "cmd/main.go", "util").expect("resolved");
    assert!(t.starts_with("pkg/util/"), "{t}");
}

/// A workspace two levels below the root, and a dependency renamed with `package = …`:
/// both lost every cross-crate edge to the external-crate rule.
#[test]
fn rust_edges_reach_nested_workspaces_and_renamed_dependencies() {
    let (_d, idx) = build_index(&[
        ("rust/ws/Cargo.toml", "[workspace]\nmembers = [\"alpha\", \"beta\", \"gamma\"]\n"),
        ("rust/ws/alpha/Cargo.toml", "[package]\nname = \"alpha\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"),
        ("rust/ws/alpha/src/lib.rs", "pub fn shared() -> u32 {\n    1\n}\n"),
        (
            "rust/ws/beta/Cargo.toml",
            "[package]\nname = \"beta\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nalpha2 = { package = \"alpha\", path = \"../alpha\" }\n",
        ),
        ("rust/ws/beta/src/lib.rs", "pub fn renamed() -> u32 {\n    alpha2::shared()\n}\n"),
        (
            "rust/ws/gamma/Cargo.toml",
            "[package]\nname = \"gamma\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nalpha = { path = \"../alpha\" }\n",
        ),
        ("rust/ws/gamma/src/lib.rs", "pub fn plain() -> u32 {\n    alpha::shared()\n}\n"),
    ]);
    let e = |s: &str, d: &str| edge(&idx, s, d).map(|(_, _, st)| st);
    assert_eq!(e("plain", "shared").as_deref(), Some("module_path"));
    assert_eq!(e("renamed", "shared").as_deref(), Some("module_path"));
}

#[test]
fn rust_edges_use_module_paths_receivers_and_reexports() {
    let (_d, idx) = build_index(RUST_WORKSPACE);
    let e =
        |s: &str, d: &str| edge(&idx, s, d).map(|(k, c, st)| (k, (c * 100.0).round() as i64, st));
    assert_eq!(
        e("go", "run"),
        Some(("call".into(), 95, "module_path".into()))
    );
    assert_eq!(
        e("go", "encode"),
        Some(("call".into(), 95, "module_path".into()))
    );
    assert_eq!(
        e("run", "start"),
        Some(("call".into(), 95, "module_path".into()))
    );
    assert_eq!(
        e("run", "helper"),
        Some(("call".into(), 85, "import_map_suffix".into()))
    );
    assert_eq!(
        e("Engine::run", "Engine::step"),
        Some(("call".into(), 90, "same_module".into()))
    );
    assert_eq!(
        e("Engine::step", "Part::new"),
        Some(("call".into(), 95, "import_map".into()))
    );
    assert_eq!(
        e("start", "Engine::new"),
        Some(("call".into(), 90, "same_module".into()))
    );
    assert_eq!(
        e("start", "Engine::run"),
        Some(("call".into(), 90, "same_module".into()))
    );
    assert_eq!(
        e("new", "Engine::new"),
        Some(("call".into(), 95, "import_map".into()))
    );
    assert_eq!(
        e("Square", "Shape"),
        Some(("impl".into(), 95, "module_path".into()))
    );
    assert_eq!(
        e("main", "go"),
        Some(("call".into(), 95, "module_path".into()))
    );
    assert_eq!(e("main", "run").map(|x| x.2), Some("same_module".into()));
    assert_eq!(
        e("tests::go_works", "go").map(|x| x.2),
        Some("import_map_suffix".into())
    );
    assert_eq!(
        e("encode", "helper"),
        Some(("call".into(), 95, "module_path".into()))
    );
}

#[test]
fn ambiguous_new_and_run_never_cross_bind() {
    let (_d, idx) = build_index(RUST_WORKSPACE);
    assert!(edge(&idx, "start", "Part::new").is_none());
    assert!(edge(&idx, "start", "run").is_none());
    assert!(edge(&idx, "main", "Engine::run").is_none());
    assert!(edge(&idx, "new", "Part::new").is_none());
}

#[test]
fn ts_python_go_edges() {
    let (_d, ts) = build_index(TS_PROJECT);
    assert_eq!(
        edge(&ts, "App", "Button").map(|x| x.2),
        Some("import_map".into())
    );
    assert_eq!(
        edge(&ts, "App", "fmt").map(|x| x.2),
        Some("import_map".into())
    );
    assert_eq!(
        edge(&ts, "App", "load").map(|x| x.2),
        Some("import_map".into())
    );
    assert_eq!(
        edge(&ts, "load", "fetchAll").map(|x| x.2),
        Some("same_module".into())
    );
    assert_eq!(
        edge(&ts, "old", "load").map(|x| x.2),
        Some("import_map".into())
    );

    let (_d, py) = build_index(PY_PROJECT);
    assert_eq!(
        edge(&py, "main", "Engine").map(|x| x.2),
        Some("import_map".into())
    );
    assert_eq!(
        edge(&py, "main", "Engine.run").map(|x| x.2),
        Some("import_map".into())
    );
    assert_eq!(
        edge(&py, "main", "helper").map(|x| x.2),
        Some("import_map".into())
    );
    assert_eq!(
        edge(&py, "Engine.run", "helper").map(|x| x.2),
        Some("same_module".into())
    );
    assert_eq!(
        edge(&py, "Engine", "Base").map(|x| x.0),
        Some("inherit".into())
    );
    assert_eq!(
        edge(&py, "test_run", "Engine").map(|x| x.2),
        Some("import_map".into())
    );

    let (_d, go) = build_index(GO_PROJECT);
    assert_eq!(
        edge(&go, "Repo.Save", "Repo.load").map(|x| x.2),
        Some("same_module".into())
    );
    assert_eq!(
        edge(&go, "Repo.Save", "Do").map(|x| x.2),
        Some("import_map".into())
    );
    assert_eq!(
        edge(&go, "Other", "helper").map(|x| x.2),
        Some("same_module".into())
    );
    assert_eq!(
        edge(&go, "main", "Repo.Save").map(|x| x.2),
        Some("same_module".into())
    );
}

#[test]
fn body_only_edit_reresolves_only_own_refs() {
    let (d, idx) = build_index(RUST_WORKSPACE);
    let util = "crates/core-lib/src/util.rs";
    std::fs::write(
        d.path().join(util),
        "pub fn helper() -> u32 {\n    3\n}\n\npub trait Shape {\n    fn area(&self) -> u32;\n}\n",
    )
    .unwrap();
    idx.update_paths(&[d.path().join(util)]).unwrap();
    let st = last_stats(&idx);
    assert!(!st.full);
    assert_eq!(
        st.refs_resolved, 0,
        "util.rs has no refs and its surface is unchanged"
    );
    assert!(st.edges_remapped >= 3, "{st:?}");
    assert!(edge(&idx, "run", "helper").is_some());
    assert!(edge(&idx, "encode", "helper").is_some());
    assert!(edge(&idx, "Square", "Shape").is_some());
}

#[test]
fn rename_reresolves_dependents() {
    let (d, idx) = build_index(RUST_WORKSPACE);
    let util = "crates/core-lib/src/util.rs";
    std::fs::write(
        d.path().join(util),
        "pub fn helper2() -> u32 {\n    2\n}\n\npub trait Shape {\n    fn area(&self) -> u32;\n}\n",
    )
    .unwrap();
    idx.update_paths(&[d.path().join(util)]).unwrap();
    assert!(edge(&idx, "run", "helper").is_none());
    assert!(edge(&idx, "run", "helper2").is_none());
    let st = last_stats(&idx);
    assert!(st.refs_resolved >= 2, "{st:?}");
    assert!(edge(&idx, "Square", "Shape").is_some());
}

#[test]
fn new_file_resolves_previously_dangling_ref() {
    let (d, idx) = build_index(&[("a.py", "def caller():\n    zap()\n")]);
    assert!(edge(&idx, "caller", "zap").is_none());
    write_tree(d.path(), &[("b.py", "def zap():\n    pass\n")]);
    idx.update_paths(&[d.path().join("b.py")]).unwrap();
    assert_eq!(
        edge(&idx, "caller", "zap").map(|x| x.2),
        Some("unique_name".into())
    );
}

/// PEP 420: `sansio/` has no `__init__.py` but sits inside the `flask` package, so
/// `from .sansio.app import App` resolves through the import, not by name.
#[test]
fn a_sub_package_without_init_resolves_through_its_import() {
    let (_d, idx) = build_index(&[
        ("src/flask/__init__.py", ""),
        (
            "src/flask/app.py",
            "from .sansio.app import App\n\n\ndef run():\n    App()\n",
        ),
        ("src/flask/sansio/app.py", "class App:\n    pass\n"),
    ]);
    assert_eq!(
        edge(&idx, "run", "App").map(|x| x.2),
        Some("import_map".into())
    );
}

#[test]
fn deleted_file_symbols_and_edges_gone() {
    let (d, idx) = build_index(RUST_WORKSPACE);
    let parts = "crates/core-lib/src/engine/parts.rs";
    std::fs::remove_file(d.path().join(parts)).unwrap();
    idx.update_paths(&[d.path().join(parts)]).unwrap();
    assert!(edge(&idx, "Engine::step", "Part::new").is_none());
    assert!(edge(&idx, "start", "Engine::new").is_some());
}

#[test]
fn config_change_forces_full_resolve() {
    let (d, idx) = build_index(RUST_WORKSPACE);
    idx.update_paths(&[d.path().join("Cargo.toml")]).unwrap();
    assert!(last_stats(&idx).full);
}

/// A config edit the watcher reported updates the stored config stamp, so the next
/// reconcile finds nothing to re-resolve (and runs no second `cargo metadata`).
#[test]
fn a_watched_config_edit_leaves_the_next_reconcile_nothing_to_do() {
    let (d, idx) = build_index(RUST_WORKSPACE);
    std::fs::write(
        d.path().join("Cargo.toml"),
        "[workspace]\nmembers = [\"crates/*\"]\nresolver = \"2\"\n# edited\n",
    )
    .unwrap();
    idx.update_paths(&[d.path().join("Cargo.toml")]).unwrap();
    let stamp = |idx: &crate::CodeIndex| {
        idx.with_reader(|c| crate::store::get_meta(c, "graph.config_stamp"))
            .unwrap()
    };
    let after_watch = stamp(&idx);
    assert!(after_watch
        .as_deref()
        .is_some_and(|s| s.contains("Cargo.toml")));
    idx.reconcile(&atlas_search::CancelToken::new()).unwrap();
    assert_eq!(stamp(&idx), after_watch);
}

/// A Phase 2 (v1) index upgrades in place to the current schema: the graph
/// tables (v2) and the chunk tables (v3) appear, Tier-2 summaries survive,
/// and every file is marked for re-extraction.
#[test]
fn migration_from_v1_keeps_summaries_and_forces_reextract() {
    let dir = tempfile::tempdir().unwrap();
    create_v1_only(dir.path());
    let idx = crate::CodeIndex::open(dir.path()).unwrap();
    idx.with_reader(|c| {
        let uv: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        assert_eq!(uv, crate::SCHEMA_VERSION);
        let mtime: i64 = c.query_row("SELECT mtime_ns FROM files", [], |r| r.get(0))?;
        assert_eq!(mtime, -1);
        let kept: String = c.query_row("SELECT summary FROM file_summaries", [], |r| r.get(0))?;
        assert_eq!(kept, "kept");
        for t in ["refs", "edges", "rust_mods", "chunks", "embed_cache", "chunk_vectors"] {
            let n: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = ?1", [t], |r| r.get(0))?;
            assert_eq!(n, 1, "{t}");
        }
        let cols: i64 = c.query_row("SELECT COUNT(*) FROM pragma_table_info('imports') WHERE name IN ('imported_name','is_pub')", [], |r| r.get(0))?;
        assert_eq!(cols, 2);
        Ok(())
    })
    .unwrap();
    // idempotent
    drop(idx);
    crate::CodeIndex::open(dir.path()).unwrap();
}
