//! The walker and the persistence half of the indexer, against real files.
//!
//! Hermetic up to one edge: `scan` asks the `ignore` crate for the user's
//! global gitignore (`git_global(true)`), which is read from the real home
//! directory. The fixtures use names nobody globally ignores, so a developer's
//! excludes file cannot change the result.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

/// A scratch project removed on drop. The crate has no dev-dependencies, and
/// adding `tempfile` would move `Cargo.lock`.
struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "atlas-codeindex-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        // `ignore` honours .gitignore only inside a repository, and an empty
        // `.git` directory is all it looks for — no git process needed.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        Self(dir)
    }

    fn root(&self) -> &Path {
        &self.0
    }

    fn write(&self, rel: &str, contents: &str) -> &Self {
        let path = self.0.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
        self
    }

    /// Scan as the app does. `scan` returns files in path order, so the
    /// assertions below pin that order too.
    fn scan(&self) -> Vec<ScannedFile> {
        scan(self.root(), |_| 7)
    }

    fn rels(&self) -> Vec<String> {
        self.scan().into_iter().map(|f| f.rel).collect()
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const RUST: &str = "use std::fmt;\n\npub struct Widget;\n\npub fn build() -> Widget { Widget }\n";

#[test]
fn scan_reports_each_supported_file_with_its_structure() {
    let project = Project::new();
    project
        .write("src/lib.rs", RUST)
        .write(
            "web/app.ts",
            "import { x } from './x';\nexport function run() {}\n",
        )
        .write("tool.py", "import os\n\ndef main():\n    pass\n");

    let files = project.scan();
    let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
    assert_eq!(rels, ["src/lib.rs", "tool.py", "web/app.ts"]);

    let lib = &files[0];
    assert_eq!(lib.language, "rust");
    // Rust imports are the whole `use` declaration, as `code_intel` extracts it.
    assert_eq!(lib.imports, ["use std::fmt;"]);
    let symbols: Vec<(&str, &str, u32)> = lib
        .symbols
        .iter()
        .map(|s| (s.name.as_str(), s.kind.as_str(), s.line))
        .collect();
    assert_eq!(symbols, [("Widget", "struct", 3), ("build", "fn", 5)]);
    assert_eq!(Path::new(&lib.abs_path), project.root().join("src/lib.rs"));
    assert_eq!(lib.mtime_ms, 7, "mtime comes from the caller's function");

    assert_eq!(files[1].language, "python");
    assert_eq!(files[2].language, "typescript");
}

#[test]
fn scan_skips_unsupported_and_structureless_files() {
    let project = Project::new();
    project
        .write("src/lib.rs", RUST)
        .write("README.txt", "fn not_code() {}")
        .write("Makefile", "all:\n\techo hi\n")
        // Supported, parses, declares nothing: nothing to embed.
        .write("src/empty.rs", "// just a comment\n");
    assert_eq!(project.rels(), ["src/lib.rs"]);
}

#[test]
fn scan_respects_gitignore_ignore_files_and_nested_ignores() {
    let project = Project::new();
    project
        .write(".gitignore", "generated/\n*.gen.rs\n")
        .write(".ignore", "scratch.py\n")
        .write("pkg/.gitignore", "local.ts\n")
        .write("src/lib.rs", RUST)
        .write("generated/out.rs", RUST)
        .write("src/api.gen.rs", RUST)
        .write("scratch.py", "def f():\n    pass\n")
        .write("pkg/local.ts", "export function f() {}\n")
        .write("pkg/kept.ts", "export function g() {}\n");
    assert_eq!(project.rels(), ["pkg/kept.ts", "src/lib.rs"]);
}

#[test]
fn scan_includes_hidden_directories() {
    // `hidden(false)`: dot-directories are walked (a `.github/scripts/*.py`
    // is real source); only ignore rules exclude.
    let project = Project::new();
    project.write(".scripts/release.py", "def release():\n    pass\n");
    assert_eq!(project.rels(), [".scripts/release.py"]);
}

#[test]
fn scan_skips_files_over_the_size_cap_and_keeps_one_at_it() {
    let project = Project::new();
    let at_cap = |head: &str| {
        let pad = MAX_SOURCE_BYTES as usize - head.len();
        format!("{head}{}", " ".repeat(pad))
    };
    let exact = at_cap("pub fn exact() {}\n");
    assert_eq!(exact.len() as u64, MAX_SOURCE_BYTES);
    let over = format!("{exact} ");
    project.write("exact.rs", &exact).write("over.rs", &over);
    assert_eq!(project.rels(), ["exact.rs"]);
}

#[cfg(unix)]
#[test]
fn scan_does_not_follow_symlinks() {
    let outside = Project::new();
    outside.write("secret.rs", RUST);
    let project = Project::new();
    project.write("src/lib.rs", RUST);
    std::os::unix::fs::symlink(outside.root(), project.root().join("linked_dir")).unwrap();
    std::os::unix::fs::symlink(
        outside.root().join("secret.rs"),
        project.root().join("linked.rs"),
    )
    .unwrap();
    assert_eq!(project.rels(), ["src/lib.rs"]);
}

#[test]
fn scan_returns_files_in_path_order() {
    let project = Project::new();
    // Written out of order on purpose: the walk yields the filesystem's
    // directory order, which must not leak into the result.
    project
        .write("c/a.rs", RUST)
        .write("b.rs", RUST)
        .write("a/z.rs", RUST)
        .write("a/b.rs", RUST);
    assert_eq!(project.rels(), ["a/b.rs", "a/z.rs", "b.rs", "c/a.rs"]);
}

#[test]
fn scan_skips_vendored_build_and_generated_files() {
    // No .gitignore: each of these would be indexed without the skip rules.
    let project = Project::new();
    project
        .write("src/lib.rs", RUST)
        .write("vendor/dep/lib.rs", RUST)
        .write("third_party/x/y.py", "def f():\n    pass\n")
        .write("web/node_modules/pkg/index.js", "export function f() {}\n")
        .write("dist/app.js", "export function f() {}\n")
        .write("build/gen.rs", RUST)
        .write("target/debug/build.rs", RUST)
        .write("web/__generated__/types.ts", "export function f() {}\n")
        .write("web/app.min.js", "export function f() {}\n")
        .write("api/service.pb.go", "package api\n\nfunc F() {}\n")
        .write("py/service_pb2.py", "def f():\n    pass\n")
        .write("web/schema.gen.ts", "export function f() {}\n");
    assert_eq!(project.rels(), ["src/lib.rs"]);
}

/// The skip rules look only below the project root: a project that itself
/// lives in a `build/` or `vendor/` directory is indexed normally.
#[test]
fn skip_rules_apply_below_the_root_only() {
    let outer = Project::new();
    let root = outer.root().join("build").join("vendor").join("app");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/lib.rs"), RUST).unwrap();
    let rels: Vec<String> = scan(&root, |_| 7).into_iter().map(|f| f.rel).collect();
    assert_eq!(rels, ["src/lib.rs"]);
}

#[test]
fn vendor_and_generated_rules_match_components_and_suffixes() {
    for skipped in [
        "vendor/a.rs",
        "a/node_modules/b.js",
        "x/target/y.rs",
        "third_party/z.py",
        "web/app.min.js",
        "api/x.pb.go",
        "py/x_pb2.py",
    ] {
        assert!(is_vendor_or_generated(Path::new(skipped)), "{skipped}");
    }
    for kept in [
        "",
        "src/vendor.rs",
        "src/targets/a.rs",
        "src/build_info.rs",
        "src/rebuild/x.rs",
        "web/admin.js",
    ] {
        assert!(!is_vendor_or_generated(Path::new(kept)), "{kept}");
    }
}

/// `DEFAULT_MAX_FILES` caps what `scan` returns (and so what
/// `codebase_index_build` embeds) for very large repositories. The cap keeps
/// the first files by path, so every scan of the same tree keeps the same
/// files.
#[test]
fn scan_caps_the_number_of_files_keeping_the_first_by_path() {
    let project = Project::new();
    for i in 0..=DEFAULT_MAX_FILES {
        project.write(&format!("src/f{i:05}.rs"), &format!("pub fn f{i}() {{}}\n"));
    }
    let rels = project.rels();
    assert_eq!(rels.len(), DEFAULT_MAX_FILES);
    assert_eq!(rels.first().map(String::as_str), Some("src/f00000.rs"));
    let last = format!("src/f{:05}.rs", DEFAULT_MAX_FILES - 1);
    assert_eq!(rels.last(), Some(&last));
    assert_eq!(rels, project.rels(), "a second scan keeps the same files");
}

// ── Hashing ─────────────────────────────────────────────────────────────────

#[test]
fn the_content_hash_is_lowercase_hex_sha256() {
    // FIPS 180-2 test vectors, so the persisted hashes stay comparable with
    // anything else that computes SHA-256.
    assert_eq!(
        content_hash(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        content_hash("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn hashes_depend_on_content_alone_and_are_stable_across_scans() {
    let project = Project::new();
    project.write("a.rs", RUST).write("nested/b.rs", RUST);
    let first = project.scan();
    assert_eq!(first[0].hash, content_hash(RUST));
    assert_eq!(
        first[0].hash, first[1].hash,
        "same bytes, same hash, whatever the path"
    );

    // Unchanged tree: identical hashes, which is what lets an incremental
    // rebuild reuse a prior summary.
    let again = project.scan();
    let hashes = |files: &[ScannedFile]| files.iter().map(|f| f.hash.clone()).collect::<Vec<_>>();
    assert_eq!(hashes(&first), hashes(&again));

    // One byte changes one hash.
    project.write("a.rs", &format!("{RUST}\n"));
    let edited = project.scan();
    assert_ne!(edited[0].hash, first[0].hash);
    assert_eq!(edited[1].hash, first[1].hash);
}

// ── Text and persistence ────────────────────────────────────────────────────

fn sym(name: &str, kind: &str) -> CodebaseSymbol {
    CodebaseSymbol {
        name: name.into(),
        kind: kind.into(),
        line: 1,
    }
}

#[test]
fn structural_text_names_what_a_file_defines_and_imports() {
    let text = structural_text(
        "src/lib.rs",
        "rust",
        &[sym("Widget", "struct"), sym("build", "fn")],
        &["std::fmt".into()],
    );
    assert_eq!(
        text,
        "File src/lib.rs (rust). Defines: struct Widget, fn build. Imports: std::fmt."
    );
    assert_eq!(
        structural_text("a.py", "python", &[], &[]),
        "File a.py (python)."
    );
}

#[test]
fn structural_text_is_bounded() {
    let symbols: Vec<_> = (0..100).map(|i| sym(&format!("s{i}"), "fn")).collect();
    let imports: Vec<_> = (0..100).map(|i| format!("m{i}")).collect();
    let text = structural_text("big.rs", "rust", &symbols, &imports);
    assert!(text.contains("fn s59") && !text.contains("fn s60"));
    assert!(text.contains("m29") && !text.contains("m30"));
}

#[test]
fn compose_text_prefixes_a_summary_only_when_there_is_one() {
    assert_eq!(compose_text("", "File a.rs (rust)."), "File a.rs (rust).");
    assert_eq!(compose_text("  \n", "S"), "S");
    assert_eq!(compose_text(" Does things. ", "S"), "Does things.\nS");
}

#[test]
fn aliases_are_the_stem_then_symbol_names() {
    let symbols: Vec<_> = (0..50).map(|i| sym(&format!("s{i}"), "fn")).collect();
    let aliases = aliases("src/widget.rs", &symbols);
    assert_eq!(aliases[0], "widget");
    assert_eq!(aliases.len(), 41, "the stem plus at most 40 symbols");
}

#[test]
fn the_index_round_trips_and_a_missing_or_corrupt_one_reads_as_empty() {
    let project = Project::new();
    let pp = project.root().to_string_lossy().into_owned();
    assert!(load_index(&pp).docs.is_empty(), "missing");

    let index = CodebaseIndex {
        built_at_ms: 42,
        docs: vec![CodebaseDoc {
            rel: "src/lib.rs".into(),
            abs_path: "/p/src/lib.rs".into(),
            language: "rust".into(),
            imports: vec!["std::fmt".into()],
            symbols: vec![sym("Widget", "struct")],
            hash: content_hash(RUST),
            mtime_ms: 1,
            summary: "s".into(),
            text: "t".into(),
            import_rank: 3,
        }],
    };
    save_index(&pp, &index).unwrap();
    assert!(docs_path(&pp).starts_with(project.root().join(".atlas/codebase-index")));
    let back = load_index(&pp);
    assert_eq!(back.built_at_ms, 42);
    assert_eq!(back.docs.len(), 1);
    assert_eq!(back.docs[0].hash, content_hash(RUST));
    assert_eq!(back.docs[0].import_rank, 3);

    std::fs::write(docs_path(&pp), b"{not json").unwrap();
    assert!(load_index(&pp).docs.is_empty(), "corrupt");
}
