//! Rust: items, impl blocks attributed to their type (`Type::method`),
//! `macro_rules!`, and `use` trees flattened to one row per binding.

use tree_sitter::Node;

use super::{
    field_children, join_qn, named_children, push_import, squash, text, DefName, Fields, LangSpec,
    ScopeView,
};
use crate::extract::ImportRec;

pub(super) const SPEC: LangSpec = LangSpec {
    defs: &[
        ("function_item", "fn"),
        ("function_signature_item", "fn"),
        ("struct_item", "struct"),
        ("enum_item", "enum"),
        ("union_item", "union"),
        ("trait_item", "trait"),
        ("impl_item", "impl"),
        ("mod_item", "mod"),
        ("type_item", "type"),
        ("const_item", "const"),
        ("static_item", "static"),
        ("macro_definition", "macro"),
    ],
    type_scopes: &["impl_item", "trait_item"],
    module_scopes: &["mod_item"],
    opaque: &[
        "function_item",
        "function_signature_item",
        "closure_expression",
        "macro_definition",
        "macro_invocation",
        "line_comment",
        "block_comment",
        "attribute_item",
        "inner_attribute_item",
        "string_literal",
        "raw_string_literal",
        "use_declaration",
        "field_declaration_list",
        "enum_variant_list",
    ],
    wrappers: &[],
    decorated: &[],
    exporting: &[],
    attributes: &["attribute_item"],
    comments: &["line_comment", "block_comment"],
    imports: &["use_declaration", "extern_crate_declaration"],
    sep: "::",
};

pub(super) fn def_names(
    node: Node,
    kind: &'static str,
    src: &[u8],
    f: &Fields,
    scope: &ScopeView,
) -> Vec<DefName> {
    let (kind, name) = if kind == "impl" {
        let Some(ty) = node.child_by_field_id(f.ty) else {
            return Vec::new();
        };
        ("impl", type_name(ty, src))
    } else {
        let Some(name) = node.child_by_field_id(f.name) else {
            return Vec::new();
        };
        let kind = if kind == "fn" && scope.members {
            "method"
        } else {
            kind
        };
        (kind, text(name, src).to_string())
    };
    vec![DefName {
        kind,
        name,
        qualified: None,
    }]
}

/// The base name of an impl's self type: `Widget` for `Widget<T>`, `&Widget`,
/// `crate::w::Widget`.
pub(super) fn type_name(node: Node, src: &[u8]) -> String {
    let field = |n: &str| node.child_by_field_name(n);
    match node.kind() {
        "generic_type" | "reference_type" | "pointer_type" => {
            field("type").map_or_else(|| squash(text(node, src)), |t| type_name(t, src))
        }
        "scoped_type_identifier" => {
            field("name").map_or_else(|| squash(text(node, src)), |n| text(n, src).to_string())
        }
        "dynamic_type" => {
            field("trait").map_or_else(|| squash(text(node, src)), |t| type_name(t, src))
        }
        _ => squash(text(node, src)),
    }
}

pub(super) fn is_exported(
    node: Node,
    src: &[u8],
    member_exported: Option<bool>,
    attrs: &[String],
) -> bool {
    let has_pub = named_children(node)
        .first()
        .is_some_and(|c| c.kind() == "visibility_modifier" && text(*c, src).starts_with("pub"));
    has_pub
        || member_exported == Some(true)
        || (node.kind() == "macro_definition" && attrs.iter().any(|a| a.contains("macro_export")))
}

/// `#[test]`, `#[tokio::test]`, `#[test_case(..)]`-free: the attribute path
/// is `test` or ends in `::test`, or it is `#[cfg(test)]`.
pub(super) fn attr_is_test(attr: &str) -> bool {
    let inner = squash(attr);
    let inner = inner.trim_start_matches("#[").trim_end_matches(']');
    let path = inner.split('(').next().unwrap_or("");
    path == "test" || path.ends_with("::test") || inner == "cfg(test)"
}

pub(super) fn imports(node: Node, src: &[u8], f: &Fields, out: &mut Vec<ImportRec>) {
    match node.kind() {
        "use_declaration" => {
            if let Some(arg) = node.child_by_field_id(f.argument) {
                flatten_use(arg, "", src, f, node, out);
            }
        }
        "extern_crate_declaration" => {
            if let Some(name) = node.child_by_field_id(f.name) {
                let name = text(name, src);
                let local = node
                    .child_by_field_id(f.alias)
                    .map_or(name, |a| text(a, src));
                push_import(out, local, name, node);
            }
        }
        _ => {}
    }
}

fn last_segment(path: &str) -> &str {
    path.rsplit("::").next().unwrap_or(path)
}

/// One row per binding a use tree introduces: `use a::{b::c, d as e, self}`
/// → `(c, a::b::c)`, `(e, a::d)`, `(a, a)`.
fn flatten_use(
    node: Node,
    prefix: &str,
    src: &[u8],
    f: &Fields,
    decl: Node,
    out: &mut Vec<ImportRec>,
) {
    match node.kind() {
        "identifier" | "crate" | "super" | "metavariable" => {
            let t = text(node, src);
            push_import(out, t, &join_qn(prefix, "::", t), decl);
        }
        "self" => {
            if !prefix.is_empty() {
                push_import(out, last_segment(prefix), prefix, decl);
            }
        }
        "scoped_identifier" => {
            let path = join_qn(prefix, "::", &squash(text(node, src)));
            let local = node.child_by_field_id(f.name).map_or_else(
                || last_segment(&path).to_string(),
                |n| text(n, src).to_string(),
            );
            push_import(out, &local, &path, decl);
        }
        "use_as_clause" => {
            let (Some(path), Some(alias)) = (
                node.child_by_field_id(f.path),
                node.child_by_field_id(f.alias),
            ) else {
                return;
            };
            let path = join_qn(prefix, "::", &squash(text(path, src)));
            push_import(out, text(alias, src), &path, decl);
        }
        "use_wildcard" => {
            let t = squash(text(node, src));
            let base = t.strip_suffix("::*").unwrap_or("");
            let path = if base.is_empty() {
                prefix.to_string()
            } else {
                join_qn(prefix, "::", base)
            };
            push_import(out, "*", &path, decl);
        }
        "scoped_use_list" => {
            let path = node.child_by_field_id(f.path).map_or_else(
                || prefix.to_string(),
                |p| join_qn(prefix, "::", &squash(text(p, src))),
            );
            for list in field_children(node, f.list) {
                for child in named_children(list) {
                    flatten_use(child, &path, src, f, decl, out);
                }
            }
        }
        "use_list" => {
            for child in named_children(node) {
                flatten_use(child, prefix, src, f, decl, out);
            }
        }
        _ => {}
    }
}
