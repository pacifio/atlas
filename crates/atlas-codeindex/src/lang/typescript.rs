//! TypeScript / TSX / JavaScript: declarations, class members, and
//! `const X = () =>` components named from their declarator.

use tree_sitter::Node;

use super::{named_children, push_import, text, unquote, DefName, Fields, LangSpec, ScopeView};
use crate::extract::ImportRec;

pub(super) const SPEC: LangSpec = LangSpec {
    defs: &[
        ("function_declaration", "fn"),
        ("generator_function_declaration", "fn"),
        ("class_declaration", "class"),
        ("abstract_class_declaration", "class"),
        ("interface_declaration", "interface"),
        ("type_alias_declaration", "type"),
        ("enum_declaration", "enum"),
        ("internal_module", "namespace"),
        ("method_definition", "method"),
        ("abstract_method_signature", "method"),
        ("public_field_definition", "method"),
        ("variable_declarator", "const"),
    ],
    type_scopes: &["class_declaration", "abstract_class_declaration"],
    module_scopes: &["internal_module"],
    opaque: &[
        "function_declaration",
        "generator_function_declaration",
        "method_definition",
        "abstract_method_signature",
        "public_field_definition",
        "variable_declarator",
        "arrow_function",
        "function_expression",
        "generator_function",
        "class",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
        "comment",
        "string",
        "template_string",
        "object",
        "import_statement",
    ],
    wrappers: &[
        "export_statement",
        "ambient_declaration",
        "lexical_declaration",
        "variable_declaration",
    ],
    decorated: &[],
    exporting: &["export_statement"],
    attributes: &[],
    comments: &["comment"],
    imports: &["import_statement", "export_statement"],
    sep: ".",
};

fn is_function_value(node: Node) -> bool {
    matches!(
        node.kind(),
        "arrow_function" | "function_expression" | "generator_function"
    )
}

pub(super) fn def_names(
    node: Node,
    kind: &'static str,
    src: &[u8],
    f: &Fields,
    scope: &ScopeView,
) -> Vec<DefName> {
    let Some(name) = node.child_by_field_id(f.name) else {
        return Vec::new();
    };
    let value = node.child_by_field_id(f.value);
    let kind = match node.kind() {
        // `const Foo = () => …` is a function; other module-level `const`s are
        // constants; `let`/`var` and anything inside a class are not indexed.
        "variable_declarator" => {
            if scope.members || name.kind() != "identifier" {
                return Vec::new();
            }
            if value.is_some_and(is_function_value) {
                "fn"
            } else if declaration_keyword(node, src, f) == "const" {
                "const"
            } else {
                return Vec::new();
            }
        }
        // A class field is indexed only when it holds a function.
        "public_field_definition" if !value.is_some_and(is_function_value) => return Vec::new(),
        _ => kind,
    };
    let name = match name.kind() {
        "string" => unquote(text(name, src)),
        _ => text(name, src).to_string(),
    };
    vec![DefName {
        kind,
        name,
        qualified: None,
    }]
}

/// `const` / `let` / `var` of the declaration a declarator belongs to.
fn declaration_keyword<'a>(declarator: Node, src: &'a [u8], f: &Fields) -> &'a str {
    declarator
        .parent()
        .map_or("", |decl| match decl.child_by_field_id(f.kind) {
            Some(k) => text(k, src),
            // `variable_declaration` (`var x = …`) carries no `kind` field.
            None => "var",
        })
}

pub(super) fn signature_prefix(node: Node, src: &[u8], f: &Fields) -> String {
    if node.kind() == "variable_declarator" {
        format!("{} ", declaration_keyword(node, src, f))
    } else {
        String::new()
    }
}

/// For `const f = () => {…}`, the signature stops at the arrow function's body.
pub(super) fn value_body(node: Node, f: &Fields) -> Option<usize> {
    let value = node.child_by_field_id(f.value)?;
    if !is_function_value(value) {
        return None;
    }
    value.child_by_field_id(f.body).map(|b| b.start_byte())
}

pub(super) fn is_exported(
    node: Node,
    src: &[u8],
    wrapped_export: bool,
    member_exported: Option<bool>,
) -> bool {
    match member_exported {
        None => wrapped_export,
        Some(class_exported) => {
            let private = named_children(node).iter().any(|c| {
                (c.kind() == "accessibility_modifier" && text(*c, src) != "public")
                    || c.kind() == "private_property_identifier"
            });
            class_exported && !private
        }
    }
}

pub(super) fn imports(node: Node, src: &[u8], f: &Fields, out: &mut Vec<ImportRec>) {
    let Some(source) = node.child_by_field_id(f.source) else {
        return; // an `export` without `from`: not an import
    };
    let module = unquote(text(source, src));
    let before = out.len();
    for child in named_children(node) {
        match child.kind() {
            "import_clause" => {
                for c in named_children(child) {
                    match c.kind() {
                        "identifier" => push_import(out, text(c, src), &module, node),
                        "namespace_import" => {
                            if let Some(id) = named_children(c).first() {
                                push_import(out, text(*id, src), &module, node);
                            }
                        }
                        "named_imports" => specifiers(c, src, f, &module, node, out),
                        _ => {}
                    }
                }
            }
            "export_clause" => specifiers(child, src, f, &module, node, out),
            "namespace_export" => {
                if let Some(id) = named_children(child).first() {
                    push_import(out, &unquote(text(*id, src)), &module, node);
                }
            }
            _ => {}
        }
    }
    if out.len() == before {
        // `import "./side-effect"` binds nothing; `export * from "m"` re-exports all.
        let local = if node.kind() == "export_statement" {
            "*"
        } else {
            ""
        };
        push_import(out, local, &module, node);
    }
}

/// `{ a, b as c }` in an import or a re-export.
fn specifiers(
    list: Node,
    src: &[u8],
    f: &Fields,
    module: &str,
    decl: Node,
    out: &mut Vec<ImportRec>,
) {
    for spec in named_children(list) {
        let local = spec
            .child_by_field_id(f.alias)
            .or_else(|| spec.child_by_field_id(f.name));
        if let Some(local) = local {
            push_import(out, &unquote(text(local, src)), module, decl);
        }
    }
}
