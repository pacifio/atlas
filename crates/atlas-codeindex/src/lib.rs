//! `atlas-codeindex` — turn a live codebase into fresh, embeddable documents.
//!
//! Deterministic half of the Memory-Chat codebase indexer: walk the project
//! (gitignore-respecting), parse each supported source file with Cersei's
//! tree-sitter `code_intel`, and emit one [`CodebaseDoc`] per file carrying its
//! language, imports, top-level symbols, and a content hash for incremental
//! rebuilds. The LLM-summary (Tier 2) and embedding steps live in the app's
//! command layer; this crate stays pure (no I/O beyond reading source files).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use cersei::tools::tool_primitives::code_intel::{self, Language, SymbolKind};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Skip files larger than this (minified bundles, generated blobs).
const MAX_SOURCE_BYTES: u64 = 1_000_000;
/// Default cap on indexed files for very large repos.
pub const DEFAULT_MAX_FILES: usize = 1500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSymbol {
    pub name: String,
    /// Short kind label: "fn" | "struct" | "class" | "interface" | "enum" |
    /// "mod" | "type" | "const".
    pub kind: String,
    pub line: u32,
}

/// One indexed source file. Persisted to `.atlas/codebase-index/docs.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseDoc {
    /// Project-relative path.
    pub rel: String,
    /// Absolute path (for opening the file from the chat sources).
    pub abs_path: String,
    pub language: String,
    pub imports: Vec<String>,
    pub symbols: Vec<CodebaseSymbol>,
    /// SHA-256 of the source — drives incremental reuse.
    pub hash: String,
    pub mtime_ms: i64,
    /// LLM summary (Tier 2); empty for structural-only.
    #[serde(default)]
    pub summary: String,
    /// Final embeddable text (summary + structural facts), computed at index time.
    #[serde(default)]
    pub text: String,
    /// Number of project files that import this one — importance for ranking +
    /// which files get a Tier-2 summary first.
    #[serde(default)]
    pub import_rank: u32,
}

/// A freshly-scanned file before incremental merge / summarization.
#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub rel: String,
    pub abs_path: String,
    pub language: String,
    pub imports: Vec<String>,
    pub symbols: Vec<CodebaseSymbol>,
    pub hash: String,
    pub mtime_ms: i64,
}

fn language_label(language: Language) -> &'static str {
    match language {
        Language::Rust => "rust",
        Language::TypeScript => "typescript",
        Language::JavaScript => "javascript",
        Language::Python => "python",
        Language::Go => "go",
        Language::Unknown => "unknown",
    }
}

fn symbol_label(kind: SymbolKind) -> &'static str {
    kind.label()
}

fn content_hash(source: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Walk the project and parse every supported source file. Blocking (reads files
/// + runs tree-sitter); call under `spawn_blocking`.
pub fn scan(root: &Path, mtime_ms_of: impl Fn(&Path) -> i64) -> Vec<ScannedFile> {
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    // Every skip is counted by reason and logged once at the end. A scan that
    // drops files without saying so makes a truncated codebase index
    // indistinguishable from "project has no source" — you cannot trust an
    // eval on a pipeline that loses inputs silently.
    let mut walk_errors: u64 = 0;
    let mut skipped_too_large: u64 = 0;
    let mut skipped_read: u64 = 0;
    let mut skipped_parse: u64 = 0;
    let mut skipped_empty: u64 = 0;

    let mut out: Vec<ScannedFile> = Vec::new();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                walk_errors += 1;
                continue;
            }
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if matches!(Language::from_extension(ext), Language::Unknown) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_SOURCE_BYTES).unwrap_or(true) {
            skipped_too_large += 1;
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().into_owned();
        let Ok(source) = std::fs::read_to_string(path) else {
            skipped_read += 1;
            continue;
        };
        let Some(intel) = code_intel::analyze_file(path, &source) else {
            skipped_parse += 1;
            continue;
        };
        if intel.symbols.is_empty() && intel.imports.is_empty() {
            skipped_empty += 1;
            continue; // grammar produced nothing useful
        }
        out.push(ScannedFile {
            rel,
            abs_path: path.to_string_lossy().into_owned(),
            language: language_label(intel.language).to_string(),
            imports: intel.imports,
            symbols: intel
                .symbols
                .into_iter()
                .map(|s| CodebaseSymbol {
                    name: s.name,
                    kind: symbol_label(s.kind).to_string(),
                    line: s.line as u32,
                })
                .collect(),
            hash: content_hash(&source),
            mtime_ms: mtime_ms_of(path),
        });
    }
    if walk_errors + skipped_too_large + skipped_read + skipped_parse + skipped_empty > 0 {
        tracing::info!(
            target: "atlas::codeindex",
            scanned = out.len() as u64,
            walk_errors,
            skipped_too_large,
            skipped_read,
            skipped_parse,
            skipped_empty,
            "scan_skips"
        );
    }
    out
}

