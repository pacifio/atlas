//! Python: functions, classes, methods; decorators widen the range; the
//! docstring is the doc.

use tree_sitter::Node;

use super::{
    field_children, named_children, push_import, squash, text, DefName, Fields, LangSpec, ScopeView,
};
use crate::extract::ImportRec;

pub(super) const SPEC: LangSpec = LangSpec {
    defs: &[("function_definition", "fn"), ("class_definition", "class")],
    type_scopes: &["class_definition"],
    module_scopes: &[],
    opaque: &["function_definition", "lambda", "comment", "string"],
    wrappers: &[],
    decorated: &["decorated_definition"],
    exporting: &[],
    attributes: &["decorator"],
    comments: &["comment"],
    imports: &["import_statement", "import_from_statement"],
    sep: ".",
};

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
    let kind = if kind == "fn" && scope.members {
        "method"
    } else {
        kind
    };
    vec![DefName {
        kind,
        name: text(name, src).to_string(),
        qualified: None,
    }]
}

/// The first statement of the body, when it is a string literal.
pub(super) fn docstring(node: Node, src: &[u8], f: &Fields) -> Option<String> {
    let body = node.child_by_field_id(f.body)?;
    let first = named_children(body).into_iter().next()?;
    if first.kind() != "expression_statement" {
        return None;
    }
    let string = named_children(first).into_iter().next()?;
    if string.kind() != "string" {
        return None;
    }
    let raw = text(string, src);
    let raw = raw.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    let inner = raw
        .trim_start_matches("\"\"\"")
        .trim_start_matches("'''")
        .trim_end_matches("\"\"\"")
        .trim_end_matches("'''")
        .trim_matches(|c| c == '"' || c == '\'');
    let doc = inner.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    Some(doc.trim().to_string())
}

pub(super) fn imports(node: Node, src: &[u8], f: &Fields, out: &mut Vec<ImportRec>) {
    match node.kind() {
        // `import a.b` binds `a`; `import a.b as c` binds `c`.
        "import_statement" => {
            for name in field_children(node, f.name) {
                match name.kind() {
                    "dotted_name" => {
                        let module = squash(text(name, src));
                        let local = module.split('.').next().unwrap_or("").to_string();
                        push_import(out, &local, &module, node);
                    }
                    "aliased_import" => alias(name, src, f, None, node, out),
                    _ => {}
                }
            }
        }
        // `from x.y import z as w` binds `w` from module `x.y`.
        "import_from_statement" => {
            let Some(module) = node.child_by_field_id(f.module_name) else {
                return;
            };
            let module = squash(text(module, src));
            if named_children(node)
                .iter()
                .any(|c| c.kind() == "wildcard_import")
            {
                push_import(out, "*", &module, node);
            }
            for name in field_children(node, f.name) {
                match name.kind() {
                    "dotted_name" => push_import(out, &squash(text(name, src)), &module, node),
                    "aliased_import" => alias(name, src, f, Some(&module), node, out),
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn alias(
    node: Node,
    src: &[u8],
    f: &Fields,
    from: Option<&str>,
    decl: Node,
    out: &mut Vec<ImportRec>,
) {
    let (Some(name), Some(alias)) = (
        node.child_by_field_id(f.name),
        node.child_by_field_id(f.alias),
    ) else {
        return;
    };
    let module = from.map_or_else(|| squash(text(name, src)), str::to_string);
    push_import(out, text(alias, src), &module, decl);
}
