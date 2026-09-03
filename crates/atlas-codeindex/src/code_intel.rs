//! Tree-sitter code intelligence: extract a file's imports and top-level symbols.
//!
//! Supports Rust, TypeScript/JavaScript, Python and Go. Ported into Atlas from
//! the Cersei SDK's `tool_primitives::code_intel` so the indexer owns its own
//! parsing and depends on nothing but the upstream tree-sitter grammars.
//!
//! Only the per-file analysis was carried over. Cersei's `scan_project` /
//! `format_project_intel` / config loading are not here: [`crate::scan`] does
//! Atlas's own gitignore-respecting walk and builds its own embeddable text.
//!
//! ## Why the traversal is shallow
//!
//! [`analyze_file`] walks the AST but only descends into *container* nodes (see
//! [`is_container_node`]) — module/class/impl bodies, never function bodies.
//! The index wants "what does this file declare", so the cost of walking every
//! expression node buys nothing. This is what keeps a full-repo scan cheap.

use std::path::Path;

use tree_sitter::Parser;

/// A file's extracted structure.
#[derive(Debug, Clone, Default)]
pub struct FileIntel {
    pub language: Language,
    pub imports: Vec<String>,
    pub symbols: Vec<Symbol>,
}

/// One top-level declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// 1-based line number of the declaration.
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Struct,
    Class,
    Interface,
    Enum,
    Module,
    Type,
    Constant,
}

impl SymbolKind {
    /// Short label used in the index documents ("fn", "struct", …).
    pub fn label(&self) -> &'static str {
        match self {
            Self::Function => "fn",
            Self::Struct => "struct",
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Enum => "enum",
            Self::Module => "mod",
            Self::Type => "type",
            Self::Constant => "const",
        }
    }
}

/// Source language, at the granularity the *parser* cares about.
///
/// `Tsx` is separate from `TypeScript` only because upstream ships two
/// mutually-exclusive grammars: the TypeScript grammar cannot parse JSX, and
/// the TSX grammar cannot parse `<T>` type assertions. Both still report
/// `"typescript"` from [`label`](Self::label), so the distinction never leaks
/// into the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Language {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
    #[default]
    Unknown,
}

impl Language {
    pub fn from_extension(ext: &str) -> Self {
        match ext {
            "rs" => Self::Rust,
            "ts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "js" | "jsx" | "mjs" | "cjs" => Self::JavaScript,
            "py" | "pyi" => Self::Python,
            "go" => Self::Go,
            _ => Self::Unknown,
        }
    }

    /// Stable lowercase name recorded on each indexed document.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript | Self::Tsx => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
            Self::Unknown => "unknown",
        }
    }
}

/// Extract imports and top-level symbols from `source`.
///
/// Imports and symbols come back in source order.
///
/// Returns `None` for an unsupported extension or a file tree-sitter cannot
/// parse at all. A file that simply declares nothing yields an empty
/// [`FileIntel`], not `None`.
pub fn analyze_file(path: &Path, source: &str) -> Option<FileIntel> {
    let ext = path.extension()?.to_str()?;
    analyze_source(Language::from_extension(ext), source)
}

