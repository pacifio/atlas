//! Phase 3 extraction: references, imports and Rust `mod name;` declarations,
//! read in ONE extra cursor walk over the tree Phase 2 already parsed (no re-parse).
//!
//! Encodings every later pass relies on (`resolve.rs` decodes them):
//! - `RawRef.name` is the leaf identifier; `line`/`start_byte`/`end_byte` point at it.
//! - `RawRef.receiver` for call/type/value refs:
//!   - `""`        bare name: `foo()`
//!   - `"a::B::"`  path- or type-qualified (trailing `::`). `Self::x()`, `self.x()`, `this.x()`,
//!     Python `self.x()`, a Go method receiver `r.x()` and a local whose type we saw
//!     (`let v = Foo::new(); v.x()`) are all rewritten to `"<Type>::"`.
//!   - `"x.y"`     value receiver: a member call on an expression we could not type.
//!   - `"~<chain>~<fallback>"` (Rust) a receiver whose type depends on other files: a local
//!     bound from a call, a field, a method chain or a generic type such as `Arc<Store>`.
//!     `<chain>` is `|`-joined steps the resolver evaluates (`resolve::Resolver::chain_type`):
//!     `T<type text>`, `F<qualifier>#<fn>` (a call's result), `.<method>` (a method call's
//!     result), `:<field>`, `?`, `^` (`.await`) and `#<n>` (tuple element). `<fallback>` is the
//!     receiver as it would otherwise read, used when the chain cannot be typed.
//! - field refs (Rust): one per struct field, `name` = the field (`0`, `1`, … for a tuple
//!   struct), `receiver` = its type text; never an edge, read by receiver typing.
//! - inherit/impl refs: `receiver = "<src type>\t<qualifier>"`, qualifier encoded as above.
//! - Imports: see [`RawImport`].

use std::collections::HashSet;

use tree_sitter::Node;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RefKind {
    Call,
    Type,
    Inherit,
    Impl,
    Value,
    Field,
}

impl RefKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Call => "call",
            Self::Type => "type",
            Self::Inherit => "inherit",
            Self::Impl => "impl",
            Self::Value => "value",
            Self::Field => "field",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "call" => Some(Self::Call),
            "type" => Some(Self::Type),
            "inherit" => Some(Self::Inherit),
            "impl" => Some(Self::Impl),
            "value" => Some(Self::Value),
            "field" => Some(Self::Field),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRef {
    pub kind: RefKind,
    pub name: String,
    pub receiver: String,
    /// 1-based line of the name.
    pub line: u32,
    pub start_byte: u32,
    pub end_byte: u32,
}

/// One import binding.
/// - rust: `module_path` is the full `::` path as written incl. the leaf (`crate::a::B`);
///   a glob has `local_name == "*"` and `module_path` = the globbed path. Leading `super`/`self`
///   inside inline `mod x { .. }` blocks are rewritten relative to the FILE module.
/// - ts/js: `module_path` = specifier; `imported_name` = `"default"` | exported name | `"*"`;
///   a side-effect import has `local_name == ""`.
/// - python: `module_path` as written (`a.b`, `..pkg`, `.`); `imported_name` = the name after
///   `import` in a from-import, else `"*"`; `import a.b` binds `local_name == "a.b"`.
/// - go: `module_path` = import path; `local_name` = alias or derived package name; dot-import = `"*"`.
///
/// `is_pub`: Rust `pub use` (any visibility), TS `export … from`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawImport {
    pub local_name: String,
    pub module_path: String,
    pub imported_name: String,
    pub line: u32,
    pub is_pub: bool,
}

/// A Rust `mod name;` declaration (a module that lives in another file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawMod {
    pub name: String,
    /// `#[path = "…"]` value, verbatim.
    pub path_attr: Option<String>,
    /// Enclosing inline modules, `::`-joined (`""` at file level).
    pub inline_parent: String,
    pub line: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphExtract {
    pub refs: Vec<RawRef>,
    pub imports: Vec<RawImport>,
    pub mods: Vec<RawMod>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GLang {
    Rust,
    Ts,
    Py,
    Go,
}

impl GLang {
    /// `files.lang` label → walker language. Unknown labels carry no graph data.
    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            "rust" => Some(Self::Rust),
            "typescript" | "tsx" | "javascript" | "jsx" => Some(Self::Ts),
            "python" => Some(Self::Py),
            "go" => Some(Self::Go),
            _ => None,
        }
    }
}

/// Extract refs, imports and mod declarations. `root` is the tree's root node.
pub fn extract_graph(lang_label: &str, root: Node, src: &[u8]) -> GraphExtract {
    let Some(lang) = GLang::from_label(lang_label) else {
        return GraphExtract::default();
    };
    let mut w = Walker::new(lang, src);
    walk(root, &mut w);
    let mut refs = w.refs;
    // Emission is pre-order on the triggering node, so `a.b().c()` yields `c` before `b`.
    refs.sort_by(|a, b| (a.start_byte, a.kind, &a.name).cmp(&(b.start_byte, b.kind, &b.name)));
    refs.dedup_by(|a, b| a.start_byte == b.start_byte && a.kind == b.kind && a.name == b.name);
    GraphExtract {
        refs,
        imports: w.imports,
        mods: w.mods,
    }
}

trait Visitor {
    /// Return `false` to skip the node's children.
    fn enter(&mut self, n: Node) -> bool;
    fn leave(&mut self, n: Node);
}

