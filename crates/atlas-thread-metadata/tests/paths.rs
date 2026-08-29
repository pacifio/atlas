//! `PathList` as a grouping key — the property the sidebar depends on.
//!
//! One project reaches the store spelled several ways (a symlinked checkout, a
//! trailing separator, `/var` vs `/private/var` on macOS, `..` segments from a
//! shell-derived cwd). Every spelling has to produce the SAME key, or one
//! project's history splits across several buckets and the "current project"
//! test matches none of them.

use std::path::{Path, PathBuf};

use atlas_thread_metadata::PathList;

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("temp dir")
}

#[test]
fn a_symlinked_checkout_is_the_same_project_as_its_target() {
    let dir = tmp();
    let real = dir.path().join("project");
    std::fs::create_dir(&real).unwrap();
    let link = dir.path().join("link-to-project");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &link).unwrap();
    #[cfg(not(unix))]
    return;

    assert_eq!(
        PathList::new(&[&real]),
        PathList::new(&[&link]),
        "opening a project through a symlink must not create a second history bucket"
    );
}

#[test]
fn a_trailing_separator_does_not_change_the_key() {
    let dir = tmp();
    let real = dir.path().join("project");
    std::fs::create_dir(&real).unwrap();
    let with_sep = PathBuf::from(format!("{}/", real.display()));

    assert_eq!(PathList::new(&[&real]), PathList::new(&[&with_sep]));
}

#[test]
fn a_relative_hop_resolves_to_the_directory_it_lands_in() {
    let dir = tmp();
    let real = dir.path().join("project");
    std::fs::create_dir(&real).unwrap();
    let sibling = dir.path().join("other");
    std::fs::create_dir(&sibling).unwrap();
    let round_trip = sibling.join("..").join("project");

    assert_eq!(PathList::new(&[&real]), PathList::new(&[&round_trip]));
}

#[test]
fn a_path_that_no_longer_exists_still_groups_with_itself() {
    // Canonicalisation needs the path to exist. A deleted project must not
    // panic or collapse into some other bucket — it just keeps its own.
    let missing = Path::new("/definitely/not/a/real/path/atlas-test");
    let list = PathList::new(&[missing]);

    assert_eq!(list, PathList::new(&[missing]));
    assert!(list.contains(missing));
    assert_ne!(list, PathList::new(&[Path::new("/definitely/not/elsewhere")]));
}

#[test]
fn contains_matches_whatever_spelling_the_caller_has() {
    let dir = tmp();
    let real = dir.path().join("project");
    std::fs::create_dir(&real).unwrap();
    let list = PathList::new(&[&real]);

    // This is the sidebar's "is this the open project" test.
    assert!(list.contains(&PathBuf::from(format!("{}/", real.display()))));
}

#[test]
fn the_key_ignores_the_order_paths_were_given_in() {
    let dir = tmp();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();

    assert_eq!(PathList::new(&[&a, &b]), PathList::new(&[&b, &a]));
}

#[test]
fn serialisation_round_trips_through_the_database_columns() {
    let dir = tmp();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let list = PathList::new(&[&b, &a]);

    let back = PathList::deserialize(&list.serialize());
    assert_eq!(back, list);
    assert_eq!(
        back.ordered_paths().collect::<Vec<_>>(),
        list.ordered_paths().collect::<Vec<_>>(),
        "display order survives the round trip"
    );
}