/// Same as [`analyze_file`] but with the language chosen by the caller.
pub fn analyze_source(lang: Language, source: &str) -> Option<FileIntel> {
    if lang == Language::Unknown {
        return None;
    }

    let mut parser = Parser::new();
    let ts_lang = match lang {
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        // `.tsx` needs the JSX-aware grammar. `.js`/`.jsx` go here too: JSX in a
        // plain `.js` file is common in React code, and the TSX grammar is a
        // superset of JavaScript syntax.
        Language::Tsx | Language::JavaScript => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        Language::Unknown => return None,
    };
    parser.set_language(&ts_lang).ok()?;
    let tree = parser.parse(source, None)?;
    let bytes = source.as_bytes();

    let mut imports = Vec::new();
    let mut symbols = Vec::new();

    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        let kind = node.kind();

        // Name-carrying declaration → one symbol at this node's line.
        let mut push_named = |k: SymbolKind| {
            if let Some(name) = node.child_by_field_name("name") {
                if let Ok(n) = name.utf8_text(bytes) {
                    symbols.push(Symbol {
                        name: n.to_string(),
                        kind: k,
                        line: node.start_position().row + 1,
                    });
                }
            }
        };

        match lang {
            Language::Rust => match kind {
                "use_declaration" => {
                    if let Ok(text) = node.utf8_text(bytes) {
                        imports.push(text.trim().to_string());
                    }
                }
                "function_item" => push_named(SymbolKind::Function),
                "struct_item" => push_named(SymbolKind::Struct),
                "enum_item" => push_named(SymbolKind::Enum),
                "mod_item" => push_named(SymbolKind::Module),
                "trait_item" => push_named(SymbolKind::Interface),
                "type_item" => push_named(SymbolKind::Type),
                "const_item" | "static_item" => push_named(SymbolKind::Constant),
                _ => {}
            },
            Language::TypeScript | Language::Tsx | Language::JavaScript => match kind {
                "import_statement" => {
                    if let Some(source_node) = node.child_by_field_name("source") {
                        if let Ok(text) = source_node.utf8_text(bytes) {
                            imports.push(text.trim_matches(|c| c == '"' || c == '\'').to_string());
                        }
                    }
                }
                "function_declaration" => push_named(SymbolKind::Function),
                "class_declaration" => push_named(SymbolKind::Class),
                "interface_declaration" => push_named(SymbolKind::Interface),
                "type_alias_declaration" => push_named(SymbolKind::Type),
                "enum_declaration" => push_named(SymbolKind::Enum),
                // `export ...` wraps the real declaration. Descending is handled
                // by `is_container_node`; pushing the `declaration` field here
                // too would visit it twice and double every exported symbol.
                _ => {}
            },
            Language::Python => match kind {
                "import_statement" | "import_from_statement" => {
                    if let Ok(text) = node.utf8_text(bytes) {
                        imports.push(text.trim().to_string());
                    }
                }
                "function_definition" => push_named(SymbolKind::Function),
                "class_definition" => push_named(SymbolKind::Class),
                _ => {}
            },
            Language::Go => match kind {
                "import_declaration" => {
                    if let Ok(text) = node.utf8_text(bytes) {
                        imports.push(text.trim().to_string());
                    }
                }
                "function_declaration" | "method_declaration" => push_named(SymbolKind::Function),
                // Go's `type` block holds one spec per declared type; the
                // spec's own `type` field says whether it's a struct/interface.
                // `type A = B` parses as `type_alias`, a DIFFERENT node kind —
                // missing it silently dropped every Go type alias.
                "type_spec" => {
                    let ty = node.child_by_field_name("type").map(|t| t.kind());
                    push_named(match ty {
                        Some("struct_type") => SymbolKind::Struct,
                        Some("interface_type") => SymbolKind::Interface,
                        _ => SymbolKind::Type,
                    });
                }
                "type_alias" => push_named(SymbolKind::Type),
                _ => {}
            },
            Language::Unknown => {}
        }

        if is_container_node(kind) {
            // The stack is LIFO, so push children reversed to pop them — and
            // therefore emit imports/symbols — in source order.
            let mut cursor = node.walk();
            // The collect is load-bearing: tree-sitter's children iterator is
            // not double-ended, so reversing needs the Vec.
            #[allow(clippy::needless_collect)]
            let children: Vec<_> = node.children(&mut cursor).collect();
            for child in children.into_iter().rev() {
                stack.push(child);
            }
        }
    }

    Some(FileIntel {
        language: lang,
        imports,
        symbols,
    })
}