/// Iterative pre/post-order walk: deep expression trees must not overflow the stack.
fn walk(root: Node, v: &mut impl Visitor) {
    let mut cursor = root.walk();
    loop {
        let node = cursor.node();
        if v.enter(node) && cursor.goto_first_child() {
            continue;
        }
        loop {
            v.leave(cursor.node());
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

const RUST_SKIP_CALLS: &[&str] = &["Some", "Ok", "Err", "drop"];
const TS_SKIP_CALLS: &[&str] = &[
    "require",
    "parseInt",
    "parseFloat",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
];
const PY_SKIP_CALLS: &[&str] = &[
    "print",
    "len",
    "range",
    "isinstance",
    "issubclass",
    "str",
    "int",
    "float",
    "bool",
    "bytes",
    "list",
    "dict",
    "set",
    "tuple",
    "super",
    "getattr",
    "setattr",
    "hasattr",
    "enumerate",
    "zip",
    "sorted",
    "min",
    "max",
    "sum",
    "any",
    "all",
    "open",
    "repr",
    "type",
    "iter",
    "next",
    "map",
    "filter",
    "id",
    "hash",
    "format",
    "vars",
    "callable",
    "abs",
    "round",
];
const GO_SKIP_CALLS: &[&str] = &[
    "len", "cap", "make", "new", "append", "copy", "delete", "panic", "recover", "print",
    "println", "close", "min", "max", "clear",
];
const RUST_SKIP_TYPES: &[&str] = &[
    "Self",
    "Option",
    "Vec",
    "String",
    "Box",
    "Arc",
    "Rc",
    "RefCell",
    "Cell",
    "HashMap",
    "HashSet",
    "BTreeMap",
    "BTreeSet",
    "VecDeque",
    "Cow",
    "PhantomData",
];
const TS_SKIP_TYPES: &[&str] = &[
    "Array",
    "Promise",
    "Record",
    "Partial",
    "Readonly",
    "ReadonlyArray",
    "Map",
    "Set",
    "Date",
    "Error",
    "Function",
    "Object",
    "Pick",
    "Omit",
    "Required",
    "ReturnType",
    "Parameters",
];
const PY_SKIP_TYPES: &[&str] = &[
    "int", "str", "float", "bool", "bytes", "list", "dict", "set", "tuple", "object", "None",
    "Any", "Optional", "List", "Dict", "Set", "Tuple", "Union", "Callable", "Iterable", "Iterator",
    "Sequence", "Mapping", "type",
];
const GO_SKIP_TYPES: &[&str] = &[
    "int",
    "int8",
    "int16",
    "int32",
    "int64",
    "uint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uintptr",
    "float32",
    "float64",
    "complex64",
    "complex128",
    "string",
    "bool",
    "byte",
    "rune",
    "error",
    "any",
    "comparable",
];
/// Node kinds whose `name` field DECLARES a type (that type_identifier is not a reference).
const DECL_KINDS: &[&str] = &[
    "struct_item",
    "enum_item",
    "union_item",
    "trait_item",
    "type_item",
    "associated_type",
    "class_declaration",
    "abstract_class_declaration",
    "class",
    "interface_declaration",
    "type_alias_declaration",
    "type_parameter",
    "type_spec",
    "type_alias",
];
const MAX_RECEIVER_BYTES: usize = 128;
/// Longest typed chain kept (`~…~…` receivers, field types); longer ones are not typed.
const MAX_CHAIN_BYTES: usize = 240;
/// Most steps in one typed chain.
const MAX_CHAIN_STEPS: usize = 8;

struct Frame {
    node_id: usize,
    /// impl/class/trait/Go-receiver type: what `self`/`this`/`Self` mean here.
    owner: Option<String>,
    /// Go method receiver variable (`r` in `func (r *Repo)`).
    self_var: Option<String>,
    /// Function scope: bound names with their type (`""` = unknown).
    locals: Option<Vec<(String, String)>>,
    /// Rust inline `mod x { }`.
    inline_mod: Option<String>,
}

struct Walker<'a> {
    lang: GLang,
    src: &'a [u8],
    refs: Vec<RawRef>,
    imports: Vec<RawImport>,
    mods: Vec<RawMod>,
    frames: Vec<Frame>,
    /// Name nodes already emitted by a compound node (`a::B` emits `B`; don't emit it twice).
    consumed: HashSet<usize>,
}

impl<'a> Visitor for Walker<'a> {
    fn enter(&mut self, n: Node) -> bool {
        match self.lang {
            GLang::Rust => self.enter_rust(n),
            GLang::Ts => self.enter_ts(n),
            GLang::Py => self.enter_py(n),
            GLang::Go => self.enter_go(n),
        }
    }

    fn leave(&mut self, n: Node) {
        while self.frames.last().is_some_and(|f| f.node_id == n.id()) {
            self.frames.pop();
        }
    }
}

impl<'a> Walker<'a> {
    fn new(lang: GLang, src: &'a [u8]) -> Self {
        Walker {
            lang,
            src,
            refs: Vec::new(),
            imports: Vec::new(),
            mods: Vec::new(),
            frames: Vec::new(),
            consumed: HashSet::new(),
        }
    }

    fn text(&self, n: Node) -> &'a str {
        n.utf8_text(self.src).unwrap_or("")
    }

    fn owner(&self) -> Option<&str> {
        self.frames.iter().rev().find_map(|f| f.owner.as_deref())
    }

    fn self_var(&self) -> Option<&str> {
        self.frames.iter().rev().find_map(|f| f.self_var.as_deref())
    }

    /// `Some("")` = a bound local of unknown type; `None` = not a local.
    fn local_type(&self, name: &str) -> Option<&str> {
        for f in self.frames.iter().rev() {
            if let Some(locals) = &f.locals {
                if let Some((_, ty)) = locals.iter().rev().find(|(n, _)| n == name) {
                    return Some(ty.as_str());
                }
            }
        }
        None
    }

    fn bind(&mut self, name: &str, ty: &str) {
        if name.is_empty() || name == "_" {
            return;
        }
        if let Some(locals) = self.frames.iter_mut().rev().find_map(|f| f.locals.as_mut()) {
            locals.push((name.to_string(), ty.to_string()));
        }
    }

    fn push(&mut self, n: Node, owner: Option<String>, self_var: Option<String>, scope: bool) {
        self.frames.push(Frame {
            node_id: n.id(),
            owner,
            self_var,
            locals: scope.then(Vec::new),
            inline_mod: None,
        });
    }

    fn inline_mods(&self) -> Vec<String> {
        self.frames
            .iter()
            .filter_map(|f| f.inline_mod.clone())
            .collect()
    }

    fn emit(&mut self, kind: RefKind, name_node: Node, name: &str, receiver: String) {
        if name.is_empty() {
            return;
        }
        self.refs.push(RawRef {
            kind,
            name: name.to_string(),
            receiver,
            line: name_node.start_position().row as u32 + 1,
            start_byte: name_node.start_byte() as u32,
            end_byte: name_node.end_byte() as u32,
        });
    }

    fn import(&mut self, local: &str, module: &str, imported: &str, n: Node, is_pub: bool) {
        self.imports.push(RawImport {
            local_name: local.to_string(),
            module_path: module.to_string(),
            imported_name: imported.to_string(),
            line: n.start_position().row as u32 + 1,
            is_pub,
        });
    }

    /// Receiver text for a member access on `recv`, typed when we can.
    fn qualify_value(&self, recv: Node) -> String {
        let t = self.text(recv);
        let is_self = match self.lang {
            GLang::Rust => t == "self",
            GLang::Ts => t == "this",
            GLang::Py => t == "self" || t == "cls",
            GLang::Go => self.self_var() == Some(t),
        };
        if is_self {
            if let Some(o) = self.owner() {
                return format!("{o}::");
            }
        }
        if recv.kind() == "identifier" {
            if let Some(ty) = self.local_type(t) {
                if ty.starts_with('~') {
                    return format!("{ty}~{}", compact(t));
                }
                if !ty.is_empty() {
                    return format!("{ty}::");
                }
            }
        }
        if self.lang == GLang::Rust && recv.kind() != "identifier" {
            if let Some(chain) = self.rust_chain(recv, 0) {
                return format!("~{}~{}", chain.join("|"), compact(t));
            }
        }
        compact(t)
    }

    /// `a::b` / `Self` / `crate::x` → `"a::b::"`, with `Self` rewritten to the impl type.
    fn qualify_path(&self, path: &str) -> String {
        let path = strip_generics(path);
        let mut out = String::new();
        for seg in path.split("::").map(str::trim).filter(|s| !s.is_empty()) {
            let seg = if seg == "Self" {
                self.owner().unwrap_or("Self")
            } else {
                seg
            };
            out.push_str(seg);
            out.push_str("::");
        }
        out
    }

    fn type_ref(&mut self, n: Node, skip: &[&str]) {
        if self.consumed.contains(&n.id()) {
            return;
        }
        let t = self.text(n);
        if t.chars().count() <= 1 || skip.contains(&t) || is_decl_name(n) {
            return;
        }
        self.emit(RefKind::Type, n, t, String::new());
    }

    fn value_args(&mut self, args: Node) {
        let mut c = args.walk();
        let kids: Vec<Node> = args.named_children(&mut c).collect();
        for k in kids {
            match k.kind() {
                "identifier" => {
                    let t = self.text(k);
                    if self.local_type(t).is_none() && t != "self" {
                        self.emit(RefKind::Value, k, t, String::new());
                    }
                }
                "scoped_identifier" if self.lang == GLang::Rust => {
                    if let Some(nm) = k.child_by_field_name("name") {
                        let q = k
                            .child_by_field_name("path")
                            .map(|p| self.qualify_path(self.text(p)))
                            .unwrap_or_default();
                        let name = self.text(nm);
                        self.emit(RefKind::Value, nm, name, q);
                    }
                }
                _ => {}
            }
        }
    }

    fn bind_pattern(&mut self, pattern: Node, ty: &str) {
        // `let (a, b) = f()` with a typed chain: each element is `…|#i`;
        // `let Some(x) = f() else` / `let Ok(x) = …`: `x` is the chain peeled with `?`.
        if let Some(chain) = ty.strip_prefix('~') {
            match pattern.kind() {
                "tuple_pattern" => {
                    let mut c = pattern.walk();
                    let kids: Vec<Node> = pattern.named_children(&mut c).collect();
                    for (i, k) in kids.into_iter().enumerate() {
                        if let Some(id) = plain_binding(k) {
                            let name = self.text(id);
                            self.bind(name, &format!("~{chain}|#{i}"));
                        } else {
                            self.bind_pattern(k, "");
                        }
                    }
                    return;
                }
                "tuple_struct_pattern" => {
                    let ctor = pattern
                        .child_by_field_name("type")
                        .map(|t| self.text(t))
                        .unwrap_or("");
                    let mut c = pattern.walk();
                    let kids: Vec<Node> = pattern
                        .named_children(&mut c)
                        .filter(|k| {
                            Some(k.id()) != pattern.child_by_field_name("type").map(|t| t.id())
                        })
                        .collect();
                    if let (true, [k]) = (matches!(ctor, "Some" | "Ok"), kids.as_slice()) {
                        let Some(id) = plain_binding(*k) else {
                            return self.bind_pattern(*k, "");
                        };
                        let name = self.text(id);
                        self.bind(name, &format!("~{chain}|?"));
                        return;
                    }
                }
                _ => {}
            }
        }
        let mut ids = Vec::new();
        pattern_idents(pattern, &mut ids, 0);
        let single = ids.len() == 1;
        for id in ids {
            let name = self.text(id);
            self.bind(name, if single { ty } else { "" });
        }
    }

    // ── Rust ────────────────────────────────────────────────────────────────

    fn enter_rust(&mut self, n: Node) -> bool {
        match n.kind() {
            "use_declaration" => {
                let is_pub = has_child_kind(n, "visibility_modifier");
                if let Some(arg) = n.child_by_field_name("argument") {
                    self.rust_use_tree(arg, &[], is_pub, n);
                }
                false
            }
            "extern_crate_declaration" => {
                if let Some(name) = n.child_by_field_name("name") {
                    let module = self.text(name);
                    let local = n
                        .child_by_field_name("alias")
                        .map(|a| self.text(a))
                        .unwrap_or(module);
                    let is_pub = has_child_kind(n, "visibility_modifier");
                    self.import(local, module, module, n, is_pub);
                }
                false
            }
            "mod_item" => {
                let Some(name) = n.child_by_field_name("name").map(|x| self.text(x)) else {
                    return true;
                };
                if n.child_by_field_name("body").is_none() {
                    self.mods.push(RawMod {
                        name: name.to_string(),
                        path_attr: rust_path_attr(n, self.src),
                        inline_parent: self.inline_mods().join("::"),
                        line: n.start_position().row as u32 + 1,
                    });
                    return false;
                }
                self.frames.push(Frame {
                    node_id: n.id(),
                    owner: None,
                    self_var: None,
                    locals: None,
                    inline_mod: Some(name.to_string()),
                });
                true
            }
            "impl_item" => {
                let ty_leaf = n.child_by_field_name("type").and_then(rust_type_leaf);
                let ty = ty_leaf.map(|l| self.text(l).to_string());
                if let Some(l) = ty_leaf {
                    self.consumed.insert(l.id());
                }
                if let (Some(tr), Some(ty)) = (n.child_by_field_name("trait"), ty.as_deref()) {
                    if let Some(leaf) = rust_type_leaf(tr) {
                        self.consumed.insert(leaf.id());
                        let qual = if tr.kind() == "scoped_type_identifier" {
                            tr.child_by_field_name("path")
                                .map(|p| self.qualify_path(self.text(p)))
                                .unwrap_or_default()
                        } else {
                            String::new()
                        };
                        let name = self.text(leaf);
                        self.emit(RefKind::Impl, leaf, name, format!("{ty}\t{qual}"));
                    }
                }
                self.push(n, ty, None, false);
                true
            }
            "trait_item" => {
                let name = n
                    .child_by_field_name("name")
                    .map(|x| self.text(x).to_string());
                self.push(n, name, None, false);
                true
            }
            "function_item" | "closure_expression" => {
                self.push(n, None, None, true);
                if let Some(params) = n.child_by_field_name("parameters") {
                    let mut c = params.walk();
                    let kids: Vec<Node> = params.named_children(&mut c).collect();
                    for p in kids {
                        match p.kind() {
                            "parameter" => {
                                let ty = p
                                    .child_by_field_name("type")
                                    .map(|t| self.rust_declared_type(t))
                                    .unwrap_or_default();
                                if let Some(pat) = p.child_by_field_name("pattern") {
                                    self.bind_pattern(pat, &ty);
                                }
                            }
                            "identifier" => {
                                let t = self.text(p);
                                self.bind(t, "");
                            }
                            _ => {}
                        }
                    }
                }
                true
            }
            "let_declaration" => {
                let ty = if let Some(t) = n.child_by_field_name("type") {
                    self.rust_declared_type(t)
                } else {
                    n.child_by_field_name("value")
                        .map(|v| {
                            let plain = self.rust_value_type(v);
                            if !plain.is_empty() {
                                return plain.to_string();
                            }
                            self.rust_chain(v, 0)
                                .map(|c| format!("~{}", c.join("|")))
                                .unwrap_or_default()
                        })
                        .unwrap_or_default()
                };
                if let Some(pat) = n.child_by_field_name("pattern") {
                    self.bind_pattern(pat, &ty);
                }
                true
            }
            "field_declaration" if in_struct(n) => {
                if let (Some(name), Some(ty)) =
                    (n.child_by_field_name("name"), n.child_by_field_name("type"))
                {
                    if let Some(t) = chain_text(self.text(ty)) {
                        let field = self.text(name);
                        self.emit(RefKind::Field, name, field, t);
                    }
                }
                true
            }
            "ordered_field_declaration_list"
                if n.parent().is_some_and(|p| p.kind() == "struct_item") =>
            {
                let mut c = n.walk();
                let types: Vec<Node> = n.children_by_field_name("type", &mut c).collect();
                for (i, ty) in types.into_iter().enumerate() {
                    if let Some(t) = chain_text(self.text(ty)) {
                        self.emit(RefKind::Field, ty, &i.to_string(), t);
                    }
                }
                true
            }
            "call_expression" => {
                if let Some(f) = n.child_by_field_name("function") {
                    self.rust_call(f);
                }
                true
            }
            "macro_invocation" => {
                self.rust_macro(n);
                true
            }
            "arguments" => {
                self.value_args(n);
                true
            }
            "type_identifier" => {
                self.type_ref(n, RUST_SKIP_TYPES);
                true
            }
            "scoped_type_identifier" => {
                if let Some(nm) = n.child_by_field_name("name") {
                    if !self.consumed.contains(&nm.id()) {
                        self.consumed.insert(nm.id());
                        let q = n
                            .child_by_field_name("path")
                            .map(|p| self.qualify_path(self.text(p)))
                            .unwrap_or_default();
                        let name = self.text(nm);
                        self.emit(RefKind::Type, nm, name, q);
                    }
                }
                true
            }
            _ => true,
        }
    }

    /// Type of a `let` initializer we can read off syntax: `Foo::new(..)`, `Foo { .. }`.
    fn rust_value_type(&self, v: Node) -> &'a str {
        match v.kind() {
            "call_expression" => v
                .child_by_field_name("function")
                .filter(|f| f.kind() == "scoped_identifier")
                .and_then(|f| f.child_by_field_name("path"))
                .map(|p| {
                    let t = self.text(p);
                    let last = t.rsplit("::").next().unwrap_or(t).trim();
                    // `Arc::new(x)` is typed by `x` (see `rust_chain`).
                    if last.chars().next().is_some_and(|c| c.is_ascii_uppercase())
                        && !matches!(last, "Arc" | "Rc" | "Box")
                    {
                        last
                    } else {
                        ""
                    }
                })
                .unwrap_or(""),
            "struct_expression" => v
                .child_by_field_name("name")
                .and_then(rust_type_leaf)
                .map(|l| self.text(l))
                .unwrap_or(""),
            _ => "",
        }
    }

    /// A declared type (`let x: T`, a parameter): a plain type's name, or a typed chain
    /// for a generic one (`Arc<Store>`, `Option<&Item>`), which the resolver unwraps.
    fn rust_declared_type(&self, t: Node) -> String {
        let mut inner = t;
        while inner.kind() == "reference_type" {
            match inner.child_by_field_name("type") {
                Some(x) => inner = x,
                None => break,
            }
        }
        match inner.kind() {
            "generic_type" | "tuple_type" => chain_text(self.text(inner))
                .map(|c| format!("~T{c}"))
                .unwrap_or_default(),
            _ => rust_type_leaf(inner)
                .map(|l| self.text(l).to_string())
                .unwrap_or_default(),
        }
    }

    /// The steps that type a Rust expression (see the module docs), or `None` when some
    /// part of it is not something we follow (a literal, a closure, an index, a macro).
    fn rust_chain(&self, v: Node, depth: u8) -> Option<Vec<String>> {
        if depth > MAX_CHAIN_STEPS as u8 {
            return None;
        }
        let mut out = match v.kind() {
            "self" => vec![format!("T{}", self.owner()?)],
            "identifier" => {
                let ty = self.local_type(self.text(v))?;
                if let Some(chain) = ty.strip_prefix('~') {
                    chain.split('|').map(str::to_string).collect()
                } else if ty.is_empty() {
                    return None;
                } else {
                    vec![format!("T{ty}")]
                }
            }
            "parenthesized_expression" | "reference_expression" => {
                let inner = v.named_child(v.named_child_count().checked_sub(1)? as u32)?;
                return self.rust_chain(inner, depth + 1);
            }
            "try_expression" => {
                let mut c = self.rust_chain(v.named_child(0)?, depth + 1)?;
                c.push("?".into());
                c
            }
            "await_expression" => {
                let mut c = self.rust_chain(v.named_child(0)?, depth + 1)?;
                c.push("^".into());
                c
            }
            "field_expression" => {
                let field = v.child_by_field_name("field")?;
                let mut c = self.rust_chain(v.child_by_field_name("value")?, depth + 1)?;
                c.push(format!(":{}", self.text(field)));
                c
            }
            "struct_expression" => {
                let name = v.child_by_field_name("name").and_then(rust_type_leaf)?;
                vec![format!("T{}", self.text(name))]
            }
            "call_expression" => {
                let mut f = v.child_by_field_name("function")?;
                if f.kind() == "generic_function" {
                    f = f.child_by_field_name("function")?;
                }
                match f.kind() {
                    "identifier" => {
                        let name = self.text(f);
                        if RUST_SKIP_CALLS.contains(&name) {
                            return None;
                        }
                        vec![format!("F#{name}")]
                    }
                    "scoped_identifier" => {
                        let name = self.text(f.child_by_field_name("name")?);
                        let path = f.child_by_field_name("path").map(|p| self.text(p));
                        // `Arc::new(x)`: method calls see `x` through the pointer.
                        if name == "new" && path.is_some_and(|p| matches!(p, "Arc" | "Rc" | "Box"))
                        {
                            let args = v.child_by_field_name("arguments")?;
                            if args.named_child_count() != 1 {
                                return None;
                            }
                            return self.rust_chain(args.named_child(0)?, depth + 1);
                        }
                        let q = path.map(|p| self.qualify_path(p)).unwrap_or_default();
                        vec![format!("F{q}#{name}")]
                    }
                    "field_expression" => {
                        let field = f.child_by_field_name("field")?;
                        if field.kind() != "field_identifier" {
                            return None;
                        }
                        let mut c = self.rust_chain(f.child_by_field_name("value")?, depth + 1)?;
                        c.push(format!(".{}", self.text(field)));
                        c
                    }
                    _ => return None,
                }
            }
            _ => return None,
        };
        if out.len() > MAX_CHAIN_STEPS {
            return None;
        }
        let len: usize = out.iter().map(|s| s.len() + 1).sum();
        if len > MAX_CHAIN_BYTES || out.iter().any(|s| s.contains(['|', '~'])) {
            return None;
        }
        out.shrink_to_fit();
        Some(out)
    }

    fn rust_call(&mut self, f: Node) {
        match f.kind() {
            "identifier" => {
                let t = self.text(f);
                if !RUST_SKIP_CALLS.contains(&t) {
                    self.emit(RefKind::Call, f, t, String::new());
                }
            }
            "scoped_identifier" => {
                if let Some(nm) = f.child_by_field_name("name") {
                    let q = f
                        .child_by_field_name("path")
                        .map(|p| self.qualify_path(self.text(p)))
                        .unwrap_or_default();
                    let name = self.text(nm);
                    self.emit(RefKind::Call, nm, name, q);
                }
            }
            "field_expression" => {
                if let (Some(field), Some(val)) = (
                    f.child_by_field_name("field"),
                    f.child_by_field_name("value"),
                ) {
                    if field.kind() == "field_identifier" {
                        let recv = self.qualify_value(val);
                        let name = self.text(field);
                        self.emit(RefKind::Call, field, name, recv);
                    }
                }
            }
            "generic_function" => {
                if let Some(inner) = f.child_by_field_name("function") {
                    self.rust_call(inner);
                }
            }
            _ => {}
        }
    }

    /// Macro bodies are unparsed token trees; recover `f(`, `a::f(` and `x.f(` from tokens.
    /// Test code is mostly `assert_eq!(f(x), …)`, so without this Rust tests link to nothing.
    fn rust_macro(&mut self, m: Node) {
        let mut c = m.walk();
        let mut stack: Vec<Node> = m
            .named_children(&mut c)
            .filter(|k| k.kind() == "token_tree")
            .collect();
        while let Some(tt) = stack.pop() {
            let kids: Vec<Node> = (0..tt.child_count() as u32)
                .filter_map(|i| tt.child(i))
                .collect();
            for (i, k) in kids.iter().enumerate() {
                if k.kind() == "token_tree" {
                    stack.push(*k);
                    continue;
                }
                if k.kind() != "identifier" {
                    continue;
                }
                let Some(next) = kids.get(i + 1) else {
                    continue;
                };
                if next.kind() != "token_tree" || !self.text(*next).starts_with('(') {
                    continue;
                }
                let name = self.text(*k);
                if RUST_SKIP_CALLS.contains(&name) {
                    continue;
                }
                let receiver = if i >= 2 && kids[i - 1].kind() == "::" {
                    let mut segs: Vec<&str> = Vec::new();
                    let mut j = i;
                    while j >= 2
                        && kids[j - 1].kind() == "::"
                        && matches!(
                            kids[j - 2].kind(),
                            "identifier" | "self" | "super" | "crate"
                        )
                    {
                        segs.push(self.text(kids[j - 2]));
                        j -= 2;
                    }
                    segs.reverse();
                    self.qualify_path(&segs.join("::"))
                } else if i >= 2
                    && kids[i - 1].kind() == "."
                    && matches!(kids[i - 2].kind(), "identifier" | "self")
                {
                    self.qualify_value(kids[i - 2])
                } else if i >= 1 && kids[i - 1].kind() == "." {
                    "?".to_string()
                } else {
                    String::new()
                };
                self.emit(RefKind::Call, *k, name, receiver);
            }
        }
    }

    fn rust_use_tree(&mut self, n: Node, prefix: &[String], is_pub: bool, decl: Node) {
        match n.kind() {
            "use_list" => {
                let mut c = n.walk();
                let kids: Vec<Node> = n.named_children(&mut c).collect();
                for k in kids {
                    self.rust_use_tree(k, prefix, is_pub, decl);
                }
            }
            "scoped_use_list" => {
                let mut p = prefix.to_vec();
                if let Some(path) = n.child_by_field_name("path") {
                    p.extend(path_segs(self.text(path)));
                }
                if let Some(list) = n.child_by_field_name("list") {
                    self.rust_use_tree(list, &p, is_pub, decl);
                }
            }
            "use_as_clause" => {
                let (Some(path), Some(alias)) = (
                    n.child_by_field_name("path"),
                    n.child_by_field_name("alias"),
                ) else {
                    return;
                };
                let alias = self.text(alias);
                if alias == "_" {
                    return;
                }
                let mut full = prefix.to_vec();
                full.extend(path_segs(self.text(path)));
                self.push_rust_use(alias, full, is_pub, decl);
            }
            "use_wildcard" => {
                let mut full = prefix.to_vec();
                if let Some(p) = n.named_child(0) {
                    full.extend(path_segs(self.text(p)));
                }
                self.push_rust_use("*", full, is_pub, decl);
            }
            "self" if !prefix.is_empty() => {
                let local = prefix.last().cloned().unwrap_or_default();
                self.push_rust_use(&local, prefix.to_vec(), is_pub, decl);
            }
            "identifier" | "scoped_identifier" | "crate" | "super" | "self" => {
                let mut full = prefix.to_vec();
                full.extend(path_segs(self.text(n)));
                let local = full.last().cloned().unwrap_or_default();
                self.push_rust_use(&local, full, is_pub, decl);
            }
            _ => {}
        }
    }

    fn push_rust_use(&mut self, local: &str, mut segs: Vec<String>, is_pub: bool, decl: Node) {
        // Inside `mod a { mod b { .. } }`, `self`/`super` start at the inline module; our module
        // model is per FILE, so rewrite them relative to the file module.
        let inline = self.inline_mods();
        if !inline.is_empty() {
            let k = segs.iter().take_while(|s| *s == "super").count();
            if segs.first().map(String::as_str) == Some("self") {
                let mut v = vec!["self".to_string()];
                v.extend(inline.iter().cloned());
                v.extend(segs.drain(1..));
                segs = v;
            } else if k > 0 && k <= inline.len() {
                let mut v = vec!["self".to_string()];
                v.extend(inline[..inline.len() - k].iter().cloned());
                v.extend(segs.drain(k..));
                segs = v;
            } else if k > inline.len() {
                let mut v = vec!["super".to_string(); k - inline.len()];
                v.extend(segs.drain(k..));
                segs = v;
            }
        }
        if segs.is_empty() {
            return;
        }
        let imported = if local == "*" {
            "*".to_string()
        } else {
            segs.last().cloned().unwrap_or_default()
        };
        let module = segs.join("::");
        self.import(local, &module, &imported, decl, is_pub);
    }

    // ── TypeScript / JavaScript ─────────────────────────────────────────────

    fn enter_ts(&mut self, n: Node) -> bool {
        match n.kind() {
            "import_statement" => {
                let Some(spec) = n
                    .child_by_field_name("source")
                    .map(|s| string_value(s, self.src))
                else {
                    return false;
                };
                let Some(clause) = first_named(n, "import_clause") else {
                    self.import("", &spec, "", n, false);
                    return false;
                };
                let mut c2 = clause.walk();
                let parts: Vec<Node> = clause.named_children(&mut c2).collect();
                for p in parts {
                    match p.kind() {
                        "identifier" => {
                            let t = self.text(p);
                            self.import(t, &spec, "default", n, false);
                        }
                        "named_imports" => {
                            let mut c3 = p.walk();
                            for s in p
                                .named_children(&mut c3)
                                .filter(|s| s.kind() == "import_specifier")
                            {
                                let Some(name) = s
                                    .child_by_field_name("name")
                                    .map(|x| string_value(x, self.src))
                                else {
                                    continue;
                                };
                                let local = s
                                    .child_by_field_name("alias")
                                    .map(|a| self.text(a).to_string())
                                    .unwrap_or_else(|| name.clone());
                                self.import(&local, &spec, &name, n, false);
                            }
                        }
                        "namespace_import" => {
                            if let Some(id) = first_named(p, "identifier") {
                                let t = self.text(id);
                                self.import(t, &spec, "*", n, false);
                            }
                        }
                        _ => {}
                    }
                }
                false
            }
            "export_statement" => {
                let Some(spec) = n
                    .child_by_field_name("source")
                    .map(|s| string_value(s, self.src))
                else {
                    return true; // `export function f() {}` — walk the declaration.
                };
                let mut c = n.walk();
                let kids: Vec<Node> = n.children(&mut c).collect();
                let mut any = false;
                for k in kids {
                    match k.kind() {
                        "export_clause" => {
                            let mut c2 = k.walk();
                            for s in k
                                .named_children(&mut c2)
                                .filter(|s| s.kind() == "export_specifier")
                            {
                                let Some(name) = s
                                    .child_by_field_name("name")
                                    .map(|x| string_value(x, self.src))
                                else {
                                    continue;
                                };
                                let local = s
                                    .child_by_field_name("alias")
                                    .map(|a| string_value(a, self.src))
                                    .unwrap_or_else(|| name.clone());
                                self.import(&local, &spec, &name, n, true);
                                any = true;
                            }
                        }
                        "namespace_export" => {
                            if let Some(id) = first_named(k, "identifier") {
                                let t = self.text(id);
                                self.import(t, &spec, "*", n, true);
                                any = true;
                            }
                        }
                        _ => {}
                    }
                }
                if !any {
                    self.import("*", &spec, "*", n, true); // `export * from './x'`
                }
                false
            }
            "class_declaration" | "class" | "abstract_class_declaration" => {
                let name = n
                    .child_by_field_name("name")
                    .map(|x| self.text(x).to_string())
                    .unwrap_or_default();
                let mut c = n.walk();
                let heritage: Vec<Node> = n
                    .named_children(&mut c)
                    .filter(|k| k.kind() == "class_heritage")
                    .collect();
                for h in heritage {
                    let mut c2 = h.walk();
                    let clauses: Vec<Node> = h.named_children(&mut c2).collect();
                    for cl in clauses {
                        let kind = if cl.kind() == "implements_clause" {
                            RefKind::Impl
                        } else {
                            RefKind::Inherit
                        };
                        let mut c3 = cl.walk();
                        let bases: Vec<Node> = cl.named_children(&mut c3).collect();
                        for b in bases {
                            self.ts_base(b, kind, &name);
                        }
                    }
                }
                self.push(n, (!name.is_empty()).then_some(name), None, false);
                true
            }
            "interface_declaration" => {
                let name = n
                    .child_by_field_name("name")
                    .map(|x| self.text(x).to_string())
                    .unwrap_or_default();
                let mut c = n.walk();
                let ext: Vec<Node> = n
                    .named_children(&mut c)
                    .filter(|k| k.kind() == "extends_type_clause")
                    .collect();
                for e in ext {
                    let mut c2 = e.walk();
                    let bases: Vec<Node> = e.named_children(&mut c2).collect();
                    for b in bases {
                        self.ts_base(b, RefKind::Inherit, &name);
                    }
                }
                true
            }
            "function_declaration"
            | "generator_function_declaration"
            | "function_expression"
            | "arrow_function"
            | "method_definition" => {
                self.push(n, None, None, true);
                if let Some(p) = n.child_by_field_name("parameter") {
                    let t = self.text(p);
                    self.bind(t, "");
                }
                if let Some(params) = n.child_by_field_name("parameters") {
                    let mut c = params.walk();
                    let kids: Vec<Node> = params.named_children(&mut c).collect();
                    for p in kids {
                        let ty = p
                            .child_by_field_name("type")
                            .map(|t| self.ts_type_name(t))
                            .unwrap_or("");
                        if let Some(pat) = p.child_by_field_name("pattern") {
                            self.bind_pattern(pat, ty);
                        }
                    }
                }
                true
            }
            "variable_declarator" => {
                let Some(name) = n.child_by_field_name("name") else {
                    return true;
                };
                let value = n.child_by_field_name("value");
                if let Some(v) = value.filter(|v| v.kind() == "call_expression") {
                    let is_require = v
                        .child_by_field_name("function")
                        .is_some_and(|f| self.text(f) == "require");
                    let spec = v
                        .child_by_field_name("arguments")
                        .and_then(|a| a.named_child(0))
                        .filter(|s| s.kind() == "string");
                    if let (true, Some(spec)) = (is_require, spec) {
                        let spec = string_value(spec, self.src);
                        if name.kind() == "identifier" {
                            let t = self.text(name);
                            self.import(t, &spec, "*", n, false);
                        } else {
                            let mut ids = Vec::new();
                            pattern_idents(name, &mut ids, 0);
                            for id in ids {
                                let t = self.text(id);
                                self.import(t, &spec, t, n, false);
                            }
                        }
                    }
                }
                let ty = if let Some(t) = n.child_by_field_name("type") {
                    self.ts_type_name(t)
                } else {
                    value
                        .filter(|v| v.kind() == "new_expression")
                        .and_then(|v| v.child_by_field_name("constructor"))
                        .filter(|c| c.kind() == "identifier")
                        .map(|c| self.text(c))
                        .unwrap_or("")
                };
                self.bind_pattern(name, ty);
                true
            }
            "call_expression" => {
                if let Some(f) = n.child_by_field_name("function") {
                    match f.kind() {
                        "identifier" => {
                            let t = self.text(f);
                            if !TS_SKIP_CALLS.contains(&t) {
                                self.emit(RefKind::Call, f, t, String::new());
                            }
                        }
                        "member_expression" => self.ts_member(f, RefKind::Call),
                        _ => {}
                    }
                }
                true
            }
            "new_expression" => {
                if let Some(c) = n.child_by_field_name("constructor") {
                    match c.kind() {
                        "identifier" => {
                            let t = self.text(c);
                            self.emit(RefKind::Call, c, t, String::new());
                        }
                        "member_expression" => self.ts_member(c, RefKind::Call),
                        _ => {}
                    }
                }
                true
            }
            "jsx_opening_element" | "jsx_self_closing_element" => {
                if let Some(nm) = n.child_by_field_name("name") {
                    match nm.kind() {
                        "identifier" => {
                            let t = self.text(nm);
                            if t.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                                self.emit(RefKind::Call, nm, t, String::new());
                            }
                        }
                        "member_expression" => self.ts_member(nm, RefKind::Call),
                        _ => {}
                    }
                }
                true
            }
            "type_identifier" => {
                self.type_ref(n, TS_SKIP_TYPES);
                true
            }
            "nested_type_identifier" => {
                if let (Some(nm), Some(m)) = (
                    n.child_by_field_name("name"),
                    n.child_by_field_name("module"),
                ) {
                    if !self.consumed.contains(&nm.id()) {
                        self.consumed.insert(nm.id());
                        let q = compact(self.text(m));
                        let name = self.text(nm);
                        self.emit(RefKind::Type, nm, name, q);
                    }
                }
                true
            }
            "arguments" => {
                self.value_args(n);
                true
            }
            _ => true,
        }
    }

    fn ts_member(&mut self, m: Node, kind: RefKind) {
        if let (Some(prop), Some(obj)) = (
            m.child_by_field_name("property"),
            m.child_by_field_name("object"),
        ) {
            let recv = self.qualify_value(obj);
            let name = self.text(prop);
            self.emit(kind, prop, name, recv);
        }
    }

    fn ts_type_name(&self, t: Node) -> &'a str {
        let t = if t.kind() == "type_annotation" {
            t.named_child(0)
        } else {
            Some(t)
        };
        match t {
            Some(t) if t.kind() == "type_identifier" => self.text(t),
            Some(t) if t.kind() == "generic_type" || t.kind() == "nested_type_identifier" => t
                .child_by_field_name("name")
                .map(|x| self.ts_type_name(x))
                .unwrap_or(""),
            _ => "",
        }
    }

    fn ts_base(&mut self, b: Node, kind: RefKind, src: &str) {
        let (leaf, qual) = match b.kind() {
            "identifier" | "type_identifier" => (b, String::new()),
            "member_expression" => match (
                b.child_by_field_name("property"),
                b.child_by_field_name("object"),
            ) {
                (Some(p), Some(o)) => (p, compact(self.text(o))),
                _ => return,
            },
            "nested_type_identifier" => match (
                b.child_by_field_name("name"),
                b.child_by_field_name("module"),
            ) {
                (Some(nm), Some(m)) => (nm, compact(self.text(m))),
                _ => return,
            },
            "generic_type" => {
                if let Some(nm) = b.child_by_field_name("name") {
                    self.ts_base(nm, kind, src);
                }
                return;
            }
            _ => return,
        };
        self.consumed.insert(leaf.id());
        let name = self.text(leaf);
        self.emit(kind, leaf, name, format!("{src}\t{qual}"));
    }

    // ── Python ──────────────────────────────────────────────────────────────

    fn enter_py(&mut self, n: Node) -> bool {
        match n.kind() {
            "import_statement" => {
                let mut c = n.walk();
                let names: Vec<Node> = n.children_by_field_name("name", &mut c).collect();
                for nm in names {
                    match nm.kind() {
                        "dotted_name" => {
                            let t = self.text(nm);
                            self.import(t, t, "*", n, false);
                        }
                        "aliased_import" => {
                            if let (Some(p), Some(a)) = (
                                nm.child_by_field_name("name"),
                                nm.child_by_field_name("alias"),
                            ) {
                                let (p, a) = (self.text(p), self.text(a));
                                self.import(a, p, "*", n, false);
                            }
                        }
                        _ => {}
                    }
                }
                false
            }
            "import_from_statement" => {
                let Some(module) = n
                    .child_by_field_name("module_name")
                    .map(|m| self.text(m).replace(char::is_whitespace, ""))
                else {
                    return false;
                };
                let mut c = n.walk();
                let names: Vec<Node> = n.children_by_field_name("name", &mut c).collect();
                for nm in names {
                    match nm.kind() {
                        "dotted_name" => {
                            let t = self.text(nm);
                            self.import(t, &module, t, n, false);
                        }
                        "aliased_import" => {
                            if let (Some(p), Some(a)) = (
                                nm.child_by_field_name("name"),
                                nm.child_by_field_name("alias"),
                            ) {
                                let (p, a) = (self.text(p), self.text(a));
                                self.import(a, &module, p, n, false);
                            }
                        }
                        _ => {}
                    }
                }
                if has_child_kind(n, "wildcard_import") {
                    self.import("*", &module, "*", n, false);
                }
                false
            }
            "class_definition" => {
                let name = n
                    .child_by_field_name("name")
                    .map(|x| self.text(x).to_string())
                    .unwrap_or_default();
                if let Some(sup) = n.child_by_field_name("superclasses") {
                    self.consumed.insert(sup.id());
                    let mut c = sup.walk();
                    let bases: Vec<Node> = sup.named_children(&mut c).collect();
                    for b in bases {
                        match b.kind() {
                            "identifier" => {
                                let t = self.text(b);
                                self.emit(RefKind::Inherit, b, t, format!("{name}\t"));
                            }
                            "attribute" => {
                                if let (Some(a), Some(o)) = (
                                    b.child_by_field_name("attribute"),
                                    b.child_by_field_name("object"),
                                ) {
                                    let q = compact(self.text(o));
                                    let t = self.text(a);
                                    self.emit(RefKind::Inherit, a, t, format!("{name}\t{q}"));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                self.push(n, Some(name), None, false);
                true
            }
            "function_definition" | "lambda" => {
                self.push(n, None, None, true);
                if let Some(params) = n.child_by_field_name("parameters") {
                    let mut c = params.walk();
                    let kids: Vec<Node> = params.named_children(&mut c).collect();
                    for p in kids {
                        let ty = p
                            .child_by_field_name("type")
                            .map(|t| self.py_type_name(t))
                            .unwrap_or("");
                        let name = match p.kind() {
                            "identifier" => Some(p),
                            "typed_parameter" => {
                                p.named_child(0).filter(|x| x.kind() == "identifier")
                            }
                            _ => p.child_by_field_name("name"),
                        };
                        if let Some(nm) = name {
                            let t = self.text(nm);
                            if t != "self" && t != "cls" {
                                self.bind(t, ty);
                            }
                        }
                    }
                }
                true
            }
            "assignment" => {
                if let Some(left) = n
                    .child_by_field_name("left")
                    .filter(|l| l.kind() == "identifier")
                {
                    let ty = n
                        .child_by_field_name("right")
                        .filter(|r| r.kind() == "call")
                        .and_then(|r| r.child_by_field_name("function"))
                        .filter(|f| f.kind() == "identifier")
                        .map(|f| self.text(f))
                        .filter(|t| t.chars().next().is_some_and(|c| c.is_ascii_uppercase()))
                        .unwrap_or("");
                    let t = self.text(left);
                    self.bind(t, ty);
                }
                true
            }
            "call" => {
                if let Some(f) = n.child_by_field_name("function") {
                    self.py_callee(f);
                }
                true
            }
            "decorator" => {
                if let Some(e) = n.named_child(0) {
                    if e.kind() != "call" {
                        self.py_callee(e);
                    }
                }
                true
            }
            "type" => {
                self.py_type_refs(n, 0);
                false
            }
            "argument_list" => {
                if !self.consumed.contains(&n.id()) {
                    self.value_args(n);
                }
                true
            }
            _ => true,
        }
    }

    fn py_callee(&mut self, f: Node) {
        match f.kind() {
            "identifier" => {
                let t = self.text(f);
                if !PY_SKIP_CALLS.contains(&t) {
                    self.emit(RefKind::Call, f, t, String::new());
                }
            }
            "attribute" => {
                if let (Some(a), Some(o)) = (
                    f.child_by_field_name("attribute"),
                    f.child_by_field_name("object"),
                ) {
                    let recv = self.qualify_value(o);
                    let t = self.text(a);
                    self.emit(RefKind::Call, a, t, recv);
                }
            }
            _ => {}
        }
    }

    fn py_type_name(&self, t: Node) -> &'a str {
        match t.named_child(0) {
            Some(i) if i.kind() == "identifier" => self.text(i),
            _ => "",
        }
    }

    fn py_type_refs(&mut self, n: Node, depth: u8) {
        if depth > 16 {
            return;
        }
        match n.kind() {
            "identifier" => {
                let t = self.text(n);
                if t.chars().count() > 1 && !PY_SKIP_TYPES.contains(&t) {
                    self.emit(RefKind::Type, n, t, String::new());
                }
            }
            "attribute" => {
                if let (Some(a), Some(o)) = (
                    n.child_by_field_name("attribute"),
                    n.child_by_field_name("object"),
                ) {
                    let q = compact(self.text(o));
                    let t = self.text(a);
                    self.emit(RefKind::Type, a, t, q);
                }
            }
            _ => {
                let mut c = n.walk();
                let kids: Vec<Node> = n.named_children(&mut c).collect();
                for k in kids {
                    self.py_type_refs(k, depth + 1);
                }
            }
        }
    }

    // ── Go ──────────────────────────────────────────────────────────────────

    fn enter_go(&mut self, n: Node) -> bool {
        match n.kind() {
            "import_spec" => {
                let Some(path) = n
                    .child_by_field_name("path")
                    .map(|p| go_string(p, self.src))
                else {
                    return false;
                };
                match n.child_by_field_name("name") {
                    Some(nm) if nm.kind() == "blank_identifier" => {}
                    Some(nm) if nm.kind() == "dot" => self.import("*", &path, "*", n, false),
                    Some(nm) => {
                        let t = self.text(nm);
                        self.import(t, &path, "*", n, false);
                    }
                    None => {
                        let local = go_pkg_name(&path);
                        self.import(&local, &path, "*", n, false);
                    }
                }
                false
            }
            "method_declaration" => {
                let recv = n
                    .child_by_field_name("receiver")
                    .and_then(|r| r.named_child(0))
                    .filter(|p| p.kind() == "parameter_declaration");
                let var = recv
                    .and_then(|p| p.child_by_field_name("name"))
                    .map(|x| self.text(x).to_string());
                let ty = recv
                    .and_then(|p| p.child_by_field_name("type"))
                    .and_then(go_type_leaf)
                    .map(|l| self.text(l).to_string());
                self.push(n, ty, var, true);
                self.go_params(n);
                true
            }
            "function_declaration" | "func_literal" => {
                self.push(n, None, None, true);
                self.go_params(n);
                true
            }
            "short_var_declaration" => {
                let left: Vec<Node> = n
                    .child_by_field_name("left")
                    .map(|l| {
                        let mut c = l.walk();
                        l.named_children(&mut c)
                            .filter(|x| x.kind() == "identifier")
                            .collect()
                    })
                    .unwrap_or_default();
                let right = n
                    .child_by_field_name("right")
                    .and_then(|r| r.named_child(0));
                let ty = if left.len() == 1 {
                    right.map(|r| self.go_value_type(r)).unwrap_or("")
                } else {
                    ""
                };
                for l in left {
                    let t = self.text(l);
                    self.bind(t, ty);
                }
                true
            }
            "var_spec" => {
                let ty = n
                    .child_by_field_name("type")
                    .and_then(go_type_leaf)
                    .map(|l| self.text(l))
                    .unwrap_or("");
                let mut c = n.walk();
                let names: Vec<Node> = n.children_by_field_name("name", &mut c).collect();
                for nm in names {
                    let t = self.text(nm);
                    self.bind(t, ty);
                }
                true
            }
            "call_expression" => {
                if let Some(f) = n.child_by_field_name("function") {
                    match f.kind() {
                        "identifier" => {
                            let t = self.text(f);
                            if !GO_SKIP_CALLS.contains(&t) {
                                self.emit(RefKind::Call, f, t, String::new());
                            }
                        }
                        "selector_expression" => {
                            if let (Some(field), Some(op)) = (
                                f.child_by_field_name("field"),
                                f.child_by_field_name("operand"),
                            ) {
                                let recv = self.qualify_value(op);
                                let t = self.text(field);
                                self.emit(RefKind::Call, field, t, recv);
                            }
                        }
                        _ => {}
                    }
                }
                true
            }
            "type_identifier" => {
                self.type_ref(n, GO_SKIP_TYPES);
                true
            }
            "qualified_type" => {
                if let (Some(nm), Some(pkg)) = (
                    n.child_by_field_name("name"),
                    n.child_by_field_name("package"),
                ) {
                    self.consumed.insert(nm.id());
                    let q = self.text(pkg).to_string();
                    let t = self.text(nm);
                    self.emit(RefKind::Type, nm, t, q);
                }
                true
            }
            "argument_list" => {
                self.value_args(n);
                true
            }
            _ => true,
        }
    }

    fn go_params(&mut self, f: Node) {
        let Some(params) = f.child_by_field_name("parameters") else {
            return;
        };
        let mut c = params.walk();
        let decls: Vec<Node> = params.named_children(&mut c).collect();
        for d in decls {
            let ty = d
                .child_by_field_name("type")
                .and_then(go_type_leaf)
                .map(|l| self.text(l))
                .unwrap_or("");
            let mut c2 = d.walk();
            let names: Vec<Node> = d.children_by_field_name("name", &mut c2).collect();
            for nm in names {
                let t = self.text(nm);
                self.bind(t, ty);
            }
        }
    }

    /// `T{}`, `&T{}`, `NewT(..)`, `pkg.NewT(..)` → `T`.
    fn go_value_type(&self, v: Node) -> &'a str {
        match v.kind() {
            "composite_literal" => v
                .child_by_field_name("type")
                .and_then(go_type_leaf)
                .map(|l| self.text(l))
                .unwrap_or(""),
            "unary_expression" => v
                .child_by_field_name("operand")
                .map(|o| self.go_value_type(o))
                .unwrap_or(""),
            "call_expression" => {
                let f = v.child_by_field_name("function");
                let name = match f {
                    Some(f) if f.kind() == "identifier" => self.text(f),
                    Some(f) if f.kind() == "selector_expression" => f
                        .child_by_field_name("field")
                        .map(|x| self.text(x))
                        .unwrap_or(""),
                    _ => "",
                };
                match name.strip_prefix("New") {
                    Some(rest) if rest.chars().next().is_some_and(|c| c.is_ascii_uppercase()) => {
                        rest
                    }
                    _ => "",
                }
            }
            _ => "",
        }
    }
}

fn first_named<'t>(n: Node<'t>, kind: &str) -> Option<Node<'t>> {
    let mut c = n.walk();
    let found = n.named_children(&mut c).find(|k| k.kind() == kind);
    found
}

