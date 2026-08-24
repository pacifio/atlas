//! `atlas-codeindex` — turn a live codebase into fresh, embeddable documents.
//!
//! Deterministic half of the Memory-Chat codebase indexer: walk the project
//! (gitignore-respecting), parse each supported source file with Atlas's own
//! tree-sitter [`code_intel`], and emit one [`CodebaseDoc`] per file carrying
//! its language, imports, top-level symbols, and a content hash for incremental
//! rebuilds. The embedding step and the optional Tier-2 LLM summary both live
//! in the app's command layer; this crate is pure (no network, and no I/O
//! beyond reading source files).

pub mod code_intel;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use code_intel::{Language, SymbolKind};
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
    language.label()
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

    let mut out: Vec<ScannedFile> = Vec::new();
    for entry in walker.flatten() {
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
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().into_owned();
        let Ok(source) = std::fs::read_to_string(path) else {
            continue;
        };
        let Some(intel) = code_intel::analyze_file(path, &source) else {
            continue;
        };
        if intel.symbols.is_empty() && intel.imports.is_empty() {
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
    std::fs::read(docs_path(project_path))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_index(project_path: &str, index: &CodebaseIndex) -> Result<()> {
    let dir = index_dir(project_path);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let bytes = serde_json::to_vec(index).context("serialize codebase index")?;
    std::fs::write(docs_path(project_path), bytes).context("write docs.json")?;
    Ok(())
}
