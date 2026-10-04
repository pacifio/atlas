use super::*;

fn chunks_of(rel: &str, src: &str) -> Vec<crate::chunk::ChunkRec> {
    let lang = crate::Lang::from_path(rel).unwrap();
    let ex = crate::extract::extract(
        lang,
        rel,
        src.as_bytes(),
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    ex.chunks
}

#[test]
fn small_file_is_one_chunk_headed_by_its_first_symbol() {
    let c = chunks_of(
        "src/a.rs",
        "/// Adds.\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    );
    assert_eq!(c.len(), 1);
    assert!(
        c[0].header.starts_with("src/a.rs :: add"),
        "{}",
        c[0].header
    );
    assert_eq!((c[0].start_line, c[0].end_line), (1, 4));
}

#[test]
fn functions_stay_whole_and_siblings_merge_within_budget() {
    let body = |n: usize| format!("pub fn f{n}() {{\n{}}}\n", "    let x = 1;\n".repeat(40));
    let src: String = (0..12).map(body).collect();
    let c = chunks_of("src/many.rs", &src);
    assert!(
        c.len() > 1 && c.len() < 12,
        "merged, not one per fn: {}",
        c.len()
    );
    for ch in &c {
        let text: String = src
            .lines()
            .skip(ch.start_line as usize - 1)
            .take((ch.end_line - ch.start_line + 1) as usize)
            .collect();
        assert!(
            text.chars().filter(|c| !c.is_whitespace()).count() <= crate::chunk::BUDGET_NWS + 200
        );
        assert!(
            text.trim_start().starts_with("pub fn"),
            "a chunk starts at a function boundary"
        );
    }
}

#[test]
fn giant_function_is_split_within_budget() {
    let src = format!(
        "pub fn huge() {{\n{}}}\n",
        "    call_something_long(argument_one, argument_two);\n".repeat(400)
    );
    let c = chunks_of("src/huge.rs", &src);
    assert!(c.len() >= 5, "{}", c.len());
    assert!(
        c.iter().all(|ch| ch.header.contains("huge")),
        "inner chunks keep their symbol"
    );
}

#[test]
fn empty_file_has_no_chunks() {
    assert!(chunks_of("src/e.rs", "").is_empty());
    assert!(chunks_of("src/c.rs", "// only a comment\n").len() <= 1);
}

#[test]
fn chunks_are_stored_searchable_and_removed_with_their_file() {
    let p = Project::new();
    p.write(
        "src/a.rs",
        "pub fn parse_config_file() {\n    let tomlish = 1;\n}\n",
    );
    let ix = p.built();
    let hits: i64 = ix
        .with_reader(|c| {
            c.query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH 'tomlish'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(hits, 1);
    let camel: i64 = ix
        .with_reader(|c| {
            c.query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH 'config'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(camel, 1, "snake/camel parts are searchable");
    std::fs::remove_file(p.path("src/a.rs")).unwrap();
    ix.update_paths(&[p.path("src/a.rs")]).unwrap();
    let left: i64 = ix
        .with_reader(|c| c.query_row("SELECT count(*) FROM chunks", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(left, 0);
}