fn has_child_kind(n: Node, kind: &str) -> bool {
    let mut c = n.walk();
    let found = n.children(&mut c).any(|k| k.kind() == kind);
    found
}

fn is_decl_name(n: Node) -> bool {
    let Some(p) = n.parent() else { return false };
    if p.kind() == "type_parameters" {
        return true;
    }
    if p.kind() == "constrained_type_parameter"
        && p.child_by_field_name("left")
            .is_some_and(|l| l.id() == n.id())
    {
        return true;
    }
    DECL_KINDS.contains(&p.kind())
        && p.child_by_field_name("name")
            .is_some_and(|x| x.id() == n.id())
}

/// The identifier naming a Rust type expression: `a::B<T>` → `B`, `&mut T` → `T`.
fn rust_type_leaf(t: Node) -> Option<Node> {
    match t.kind() {
        "type_identifier" => Some(t),
        "scoped_type_identifier" => t.child_by_field_name("name"),
        "generic_type" => t.child_by_field_name("type").and_then(rust_type_leaf),
        "reference_type" => t.child_by_field_name("type").and_then(rust_type_leaf),
        _ => None,
    }
}

fn go_type_leaf(t: Node) -> Option<Node> {
    match t.kind() {
        "type_identifier" => Some(t),
        "pointer_type" => t.named_child(0).and_then(go_type_leaf),
        "generic_type" => t.child_by_field_name("type").and_then(go_type_leaf),
        "qualified_type" => t.child_by_field_name("name"),
        _ => None,
    }
}

