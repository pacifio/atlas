//! The document `org_page_write` draws: nodes and the edges between them,
//! read out of the model's arguments and checked before anything crosses to
//! the window.
//!
//! The page's codec lives in the frontend (the Space relay never looks inside
//! a page), so this is not the page's shape — it is the model's, and it is
//! held to what the page's shape can carry (`packages/contracts/src/space.ts`:
//! `SpaceNodeKind`, `SpaceShapeType`, `SpaceAnchor`; edges name their ends by
//! node id). Media nodes are left out: a media node names stored bytes, and
//! the model has none to name. A group's children are a layout instruction
//! only — the contract has no grouping linkage, so a group is drawn as a
//! frame sized around them.
//!
//! Every refusal names the node or edge at fault and what to do instead, and
//! is decided here rather than by the window, so a document the window could
//! not draw costs no round trip and leaves the page untouched.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde::Serialize;
use serde_json::Value;

/// The node kinds the model may draw (the contract's `SpaceNodeKind` without
/// `media`).
pub(super) const NODE_KINDS: &[&str] = &["note", "text", "shape", "group"];

/// The contract's `SpaceShapeType`.
pub(super) const SHAPES: &[&str] = &["rectangle", "ellipse", "diamond", "triangle"];

/// The contract's `SpaceAnchor`: the four compass points an edge attaches at.
pub(super) const ANCHORS: &[&str] = &["n", "e", "s", "w"];

/// The shape of `org_page_write`'s `document`, as its schema says it: two
/// arrays, each item's fields in one line, derived from [`NODE_KINDS`],
/// [`SHAPES`] and [`ANCHORS`] so the schema offers exactly what [`diagram`]
/// accepts. One line rather than nested objects — every native turn carries
/// it — and the checking stays here.
pub(super) static DOCUMENT_SHAPE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{{nodes:[{{id,kind:{},text?,shape?:{},parent?,x?,y?,w?,h?}}],edges:[{{from,to,label?,from_anchor?,to_anchor?:{}}}]}}",
        NODE_KINDS.join("|"),
        SHAPES.join("|"),
        ANCHORS.join("|")
    )
});

/// The most nodes one document may hold. A page's whole replacement goes out
/// as one CRDT update, and the Space bounds an update at 128 KiB; two hundred
/// nodes with their text stays well inside it, and is more than a readable
/// diagram holds.
pub(super) const NODES_MAX: usize = 200;

/// The most edges one document may hold.
pub(super) const EDGES_MAX: usize = 400;

/// The longest a node's text may be, in characters.
pub(super) const TEXT_MAX: usize = 2_000;

/// The longest an edge's label may be, in characters.
pub(super) const LABEL_MAX: usize = 200;

/// The longest a node id may be. Ids are the model's names for its nodes;
/// the window gives each node a fresh page id of its own.
pub(super) const ID_MAX: usize = 64;

/// How far from the origin a node may be placed, either way.
pub(super) const COORD_MAX: f64 = 100_000.0;

/// The smallest and largest a node may be drawn: the canvas's own resize
/// floor, and a bound no diagram needs.
pub(super) const SIZE_MIN: f64 = 40.0;
pub(super) const SIZE_MAX: f64 = 10_000.0;

/// One node, as the window receives it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct DiagramNode {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
}

/// One edge, as the window receives it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct DiagramEdge {
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A document that can be drawn: every id unique, every edge's ends and every
/// parent present, every parent a group, no group inside itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct Diagram {
    pub nodes: Vec<DiagramNode>,
    pub edges: Vec<DiagramEdge>,
}

/// A node as a refusal names it: by its id when it has one, else by place.
fn node_name(index: usize, id: Option<&str>) -> String {
    match id {
        Some(id) => format!("node `{id}`"),
        None => format!("node {}", index + 1),
    }
}

/// An optional string field, blank read as absent.
fn text_field<'a>(object: &'a serde_json::Map<String, Value>, key: &str, what: &str) -> Result<Option<&'a str>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(format!("{what}: `{key}` must be a string")),
    }
}

/// An optional number field.
fn number_field(object: &serde_json::Map<String, Value>, key: &str, what: &str) -> Result<Option<f64>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_f64() {
            Some(n) if n.is_finite() => Ok(Some(n)),
            _ => Err(format!("{what}: `{key}` must be a number")),
        },
    }
}

