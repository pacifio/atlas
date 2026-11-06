//! A VS Code colour-theme extension, unpacked: what an Open VSX install of a
//! theme is.
//!
//! The extension's `package.json` names its themes under
//! `contributes.themes`, each a label and a path to a theme file. Every one
//! is imported as a VS Code theme read off disk, so an `include` resolves the
//! way it does for a file the user chose — except that it may not leave the
//! extension (`ImportOptions::include_root`).
//!
//! One extension is often a family (Dracula and Dracula Soft; GitHub's ten),
//! and the preview already shows one candidate per theme. A theme this cannot
//! read is skipped and said so, rather than failing the ones beside it.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    import_themes, parse_json, read_source_file, ImportFormat, ImportOptions, ImportedTheme,
};
use crate::ThemeError;

/// The themes an extension yielded, and the ones it did not.
#[derive(Debug)]
pub struct ExtensionImport {
    pub themes: Vec<ImportedTheme>,
    /// One line per contributed theme that was skipped, saying why.
    pub skipped: Vec<String>,
}

/// Import every colour theme the extension unpacked at `dir` contributes.
///
/// `options` carries what the caller knows about the extension (its origin,
/// publisher and licence); each theme's label becomes its name.
pub fn import_extension(
    dir: &Path,
    options: &ImportOptions,
) -> Result<ExtensionImport, ThemeError> {
    let manifest = read_source_file(&dir.join("package.json")).map_err(|error| {
        crate::validation(
            &options.origin,
            format!("the extension has no readable package.json: {error}"),
        )
    })?;
    let manifest = parse_json(&manifest, options)?;
    let contributed = manifest
        .get("contributes")
        .and_then(|contributes| contributes.get("themes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if contributed.is_empty() {
        return Err(crate::validation(
            &options.origin,
            "the extension contributes no colour themes",
        ));
    }

    let root = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let mut themes = Vec::new();
    let mut skipped = Vec::new();
    for entry in contributed {
        let path = entry
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let label = entry
            .get("label")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(path)
            .to_string();
        match import_one(&root, path, &label, options) {
            Ok(mut imported) => themes.append(&mut imported),
            Err(reason) => skipped.push(format!("{label}: {reason}")),
        }
    }
    if themes.is_empty() {
        return Err(crate::validation(
            &options.origin,
            format!(
                "none of its themes could be imported — {}",
                skipped.join("; ")
            ),
        ));
    }
    Ok(ExtensionImport { themes, skipped })
}

fn import_one(
    root: &Path,
    path: &str,
    label: &str,
    options: &ImportOptions,
) -> Result<Vec<ImportedTheme>, String> {
    if path.is_empty() {
        return Err("names no theme file".to_string());
    }
    // TextMate themes predate VS Code's format and carry no workbench colours,
    // so there is nothing for Atlas's chrome to take from one.
    if !path.to_ascii_lowercase().ends_with(".json") {
        return Err(format!(
            "`{path}` is a TextMate theme, which Atlas does not import"
        ));
    }
    let file = contained(root, path).ok_or_else(|| format!("`{path}` is outside the extension"))?;
    let source = read_source_file(&file).map_err(|error| format!("`{path}`: {error}"))?;
    let options = ImportOptions {
        origin: format!("{} ({path})", options.origin),
        name_hint: Some(label.to_string()),
        include_root: Some(root.to_path_buf()),
        ..options.clone()
    };
    import_themes(&source, Some(ImportFormat::VsCode), file.parent(), &options)
        .map_err(|error| error.to_string())
}

/// `root/relative`, if it exists and stays inside `root` once resolved.
fn contained(root: &Path, relative: &str) -> Option<PathBuf> {
    let file = root.join(relative).canonicalize().ok()?;
    file.starts_with(root).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, relative: &str, text: &str) {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    const MANIFEST: &str = r#"{
      "name": "nightfall",
      "contributes": { "themes": [
        { "label": "Nightfall", "uiTheme": "vs-dark", "path": "./themes/nightfall.json" },
        { "label": "Nightfall Soft", "uiTheme": "vs-dark", "path": "./themes/soft.json" },
        { "label": "Nightfall Classic", "uiTheme": "vs-dark", "path": "./themes/classic.tmTheme" },
        { "label": "Escapee", "uiTheme": "vs-dark", "path": "../outside.json" }
      ] }
    }"#;

    const NIGHTFALL: &str = r##"{
      "name": "nightfall", "type": "dark",
      "colors": { "editor.background": "#101418", "editor.foreground": "#c0caf5", "focusBorder": "#7aa2f7" },
      "tokenColors": [ { "scope": "string", "settings": { "foreground": "#9ece6a" } } ]
    }"##;

    fn extension() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("extension");
        write(&root, "package.json", MANIFEST);
        write(&root, "themes/nightfall.json", NIGHTFALL);
        // Soft is Nightfall with a lighter background, by `include`.
        write(
            &root,
            "themes/soft.json",
            r##"{ "include": "./nightfall.json", "colors": { "editor.background": "#1a1f26" } }"##,
        );
        write(&root, "themes/classic.tmTheme", "<plist/>");
        write(dir.path(), "outside.json", NIGHTFALL);
        dir
    }

    fn options() -> ImportOptions {
        ImportOptions {
            origin: "nightfall.nightfall".to_string(),
            author_hint: Some("Nightfall Labs".to_string()),
            license_hint: Some("MIT".to_string()),
            ..ImportOptions::default()
        }
    }

    #[test]
    fn imports_each_json_theme_under_its_label() {
        let dir = extension();
        let imported = import_extension(&dir.path().join("extension"), &options()).unwrap();
        let names: Vec<_> = imported
            .themes
            .iter()
            .map(|t| t.theme.name.as_str())
            .collect();
        assert_eq!(names, ["Nightfall", "Nightfall Soft"]);
        let soft = &imported.themes[1];
        assert_eq!(soft.theme.author, "Nightfall Labs");
        assert_eq!(soft.theme.license, "MIT");
        assert!(
            soft.report
                .summary
                .iter()
                .any(|note| note.contains("nightfall.json")),
            "the include should resolve inside the extension: {:?}",
            soft.report.summary
        );
    }

    #[test]
    fn skips_textmate_themes_and_paths_outside_the_extension() {
        let dir = extension();
        let imported = import_extension(&dir.path().join("extension"), &options()).unwrap();
        assert_eq!(imported.skipped.len(), 2, "{:?}", imported.skipped);
        assert!(imported.skipped[0].contains("TextMate"));
        assert!(imported.skipped[1].contains("outside the extension"));
    }

    #[test]
    fn an_include_may_not_leave_the_extension() {
        let dir = extension();
        let root = dir.path().join("extension");
        write(
            &root,
            "themes/nightfall.json",
            r##"{ "include": "../../outside.json", "colors": { "editor.background": "#101418" } }"##,
        );
        let imported = import_extension(&root, &options()).unwrap();
        assert!(
            imported.themes[0]
                .report
                .warnings
                .iter()
                .any(|warning| warning.contains("outside the extension")),
            "{:?}",
            imported.themes[0].report.warnings
        );
    }

    #[test]
    fn an_extension_without_colour_themes_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "package.json",
            r#"{ "contributes": { "iconThemes": [] } }"#,
        );
        let error = import_extension(dir.path(), &options()).unwrap_err();
        assert!(error.to_string().contains("no colour themes"), "{error}");
    }
}