/// Identifiers a pattern binds (skips type and value positions).
fn pattern_idents<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>, depth: u8) {
    if depth > 16 {
        return;
    }
    if matches!(
        n.kind(),
        "identifier" | "shorthand_property_identifier_pattern"
    ) {
        out.push(n);
        return;
    }
    let mut c = n.walk();
    if c.goto_first_child() {
        loop {
            let f = c.field_name();
            let node = c.node();
            if node.is_named() && f != Some("type") && f != Some("value") {
                pattern_idents(node, out, depth + 1);
            }
            if !c.goto_next_sibling() {
                break;
            }
        }
    }
}

/// `#[path = "x.rs"]` on a `mod` item (attributes are preceding siblings).
fn rust_path_attr(m: Node, src: &[u8]) -> Option<String> {
    let mut p = m.prev_named_sibling();
    while let Some(s) = p {
        match s.kind() {
            "attribute_item" => {
                if let Some(attr) = s.named_child(0) {
                    let is_path = attr
                        .named_child(0)
                        .is_some_and(|id| id.utf8_text(src).ok() == Some("path"));
                    if let (true, Some(v)) = (is_path, attr.child_by_field_name("value")) {
                        let raw = v.utf8_text(src).ok()?;
                        return Some(raw.trim_matches('"').to_string());
                    }
                }
            }
            "line_comment" | "block_comment" => {}
            _ => break,
        }
        p = s.prev_named_sibling();
    }
    None
}

