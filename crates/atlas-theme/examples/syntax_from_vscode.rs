//! Prints the `syntax.*` keys Atlas's own VS Code importer produces for a
//! colour theme, as TOML lines. `scripts/theme-pierre.mjs` runs it over
//! `@pierre/theme` to write the Atlas theme's syntax colours, so they come
//! from the same scope mapping a user's imported theme gets.
//!
//! cargo run -q -p atlas-theme --example syntax_from_vscode -- <theme.json>

use std::path::Path;

use atlas_theme::import::{import_themes, ImportOptions};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: syntax_from_vscode <theme.json>");
    let source = std::fs::read_to_string(&path).expect("read the theme");
    let options = ImportOptions {
        origin: path.clone(),
        ..ImportOptions::default()
    };
    let imported = import_themes(&source, None, Path::new(&path).parent(), &options)
        .expect("import the theme");
    let theme = &imported[0].theme;
    let variant = theme
        .dark
        .as_ref()
        .or(theme.light.as_ref())
        .expect("a variant");
    for (key, value) in variant
        .keys
        .iter()
        .filter(|(key, _)| key.starts_with("syntax."))
    {
        println!("{key:?} = {:?}", value.color());
    }
}
