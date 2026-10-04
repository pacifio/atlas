use super::*;
use crate::RepoMapFocus;

fn hub_project() -> (Project, CodeIndex) {
    let p = Project::new();
    p.write(
        "src/lib.rs",
        "pub mod store;\npub mod a;\npub mod b;\npub mod c;\npub mod lonely;\n",
    );
    p.write(
        "src/store.rs",
        "pub struct Store;\nimpl Store {\n    pub fn open_database() -> Store { Store }\n}\n",
    );
    for m in ["a", "b", "c"] {
        p.write(
            &format!("src/{m}.rs"),
            "use crate::store::Store;\npub fn go() { let _s = Store::open_database(); }\n",
        );
    }
    p.write("src/lonely.rs", "pub fn unused_helper() {}\n");
    let ix = p.built();
    (p, ix)
}

#[test]
fn the_most_referenced_definition_leads_the_map() {
    let (_p, ix) = hub_project();
    let map = ix.repo_map(&RepoMapFocus::default(), 1000).unwrap();
    let first_file = map.lines().next().unwrap();
    assert_eq!(first_file, "src/store.rs:");
    assert!(map.contains("open_database"));
}

#[test]
fn focus_files_are_left_out_and_their_neighbours_rise() {
    let (_p, ix) = hub_project();
    let map = ix
        .repo_map(
            &RepoMapFocus {
                files: vec!["src/a.rs".into()],
                idents: vec![],
                within: None,
            },
            1000,
        )
        .unwrap();
    assert!(!map.contains("src/a.rs:"), "{map}");
    assert!(map.starts_with("src/store.rs:"), "{map}");
}

#[test]
fn repo_map_is_deterministic_and_fits_budget() {
    let (_p, ix) = hub_project();
    let a = ix.repo_map(&RepoMapFocus::default(), 60).unwrap();
    let b = ix.repo_map(&RepoMapFocus::default(), 60).unwrap();
    assert_eq!(a, b);
    assert!(a.len() / 4 <= 60, "{} bytes", a.len());
    assert!(!a.is_empty());
}

#[test]
fn an_index_without_edges_falls_back_to_importance_order() {
    let p = Project::new();
    p.write("x.py", "def alpha():\n    pass\n");
    let ix = p.built();
    assert!(ix
        .repo_map(&RepoMapFocus::default(), 500)
        .unwrap()
        .contains("alpha"));
}