fn string_value(n: Node, src: &[u8]) -> String {
    let t = n.utf8_text(src).unwrap_or("");
    t.trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_string()
}

fn go_string(n: Node, src: &[u8]) -> String {
    let t = n.utf8_text(src).unwrap_or("");
    t.trim_matches(|c| c == '"' || c == '`').to_string()
}

/// Package name Go code uses for an import path without an alias.
pub fn go_pkg_name(path: &str) -> String {
    let mut segs: Vec<&str> = path.split('/').collect();
    let mut last = segs.pop().unwrap_or("");
    if last.len() > 1 && last.starts_with('v') && last[1..].chars().all(|c| c.is_ascii_digit()) {
        if let Some(prev) = segs.pop() {
            last = prev;
        }
    }
    let last = last.strip_prefix("go-").unwrap_or(last);
    let last = last.split('.').next().unwrap_or(last);
    last.replace('-', "_")
}

fn path_segs(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split("::")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Drop `<…>` generic arguments: `Vec::<u8>::new` → `Vec::::new` → segments `Vec`, `new`.
fn strip_generics(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

/// The identifier a pattern binds when it is just a name (`x`, `mut x`, `ref x`).
fn plain_binding(p: Node) -> Option<Node> {
    match p.kind() {
        "identifier" => Some(p),
        "mut_pattern" | "ref_pattern" => {
            let id = p.named_child(p.named_child_count().checked_sub(1)? as u32)?;
            (id.kind() == "identifier").then_some(id)
        }
        _ => None,
    }
}

/// A field of a `struct` (not of an enum variant).
fn in_struct(field: Node) -> bool {
    field
        .parent()
        .and_then(|l| l.parent())
        .is_some_and(|p| p.kind() == "struct_item")
}

/// Type text as a typed chain carries it (whitespace collapsed), or `None` when it is too long
/// or holds a character the chain encoding reserves.
fn chain_text(t: &str) -> Option<String> {
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    (t.len() <= MAX_CHAIN_BYTES && !t.contains(['|', '~'])).then_some(t)
}

/// Whitespace-free receiver text, capped at a char boundary.
fn compact(s: &str) -> String {
    let mut out: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if out.len() > MAX_RECEIVER_BYTES {
        let mut cut = MAX_RECEIVER_BYTES;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
    }
    out
}

#[cfg(test)]
mod tests {
    use crate::graph_fixtures::{extract, has_ref, imports_of, refs_of};

    #[test]
    fn rust_calls_paths_members_and_self() {
        let g = extract(
            "rust",
            "impl Foo {\n  fn run(&self) {\n    helper();\n    crate::a::b::go();\n    Self::new();\n    self.step();\n    let v = Bar::make();\n    v.go();\n    let w: Baz = make();\n    w.spin();\n    x.y.z();\n    foo::<u8>();\n  }\n}\n",
        );
        assert!(has_ref(&g, "call", "helper", ""));
        assert!(has_ref(&g, "call", "go", "crate::a::b::"));
        assert!(has_ref(&g, "call", "new", "Foo::"));
        assert!(has_ref(&g, "call", "step", "Foo::"));
        assert!(has_ref(&g, "call", "make", "Bar::"));
        assert!(has_ref(&g, "call", "go", "Bar::"));
        assert!(has_ref(&g, "call", "spin", "Baz::"));
        assert!(has_ref(&g, "call", "z", "x.y"));
        assert!(has_ref(&g, "call", "foo", ""));
        assert!(has_ref(&g, "type", "Baz", ""));
        let r = g.refs.iter().find(|r| r.name == "helper").unwrap();
        assert_eq!(r.line, 3);
        assert_eq!(r.end_byte - r.start_byte, 6);
    }

    #[test]
    fn rust_macro_token_trees_yield_calls() {
        let g = extract(
            "rust",
            "fn t() { assert_eq!(parse(x), Self::new()); println!(\"{}\", a::b(1)); v.check(); }\n",
        );
        assert!(has_ref(&g, "call", "parse", ""));
        assert!(has_ref(&g, "call", "b", "a::"));
        assert!(has_ref(&g, "call", "check", "v"));
        assert!(!refs_of(&g)
            .iter()
            .any(|(_, n, _)| n == "x" || n == "assert_eq" || n == "println"));
    }

    #[test]
    fn rust_types_impls_and_values() {
        let g = extract(
            "rust",
            "struct S<T> { a: Thing, b: io::Error }\nimpl fmt::Display for S<T> { fn f(&self, cb: Cb) { run(handler, Self::convert, cb); } }\n",
        );
        assert!(has_ref(&g, "type", "Thing", ""));
        assert!(has_ref(&g, "type", "Error", "io::"));
        assert!(has_ref(&g, "impl", "Display", "S\tfmt::"));
        assert!(has_ref(&g, "value", "handler", ""));
        assert!(has_ref(&g, "value", "convert", "S::"));
        // declarations, generic params, params and the impl's own type are not references
        assert!(!refs_of(&g)
            .iter()
            .any(|(k, n, _)| k == "type" && (n == "S" || n == "T")));
        assert!(!has_ref(&g, "value", "cb", ""));
    }

    #[test]
    fn rust_use_trees_flatten() {
        let g = extract(
            "rust",
            "pub use crate::a::{b, c as d, self, e::*};\nuse super::x::Y;\nuse std::fmt;\nextern crate serde as sd;\nmod tests { use super::*; use self::inner::Z; }\n",
        );
        let imps = imports_of(&g);
        let want =
            |l: &str, m: &str, i: &str, p: bool| (l.to_string(), m.to_string(), i.to_string(), p);
        assert!(imps.contains(&want("b", "crate::a::b", "b", true)));
        assert!(imps.contains(&want("d", "crate::a::c", "c", true)));
        assert!(imps.contains(&want("a", "crate::a", "a", true)));
        assert!(imps.contains(&want("*", "crate::a::e", "*", true)));
        assert!(imps.contains(&want("Y", "super::x::Y", "Y", false)));
        assert!(imps.contains(&want("fmt", "std::fmt", "fmt", false)));
        assert!(imps.contains(&want("sd", "serde", "serde", false)));
        // inside the inline `mod tests`, `super` is the FILE module and `self` is `self::tests`
        assert!(imps.contains(&want("*", "self", "*", false)));
        assert!(imps.contains(&want("Z", "self::tests::inner::Z", "Z", false)));
    }

    #[test]
    fn rust_mod_decls_with_path_and_inline_parent() {
        let g = extract(
            "rust",
            "mod a;\n/// docs\n#[path = \"gen/b_impl.rs\"]\npub mod b;\nmod outer { mod inner; }\nmod body { fn f() {} }\n",
        );
        let mods: Vec<(String, Option<String>, String)> = g
            .mods
            .iter()
            .map(|m| (m.name.clone(), m.path_attr.clone(), m.inline_parent.clone()))
            .collect();
        assert_eq!(
            mods,
            vec![
                ("a".into(), None, "".into()),
                ("b".into(), Some("gen/b_impl.rs".into()), "".into()),
                ("inner".into(), None, "outer".into()),
            ]
        );
    }

    #[test]
    fn ts_imports_calls_heritage_and_jsx() {
        let g = extract(
            "typescript",
            "import D, { a as b, c } from './x';\nimport * as ns from '@/y';\nimport './side';\nexport { z as zz } from './z';\nexport * from './w';\nconst q = require('./q');\nclass A extends B implements I<T>, m.J { run() { this.go(); const s = new S(); s.spin(); ns.f(cb); return <Comp/>; } }\ninterface K extends L {}\nfunction h(p: Pt): Ret { p.use(); }\n",
        );
        let imps = imports_of(&g);
        let want =
            |l: &str, m: &str, i: &str, p: bool| (l.to_string(), m.to_string(), i.to_string(), p);
        assert!(imps.contains(&want("D", "./x", "default", false)));
        assert!(imps.contains(&want("b", "./x", "a", false)));
        assert!(imps.contains(&want("c", "./x", "c", false)));
        assert!(imps.contains(&want("ns", "@/y", "*", false)));
        assert!(imps.contains(&want("", "./side", "", false)));
        assert!(imps.contains(&want("zz", "./z", "z", true)));
        assert!(imps.contains(&want("*", "./w", "*", true)));
        assert!(imps.contains(&want("q", "./q", "*", false)));
        assert!(has_ref(&g, "inherit", "B", "A\t"));
        assert!(has_ref(&g, "impl", "I", "A\t"));
        assert!(has_ref(&g, "impl", "J", "A\tm"));
        assert!(has_ref(&g, "inherit", "L", "K\t"));
        assert!(has_ref(&g, "call", "go", "A::"));
        assert!(has_ref(&g, "call", "S", ""));
        assert!(has_ref(&g, "call", "spin", "S::"));
        assert!(has_ref(&g, "call", "f", "ns"));
        assert!(has_ref(&g, "value", "cb", ""));
        assert!(has_ref(&g, "call", "Comp", ""));
        assert!(has_ref(&g, "call", "use", "Pt::"));
        assert!(has_ref(&g, "type", "Ret", ""));
        assert!(!has_ref(&g, "call", "require", ""));
    }

    #[test]
    fn python_imports_calls_and_bases() {
        let g = extract(
            "python",
            "import os.path as p, a.b\nfrom ..pkg.mod import f as g, h\nfrom . import sib\nfrom x import *\n@deco\nclass C(Base, m.Mixin):\n    def run(self, a: T) -> Ret:\n        self.go(cb)\n        o = Foo()\n        o.bar()\n        print(a)\n",
        );
        let imps = imports_of(&g);
        let want = |l: &str, m: &str, i: &str| (l.to_string(), m.to_string(), i.to_string(), false);
        assert!(imps.contains(&want("p", "os.path", "*")));
        assert!(imps.contains(&want("a.b", "a.b", "*")));
        assert!(imps.contains(&want("g", "..pkg.mod", "f")));
        assert!(imps.contains(&want("h", "..pkg.mod", "h")));
        assert!(imps.contains(&want("sib", ".", "sib")));
        assert!(imps.contains(&want("*", "x", "*")));
        assert!(has_ref(&g, "call", "deco", ""));
        assert!(has_ref(&g, "inherit", "Base", "C\t"));
        assert!(has_ref(&g, "inherit", "Mixin", "C\tm"));
        assert!(has_ref(&g, "call", "go", "C::"));
        assert!(has_ref(&g, "value", "cb", ""));
        assert!(has_ref(&g, "call", "Foo", ""));
        assert!(has_ref(&g, "call", "bar", "Foo::"));
        assert!(has_ref(&g, "type", "Ret", ""));
        assert!(!has_ref(&g, "call", "print", ""));
        assert!(!has_ref(&g, "value", "Base", ""));
    }

    #[test]
    fn go_imports_receivers_and_types() {
        let g = extract(
            "go",
            "package main\nimport (\n  f \"fmt\"\n  \"example.com/m/pkg/util\"\n  \"gopkg.in/yaml.v3\"\n  . \"strings\"\n  _ \"x\"\n)\nfunc (r *Repo) Save(x int) error { r.load(); util.Do(cb); v := NewThing(); v.Run(); var t util.T; return nil }\n",
        );
        let imps = imports_of(&g);
        let want = |l: &str, m: &str| (l.to_string(), m.to_string(), "*".to_string(), false);
        assert!(imps.contains(&want("f", "fmt")));
        assert!(imps.contains(&want("util", "example.com/m/pkg/util")));
        assert!(imps.contains(&want("yaml", "gopkg.in/yaml.v3")));
        assert!(imps.contains(&want("*", "strings")));
        assert_eq!(imps.len(), 4);
        assert!(has_ref(&g, "call", "load", "Repo::"));
        assert!(has_ref(&g, "call", "Do", "util"));
        assert!(has_ref(&g, "call", "Run", "Thing::"));
        assert!(has_ref(&g, "type", "T", "util"));
        assert!(has_ref(&g, "type", "Repo", ""));
        assert!(has_ref(&g, "value", "cb", ""));
        assert!(!has_ref(&g, "type", "int", ""));
    }

    #[test]
    fn deep_nesting_does_not_overflow() {
        let src = format!("fn f() {{ {}1{} }}", "(".repeat(5000), ")".repeat(5000));
        let g = extract("rust", &src);
        assert!(g.refs.is_empty());
    }

    #[test]
    fn unknown_language_yields_nothing() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_rust::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse("fn f() { g(); }", None).unwrap();
        let g = super::extract_graph("markdown", tree.root_node(), b"fn f() { g(); }");
        assert_eq!(g, super::GraphExtract::default());
    }
}
