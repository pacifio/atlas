//! File-level docs and Tier-2 summaries.

use atlas_search::CancelToken;

use super::Project;

fn fixture(p: &Project) {
    p.write(
        "src/lib.rs",
        "pub struct Store;\nimpl Store {\n    pub fn open() -> Self { Store }\n}\n",
    )
    .write(
        "web/app.ts",
        "import { x } from './x';\nexport function run() {}\nexport class App { start() {} }\n",
    )
    .write("tool.py", "import os\n\ndef main():\n    pass\n");
}

#[test]
fn summaries_survive_a_full_build_while_the_hash_matches() {
    let p = Project::new();
    fixture(&p);
    let ix = p.built();
    let targets = ix.summary_targets(10).unwrap();
    assert_eq!(targets.len(), 3);
    for t in &targets {
        assert!(ix
            .put_summary(
                t.doc.file_id,
                &t.content_hash,
                &format!("about {}", t.doc.rel)
            )
            .unwrap());
    }
    p.write("tool.py", "import os\n\ndef main():\n    return 1\n");
    ix.full_build(&CancelToken::new(), &|_| {}).unwrap();
    let docs = ix.file_docs(10).unwrap();
    let summary = |rel: &str| docs.iter().find(|d| d.rel == rel).unwrap().summary.clone();
    assert_eq!(summary("src/lib.rs"), "about src/lib.rs");
    assert_eq!(summary("tool.py"), "", "content changed, summary dropped");
    assert_eq!(ix.summary_targets(10).unwrap().len(), 1);
    assert_eq!(ix.status().unwrap().summaries, 2);
    // A summary written for content that has since changed is refused.
    let id = docs.iter().find(|d| d.rel == "tool.py").unwrap().file_id;
    assert!(!ix.put_summary(id, &[0u8; 32], "old").unwrap());
}

#[test]
fn summaries_survive_incremental_updates_while_the_hash_matches() {
    let p = Project::new();
    fixture(&p);
    let ix = p.built();
    let t = ix
        .summary_targets(10)
        .unwrap()
        .into_iter()
        .find(|t| t.doc.rel == "src/lib.rs")
        .unwrap();
    ix.put_summary(t.doc.file_id, &t.content_hash, "kept")
        .unwrap();
    // Touch without changing content: the summary stays.
    p.write(
        "src/lib.rs",
        "pub struct Store;\nimpl Store {\n    pub fn open() -> Self { Store }\n}\n",
    );
    ix.update_paths(&[p.path("src/lib.rs")]).unwrap();
    assert_eq!(ix.file_docs(10).unwrap()[0].summary, "kept");
    p.write("src/lib.rs", "pub struct Store2;\n");
    ix.update_paths(&[p.path("src/lib.rs")]).unwrap();
    assert_eq!(ix.file_docs(10).unwrap()[0].summary, "");
}

#[test]
fn read_file_docs_needs_no_writer() {
    let p = Project::new();
    assert!(
        crate::read_file_docs(p.root(), 10).unwrap().is_empty(),
        "no index yet"
    );
    fixture(&p);
    drop(p.built());
    let docs = crate::read_file_docs(p.root(), 2).unwrap();
    // Capped by exported-symbol count, returned in path order.
    assert_eq!(
        docs.iter().map(|d| d.rel.as_str()).collect::<Vec<_>>(),
        ["src/lib.rs", "web/app.ts"]
    );
    assert_eq!(
        docs[1].text(),
        "File web/app.ts (typescript). Defines: fn run, class App, method start. Imports: ./x."
    );
    assert_eq!(docs[0].aliases(), ["lib", "Store", "open"]);
}