/// Whether to descend into `kind`. Only structural containers — never a
/// function body, whose locals are noise for an index of declarations.
fn is_container_node(kind: &str) -> bool {
    matches!(
        kind,
        "source_file"
            | "program"
            | "module"
            | "declaration_list"
            | "block"
            | "statement_block"
            | "export_statement"
            | "type_declaration"
            | "impl_item" // Rust impl blocks contain methods
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn names(intel: &FileIntel, kind: SymbolKind) -> Vec<&str> {
        intel
            .symbols
            .iter()
            .filter(|s| s.kind == kind)
            .map(|s| s.name.as_str())
            .collect()
    }

    #[test]
    fn language_from_extension() {
        assert_eq!(Language::from_extension("rs"), Language::Rust);
        assert_eq!(Language::from_extension("ts"), Language::TypeScript);
        assert_eq!(Language::from_extension("tsx"), Language::Tsx);
        assert_eq!(Language::from_extension("mjs"), Language::JavaScript);
        // The TS/TSX split is a grammar detail; the index label must not see it.
        assert_eq!(Language::Tsx.label(), "typescript");
        assert_eq!(Language::TypeScript.label(), "typescript");
        assert_eq!(Language::from_extension("pyi"), Language::Python);
        assert_eq!(Language::from_extension("go"), Language::Go);
        assert_eq!(Language::from_extension("txt"), Language::Unknown);
    }

    #[test]
    fn unsupported_extension_is_none() {
        assert!(analyze_file(Path::new("notes.txt"), "hello").is_none());
        assert!(analyze_file(Path::new("noext"), "hello").is_none());
    }

    #[test]
    fn rust_symbols_and_imports() {
        let src = r#"
use std::collections::HashMap;
use serde::Serialize;

pub const LIMIT: usize = 10;

pub struct Widget { pub id: u32 }

pub enum Mode { On, Off }

pub trait Render { fn draw(&self); }

pub type Alias = Widget;

pub mod inner {}

pub fn build() -> Widget {
    // a local fn inside a body must NOT be indexed
    fn helper() {}
    helper();
    Widget { id: 0 }
}

impl Widget {
    pub fn method(&self) {}
}
"#;
        let intel = analyze_file(Path::new("w.rs"), src).unwrap();
        assert_eq!(intel.language, Language::Rust);
        assert_eq!(intel.imports.len(), 2);
        assert!(intel.imports[0].contains("HashMap") || intel.imports[1].contains("HashMap"));

        assert_eq!(names(&intel, SymbolKind::Struct), ["Widget"]);
        assert_eq!(names(&intel, SymbolKind::Enum), ["Mode"]);
        assert_eq!(names(&intel, SymbolKind::Interface), ["Render"]);
        assert_eq!(names(&intel, SymbolKind::Type), ["Alias"]);
        assert_eq!(names(&intel, SymbolKind::Module), ["inner"]);
        assert_eq!(names(&intel, SymbolKind::Constant), ["LIMIT"]);

        // `build` and the impl's `method` are indexed; the body-local `helper`
        // is not — that's the shallow-traversal contract.
        let fns = names(&intel, SymbolKind::Function);
        assert!(fns.contains(&"build"), "{fns:?}");
        assert!(fns.contains(&"method"), "{fns:?}");
        assert!(!fns.contains(&"helper"), "body-local fn leaked: {fns:?}");
    }

    #[test]
    fn typescript_symbols_and_import_paths() {
        let src = r#"
import { useState } from "react";
import type { Foo } from '../types';

export interface Props { id: string }
export type Alias = Props;
export enum Color { Red }
export class Widget {}
export function build(): void {}
function localOnly(): void {}
"#;
        let intel = analyze_file(Path::new("w.ts"), src).unwrap();
        assert_eq!(intel.language, Language::TypeScript);
        // Import *paths* are unquoted, not the whole statement.
        assert_eq!(intel.imports, ["react", "../types"]);

        assert_eq!(names(&intel, SymbolKind::Interface), ["Props"]);
        assert_eq!(names(&intel, SymbolKind::Type), ["Alias"]);
        assert_eq!(names(&intel, SymbolKind::Enum), ["Color"]);
        assert_eq!(names(&intel, SymbolKind::Class), ["Widget"]);

        // Exported declarations are reached through `export_statement`.
        let fns = names(&intel, SymbolKind::Function);
        assert!(fns.contains(&"build"), "{fns:?}");
        assert!(fns.contains(&"localOnly"), "{fns:?}");
    }

    #[test]
    fn tsx_jsx_bodies_still_yield_symbols() {
        let src = r#"
import { useState } from "react";

export interface Props { id: string }

export function Widget({ id }: Props) {
  const [n, setN] = useState(0);
  return <div className="x" onClick={() => setN(n + 1)}>{id}: {n}</div>;
}

export class Legacy extends React.Component {
  render() { return <><span/></>; }
}
"#;
        let intel = analyze_file(Path::new("w.tsx"), src).unwrap();
        assert_eq!(intel.language, Language::Tsx);
        assert_eq!(intel.imports, ["react"]);
        assert_eq!(names(&intel, SymbolKind::Interface), ["Props"]);
        assert_eq!(names(&intel, SymbolKind::Class), ["Legacy"]);
        assert!(names(&intel, SymbolKind::Function).contains(&"Widget"));
    }

    #[test]
    fn jsx_in_plain_js_still_parses() {
        let src = r#"
import React from "react";
export function App() { return <div>hi</div>; }
"#;
        let intel = analyze_file(Path::new("a.js"), src).unwrap();
        assert_eq!(intel.language, Language::JavaScript);
        assert!(names(&intel, SymbolKind::Function).contains(&"App"));
    }

    #[test]
    fn python_symbols() {
        let src = r#"
import os
from typing import List

def build():
    def helper():
        pass
    return 1

class Widget:
    def method(self):
        pass
"#;
        let intel = analyze_file(Path::new("w.py"), src).unwrap();
        assert_eq!(intel.language, Language::Python);
        assert_eq!(intel.imports.len(), 2);
        assert_eq!(names(&intel, SymbolKind::Class), ["Widget"]);
        let fns = names(&intel, SymbolKind::Function);
        assert!(fns.contains(&"build"), "{fns:?}");
        assert!(!fns.contains(&"helper"), "body-local def leaked: {fns:?}");
    }

    #[test]
    fn go_type_specs_are_classified() {
        let src = r#"
package main

import "fmt"

type Widget struct { ID int }
type Render interface { Draw() }
type Alias = Widget

func build() {}
func (w Widget) Method() {}
"#;
        let intel = analyze_file(Path::new("w.go"), src).unwrap();
        assert_eq!(intel.language, Language::Go);
        assert!(!intel.imports.is_empty());
        assert_eq!(names(&intel, SymbolKind::Struct), ["Widget"]);
        assert_eq!(names(&intel, SymbolKind::Interface), ["Render"]);
        assert_eq!(names(&intel, SymbolKind::Type), ["Alias"]);
        let fns = names(&intel, SymbolKind::Function);
        assert!(fns.contains(&"build"), "{fns:?}");
        assert!(fns.contains(&"Method"), "{fns:?}");
    }

    #[test]
    fn empty_and_malformed_sources_do_not_panic() {
        let empty = analyze_file(Path::new("e.rs"), "").unwrap();
        assert!(empty.symbols.is_empty() && empty.imports.is_empty());
        // tree-sitter is error-tolerant: it returns a tree with ERROR nodes
        // rather than failing, so this must still come back Some.
        assert!(analyze_file(Path::new("b.rs"), "fn ((( {").is_some());
    }

    #[test]
    fn symbol_labels_are_stable() {
        assert_eq!(SymbolKind::Function.label(), "fn");
        assert_eq!(SymbolKind::Struct.label(), "struct");
        assert_eq!(SymbolKind::Module.label(), "mod");
        assert_eq!(Language::Rust.label(), "rust");
        assert_eq!(Language::Unknown.label(), "unknown");
    }
}
