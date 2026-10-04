//! Go: funcs, methods named `Recv.Method`, type specs classified by their
//! underlying type, and every name in a `const`/`var` spec.

use tree_sitter::Node;

use super::{
    field_children, named_children, push_import, squash, text, unquote, DefName, Fields, LangSpec,
    ScopeView,
};
use crate::extract::ImportRec;

pub(super) const SPEC: LangSpec = LangSpec {
    defs: &[
        ("function_declaration", "fn"),
        ("method_declaration", "method"),
        ("type_spec", "type"),
        ("type_alias", "type"),
        ("const_spec", "const"),
        ("var_spec", "var"),
    ],
    type_scopes: &[],
    module_scopes: &[],
    opaque: &[
        "function_declaration",
        "method_declaration",
        "type_spec",
        "type_alias",
        "const_spec",
        "var_spec",
        "func_literal",
        "comment",
        "interpreted_string_literal",
        "raw_string_literal",
        "import_declaration",
    ],
    wrappers: &[
        "type_declaration",
        "const_declaration",
        "var_declaration",
        "var_spec_list",
    ],
    decorated: &[],
    exporting: &[],
    attributes: &[],
    comments: &["comment"],
    imports: &["import_declaration"],
    sep: ".",
};

pub(super) fn def_names(
    node: Node,
    kind: &'static str,
    src: &[u8],
    f: &Fields,
    _scope: &ScopeView,
) -> Vec<DefName> {
    let names = field_children(node, f.name);
    match node.kind() {
        "const_spec" | "var_spec" => names
            .into_iter()
            .map(|n| DefName {
                kind,
                name: text(n, src).to_string(),
                qualified: None,
            })
            .collect(),
        "method_declaration" => {
            let Some(name) = names.first() else {
                return Vec::new();
            };
            let name = text(*name, src).to_string();
            let qualified = node
                .child_by_field_id(f.receiver)
                .and_then(|r| receiver_type(r, src, f))
                .map(|recv| format!("{recv}.{name}"));
            vec![DefName {
                kind,
                name,
                qualified,
            }]
        }
        "type_spec" => {
            let Some(name) = names.first() else {
                return Vec::new();
            };
            let kind = match node.child_by_field_id(f.ty).map(|t| t.kind()) {
                Some("struct_type") => "struct",
                Some("interface_type") => "interface",
                _ => "type",
            };
            vec![DefName {
                kind,
                name: text(*name, src).to_string(),
                qualified: None,
            }]
        }
        _ => names
            .first()
            .map(|n| DefName {
                kind,
                name: text(*n, src).to_string(),
                qualified: None,
            })
            .into_iter()
            .collect(),
    }
}

/// `(w *Widget[T])` → `Widget`.
fn receiver_type(params: Node, src: &[u8], f: &Fields) -> Option<String> {
    let param = named_children(params).into_iter().next()?;
    let mut ty = param.child_by_field_id(f.ty)?;
    loop {
        ty = match ty.kind() {
            "pointer_type" | "parenthesized_type" => named_children(ty).into_iter().next()?,
            "generic_type" => ty.child_by_field_id(f.ty)?,
            _ => break,
        };
    }
    Some(squash(text(ty, src)))
}

pub(super) fn signature_prefix(node: Node) -> &'static str {
    match node.kind() {
        "type_spec" | "type_alias" => "type ",
        "const_spec" => "const ",
        "var_spec" => "var ",
        _ => "",
    }
}

pub(super) fn imports(node: Node, src: &[u8], f: &Fields, out: &mut Vec<ImportRec>) {
    for child in named_children(node) {
        match child.kind() {
            "import_spec" => spec(child, src, f, out),
            "import_spec_list" => {
                for s in named_children(child) {
                    if s.kind() == "import_spec" {
                        spec(s, src, f, out);
                    }
                }
            }
            _ => {}
        }
    }
}

/// `f "fmt"` → `(f, fmt)`; `"net/http"` → `(http, net/http)`.
fn spec(node: Node, src: &[u8], f: &Fields, out: &mut Vec<ImportRec>) {
    let Some(path) = node.child_by_field_id(f.path) else {
        return;
    };
    let path = unquote(text(path, src));
    let local = match node.child_by_field_id(f.name) {
        Some(n) => text(n, src).to_string(),
        None => path.rsplit('/').next().unwrap_or(&path).to_string(),
    };
    push_import(out, &local, &path, node);
}