/// One of a closed set, lower-cased; a refusal lists the set.
fn one_of(value: &str, allowed: &[&str], what: &str, key: &str) -> Result<String, String> {
    let lowered = value.trim().to_ascii_lowercase();
    if allowed.contains(&lowered.as_str()) {
        Ok(lowered)
    } else {
        Err(format!("{what}: `{key}` \"{value}\" is not one of {}", allowed.join(", ")))
    }
}

fn read_node(index: usize, value: &Value) -> Result<DiagramNode, String> {
    let Value::Object(object) = value else {
        return Err(format!("{} must be an object with an `id` and a `kind`", node_name(index, None)));
    };
    let id = match object.get("id") {
        Some(Value::String(id)) if !id.trim().is_empty() => id.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return Err(format!("{} has no `id`; give every node a short unique id", node_name(index, None))),
    };
    let what = node_name(index, Some(&id));
    if id.chars().count() > ID_MAX {
        return Err(format!("{what}: an id is at most {ID_MAX} characters"));
    }
    let kind = match text_field(object, "kind", &what)? {
        Some(kind) if kind.trim().eq_ignore_ascii_case("media") => {
            return Err(format!("{what}: media nodes cannot be drawn; use a note, text, shape or group"))
        }
        Some(kind) => one_of(kind, NODE_KINDS, &what, "kind")?,
        None => return Err(format!("{what} has no `kind`; use one of {}", NODE_KINDS.join(", "))),
    };
    let shape = match text_field(object, "shape", &what)? {
        Some(_) if kind != "shape" => {
            return Err(format!("{what}: `shape` is only for kind shape; drop it or make the node a shape"))
        }
        Some(shape) => Some(one_of(shape, SHAPES, &what, "shape")?),
        None if kind == "shape" => Some("rectangle".to_string()),
        None => None,
    };
    let text = text_field(object, "text", &what)?.map(str::to_string);
    if let Some(text) = &text {
        let length = text.chars().count();
        if length > TEXT_MAX {
            return Err(format!("{what}: `text` is at most {TEXT_MAX} characters, and is {length}; shorten it"));
        }
    }
    let parent = text_field(object, "parent", &what)?.map(|p| p.trim().to_string());
    let (x, y) = (number_field(object, "x", &what)?, number_field(object, "y", &what)?);
    if x.is_some() != y.is_some() {
        return Err(format!("{what}: give both `x` and `y`, or neither to have it laid out"));
    }
    for (key, value) in [("x", x), ("y", y)] {
        if value.is_some_and(|v| v.abs() > COORD_MAX) {
            return Err(format!("{what}: `{key}` is at most {COORD_MAX} either side of 0"));
        }
    }
    let (w, h) = (number_field(object, "w", &what)?, number_field(object, "h", &what)?);
    for (key, value) in [("w", w), ("h", h)] {
        if value.is_some_and(|v| !(SIZE_MIN..=SIZE_MAX).contains(&v)) {
            return Err(format!("{what}: `{key}` is between {SIZE_MIN} and {SIZE_MAX}"));
        }
    }
    Ok(DiagramNode { id, kind, text, shape, parent, x, y, w, h })
}

fn read_edge(index: usize, value: &Value, ids: &HashSet<&str>) -> Result<DiagramEdge, String> {
    let what = format!("edge {}", index + 1);
    let Value::Object(object) = value else {
        return Err(format!("{what} must be an object with `from` and `to`"));
    };
    let end = |key: &str| -> Result<String, String> {
        let id = match object.get(key) {
            Some(Value::String(id)) if !id.trim().is_empty() => id.trim().to_string(),
            Some(Value::Number(n)) => n.to_string(),
            _ => return Err(format!("{what} has no `{key}`; name the node by its id")),
        };
        if !ids.contains(id.as_str()) {
            return Err(format!("{what}: `{key}` names node `{id}`, which the document does not have"));
        }
        Ok(id)
    };
    let (from, to) = (end("from")?, end("to")?);
    let what = format!("edge {} ({from} → {to})", index + 1);
    if from == to {
        return Err(format!("{what} joins a node to itself; an edge joins two different nodes"));
    }
    let anchor = |key: &str| -> Result<Option<String>, String> {
        text_field(object, key, &what)?.map(|a| one_of(a, ANCHORS, &what, key)).transpose()
    };
    let (from_anchor, to_anchor) = (anchor("from_anchor")?, anchor("to_anchor")?);
    let label = text_field(object, "label", &what)?.map(str::to_string);
    if let Some(label) = &label {
        let length = label.chars().count();
        if length > LABEL_MAX {
            return Err(format!("{what}: `label` is at most {LABEL_MAX} characters, and is {length}"));
        }
    }
    Ok(DiagramEdge { from, to, from_anchor, to_anchor, label })
}

