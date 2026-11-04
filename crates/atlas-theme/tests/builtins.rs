//! `themes/` is a copy of `@tryatlas/design`'s, refreshed by `bun run
//! theme:keys`, but `BUILT_INS` in `src/lib.rs` names each file by hand. A
//! theme the package adds would be copied and never shipped, and a theme it
//! drops would fail only at `include_str!`; this holds the two to one list.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[test]
fn every_copied_theme_is_built_in() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("themes");
    let mut on_disk = BTreeSet::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "toml") {
            on_disk.insert(atlas_theme::load_theme_file(&path).unwrap().id);
        }
    }
    let built_in: BTreeSet<String> = atlas_theme::built_in_themes()
        .unwrap()
        .into_iter()
        .map(|theme| theme.id)
        .collect();
    assert_eq!(
        built_in, on_disk,
        "BUILT_INS in src/lib.rs must list exactly the files in themes/"
    );
}