/// Deterministic embeddable text for a file: a compact, natural-language-ish
/// description of what it defines and imports, so a vector query can match it.
pub fn structural_text(rel: &str, language: &str, symbols: &[CodebaseSymbol], imports: &[String]) -> String {
    let mut s = format!("File {rel} ({language}).");
    if !symbols.is_empty() {
        let defs: Vec<String> = symbols
            .iter()
            .take(60)
            .map(|sym| format!("{} {}", sym.kind, sym.name))
            .collect();
        s.push_str(" Defines: ");
        s.push_str(&defs.join(", "));
        s.push('.');
    }
    if !imports.is_empty() {
        let imps: Vec<String> = imports.iter().take(30).cloned().collect();
        s.push_str(" Imports: ");
        s.push_str(&imps.join(", "));
        s.push('.');
    }
    s
}

/// Compose the final embeddable text from an optional summary + structural facts.
pub fn compose_text(summary: &str, structural: &str) -> String {
    if summary.trim().is_empty() {
        structural.to_string()
    } else {
        format!("{}\n{}", summary.trim(), structural)
    }
}

/// Filename stem + symbol names — used as `[[wikilink]]` aliases in the corpus.
pub fn aliases(rel: &str, symbols: &[CodebaseSymbol]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(stem) = Path::new(rel).file_stem().and_then(|s| s.to_str()) {
        out.push(stem.to_string());
    }
    for s in symbols.iter().take(40) {
        out.push(s.name.clone());
    }
    out
}

// ── Persistence ──────────────────────────────────────────────────────────────

pub fn index_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".atlas").join("codebase-index")
}

pub fn docs_path(project_path: &str) -> PathBuf {
    index_dir(project_path).join("docs.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseIndex {
    #[serde(default)]
    pub built_at_ms: i64,
    #[serde(default)]
    pub docs: Vec<CodebaseDoc>,
}

pub fn load_index(project_path: &str) -> CodebaseIndex {
    // Missing file = never indexed = the default, silently. A file that EXISTS
    // but doesn't parse is a different animal — that's a truncated or corrupt
    // write, and swallowing it made it indistinguishable from "never indexed".
    // Callers still get the default (nothing to render), but the defect is on
    // the record instead of invisible.
    let path = docs_path(project_path);
    let Ok(bytes) = std::fs::read(&path) else {
        return CodebaseIndex::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(index) => index,
        Err(e) => {
            tracing::warn!(
                target: "atlas::codeindex",
                "corrupt codebase index at {} ({e}); treating as unindexed",
                path.display()
            );
            CodebaseIndex::default()
        }
    }
}

pub fn save_index(project_path: &str, index: &CodebaseIndex) -> Result<()> {
    let dir = index_dir(project_path);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let bytes = serde_json::to_vec(index).context("serialize codebase index")?;
    // Atomic temp + rename: a crash mid-write must leave the previous
    // codebase index intact, never a truncated docs.json that load_index
    // reads as corrupt.
    let target = docs_path(project_path);
    let tmp = dir.join(format!("docs.json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, bytes).with_context(|| format!("write {}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e)
            .with_context(|| format!("rename {} -> {}", tmp.display(), target.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_project(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("atlas-codeindex-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn save_then_load_round_trips() {
        let project = tmp_project("roundtrip");
        let index = CodebaseIndex {
            built_at_ms: 42,
            docs: vec![CodebaseDoc {
                rel: "a.rs".into(),
                abs_path: "/p/a.rs".into(),
                language: "rust".into(),
                imports: Vec::new(),
                symbols: Vec::new(),
                hash: "h".into(),
                mtime_ms: 1,
                summary: String::new(),
                text: "File a.rs (rust).".into(),
                import_rank: 0,
            }],
        };
        save_index(&project, &index).unwrap();
        let loaded = load_index(&project);
        assert_eq!(loaded.built_at_ms, 42);
        assert_eq!(loaded.docs.len(), 1);
        assert_eq!(loaded.docs[0].rel, "a.rs");
        // The atomic write leaves no temp file behind.
        let leftovers: Vec<_> = std::fs::read_dir(index_dir(&project))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn missing_index_loads_default() {
        let project = tmp_project("missing");
        let loaded = load_index(&project);
        assert_eq!(loaded.built_at_ms, 0);
        assert!(loaded.docs.is_empty());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn corrupt_index_loads_default_instead_of_panicking() {
        let project = tmp_project("corrupt");
        std::fs::create_dir_all(index_dir(&project)).unwrap();
        // A truncated write: valid prefix of real JSON, invalid document.
        std::fs::write(docs_path(&project), b"{\"builtAtMs\": 42, \"docs\": [{\"id\"").unwrap();
        let loaded = load_index(&project);
        assert_eq!(loaded.built_at_ms, 0, "corrupt index must read as unindexed");
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn scan_counts_but_still_returns_files() {
        let project = tmp_project("scan");
        let root = Path::new(&project);
        std::fs::write(root.join("a.rs"), "pub fn alpha() {}\n").unwrap();
        std::fs::write(root.join("noise.txt"), "not source\n").unwrap();
        let files = scan(root, |_| 0);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].rel, "a.rs");
        assert!(files[0].symbols.iter().any(|s| s.name == "alpha"));
        let _ = std::fs::remove_dir_all(&project);
    }
}