/// Read and check the `document` argument. `Err` is the refusal the model
/// reads.
pub(super) fn diagram(document: Option<&Value>) -> Result<Diagram, String> {
    let Some(Value::Object(document)) = document else {
        return Err("give the `document` to draw: { nodes: [...], edges: [...] }".to_string());
    };
    let nodes = match document.get("nodes") {
        Some(Value::Array(nodes)) if !nodes.is_empty() => nodes,
        Some(Value::Array(_)) | None | Some(Value::Null) => {
            return Err("the document has no nodes; a write replaces the page, so give at least one node".to_string())
        }
        Some(_) => return Err("the document's `nodes` must be a list".to_string()),
    };
    let edges: &[Value] = match document.get("edges") {
        Some(Value::Array(edges)) => edges,
        None | Some(Value::Null) => &[],
        Some(_) => return Err("the document's `edges` must be a list".to_string()),
    };
    if nodes.len() > NODES_MAX {
        return Err(format!("the document has {} nodes; at most {NODES_MAX} fit on a page in one write", nodes.len()));
    }
    if edges.len() > EDGES_MAX {
        return Err(format!("the document has {} edges; at most {EDGES_MAX} fit on a page in one write", edges.len()));
    }

    let nodes = nodes.iter().enumerate().map(|(i, n)| read_node(i, n)).collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    for node in &nodes {
        if !seen.insert(node.id.as_str()) {
            return Err(format!("two nodes have the id `{}`; every node's id must be unique", node.id));
        }
    }
    let kinds: HashMap<&str, &str> = nodes.iter().map(|n| (n.id.as_str(), n.kind.as_str())).collect();
    let parents: HashMap<&str, &str> =
        nodes.iter().filter_map(|n| n.parent.as_deref().map(|p| (n.id.as_str(), p))).collect();
    for node in &nodes {
        let Some(parent) = node.parent.as_deref() else { continue };
        match kinds.get(parent) {
            None => return Err(format!("node `{}`: `parent` names `{parent}`, which the document does not have", node.id)),
            Some(&kind) if kind != "group" => {
                return Err(format!(
                    "node `{}`: `parent` names `{parent}`, a {kind}; only a group can hold other nodes",
                    node.id
                ))
            }
            Some(_) => {}
        }
        // A group inside itself, however deep, has no size to draw.
        let mut at = parent;
        for _ in 0..=nodes.len() {
            if at == node.id {
                return Err(format!("group `{}` is inside itself through its parents; break the loop", node.id));
            }
            match parents.get(at) {
                Some(next) => at = next,
                None => break,
            }
        }
    }

    let edges = edges.iter().enumerate().map(|(i, e)| read_edge(i, e, &seen)).collect::<Result<Vec<_>, _>>()?;
    Ok(Diagram { nodes, edges })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The schema's one-line shape is written from the same constants the
    /// check holds a document to, so every kind, shape and anchor it offers
    /// is one the check accepts, and nothing the check accepts is left out.
    #[test]
    fn the_schema_offers_exactly_the_kinds_shapes_and_anchors_the_check_accepts() {
        for (values, key) in [(NODE_KINDS, "kind"), (SHAPES, "shape"), (ANCHORS, "to_anchor")] {
            assert!(DOCUMENT_SHAPE.contains(&format!("{key}:{}", values.join("|")))
                || DOCUMENT_SHAPE.contains(&format!("{key}?:{}", values.join("|"))), "{key}: {}", *DOCUMENT_SHAPE);
        }
        for kind in NODE_KINDS {
            let node = if *kind == "shape" {
                json!({ "id": "a", "kind": kind, "shape": SHAPES[0] })
            } else {
                json!({ "id": "a", "kind": kind })
            };
            let document = json!({ "nodes": [node, { "id": "b", "kind": "note" }], "edges": [
                { "from": "a", "to": "b", "from_anchor": ANCHORS[0], "to_anchor": ANCHORS[3] }
            ] });
            assert!(diagram(Some(&document)).is_ok(), "{kind}");
        }
    }
}
