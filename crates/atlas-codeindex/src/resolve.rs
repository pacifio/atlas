//! Reference resolution: CMM's confidence cascade (03 §1.3), ported with its guards, plus a
//! real Rust module-path step CMM lacks.
//!
//! Order (first hit wins): `module_path` 0.95 (Rust `crate::`/`self::`/`super::`/crate-name
//! paths) → `import_map` 0.95 → `import_map_suffix` 0.85 (incl. glob imports) → `same_module`
//! 0.90 → candidates by simple name (none if more than 256) → `qualified_suffix` 0.90 →
//! `unique_name` 0.75 (×0.5 when not import-reachable) → `suffix_match` 0.55·min(1, 3/n)
//! (×0.5 when nothing is import-reachable).
//! Guards: same language family only; `receiver_chain_admits`; weak member calls (`x.f()` on an
//! untyped receiver) never bind by name alone in Python/JS/TS, and only to methods in Rust/Go;
//! value refs bind only through imports, module paths, the same module or a qualified tail;
//! ties break deterministically (non-test +1000, module-prefix proximity, shallower QN, QN, id).

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::graph_extract::RefKind;
use crate::import_resolve::{rust_abs, rust_longest_module, ImportTarget, ReexportGraph};
use crate::universe::{SymRow, Universe, GO, PY, RUST, TS};

pub(crate) const MAX_CANDIDATES: usize = 256;

pub(crate) const CALLABLE_KINDS: &[&str] =
    &["fn", "function", "method", "constructor", "macro", "func"];
/// Calls may also construct: `new Foo()`, `Foo()`, Rust tuple structs, Go conversions.
pub(crate) const CONSTRUCTIBLE_KINDS: &[&str] = &["class", "struct"];
pub(crate) const TYPE_KINDS: &[&str] = &[
    "struct",
    "enum",
    "class",
    "interface",
    "trait",
    "type",
    "union",
    "type_alias",
    "typealias",
];

/// std/prelude method names: an untyped `x.clone()` must never bind to a project's `clone`.
const RUST_STD_METHODS: &[&str] = &[
    "clone",
    "to_string",
    "to_owned",
    "into",
    "from",
    "as_ref",
    "as_mut",
    "borrow",
    "borrow_mut",
    "unwrap",
    "expect",
    "unwrap_or",
    "unwrap_or_default",
    "unwrap_or_else",
    "ok",
    "err",
    "map",
    "map_err",
    "and_then",
    "or_else",
    "iter",
    "iter_mut",
    "into_iter",
    "collect",
    "filter",
    "filter_map",
    "find",
    "any",
    "all",
    "len",
    "is_empty",
    "push",
    "pop",
    "insert",
    "remove",
    "get",
    "get_mut",
    "contains",
    "extend",
    "join",
    "split",
    "trim",
    "lock",
    "read",
    "write",
    "send",
    "recv",
    "await",
    "fmt",
    "eq",
    "cmp",
    "partial_cmp",
    "hash",
    "default",
    "next",
    "take",
    "skip",
    "chain",
    "zip",
    "rev",
    "sort",
    "sort_by",
    "sort_by_key",
    "dedup",
    "retain",
    "drain",
    "clear",
    "as_str",
    "as_slice",
    "starts_with",
    "ends_with",
    "parse",
    "is_some",
    "is_none",
    "is_ok",
    "is_err",
    "copied",
    "cloned",
    "first",
    "last",
    "entry",
    "or_insert",
    "or_default",
    "keys",
    "values",
    "with_capacity",
    "new",
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Resolved {
    pub dst: i64,
    pub confidence: f32,
    pub strategy: &'static str,
}

#[derive(Debug, Clone)]
pub(crate) struct RefRow {
    pub id: i64,
    pub file_id: i64,
    pub src: Option<i64>,
    pub kind: RefKind,
    pub name: String,
    pub receiver: String,
}

#[derive(Debug, Clone)]
struct Binding {
    local: String,
    file: Option<i64>,
    module: Option<String>,
    symbol: Option<String>,
    glob: bool,
}

pub(crate) struct Resolver<'u> {
    u: &'u Universe,
    reexports: ReexportGraph<'u>,
    libs: BTreeSet<String>,
    bindings: HashMap<i64, Vec<Binding>>,
    reach: HashMap<i64, (HashSet<i64>, Vec<String>)>,
    memo: HashMap<(i64, u8, String, String), Option<Resolved>>,
}

impl<'u> Resolver<'u> {
    /// `targets` is aligned with `u.imports`; `libs` = Rust library crate names.
    pub(crate) fn new(
        u: &'u Universe,
        targets: &[ImportTarget],
        libs: BTreeSet<String>,
    ) -> Resolver<'u> {
        let mut bindings: HashMap<i64, Vec<Binding>> = HashMap::new();
        for (row, t) in u.imports.iter().zip(targets) {
            if row.local_name.is_empty() {
                continue;
            }
            bindings.entry(row.file_id).or_default().push(Binding {
                local: row.local_name.clone(),
                file: t.file,
                module: t.module.clone(),
                symbol: t.symbol.clone(),
                glob: t.glob,
            });
        }
        Resolver {
            u,
            reexports: ReexportGraph::new(u, targets),
            libs,
            bindings,
            reach: HashMap::new(),
            memo: HashMap::new(),
        }
    }

    /// Resolve one reference to `(src symbol, target)`. `None` = no edge.
    pub(crate) fn resolve(&mut self, r: &RefRow) -> Option<(i64, Resolved)> {
        let (src, receiver) = match r.kind {
            RefKind::Inherit | RefKind::Impl => {
                let (src_ty, qual) = r
                    .receiver
                    .split_once('\t')
                    .unwrap_or((r.receiver.as_str(), ""));
                (self.base_src(r, src_ty)?, qual.to_string())
            }
            _ => (r.src?, r.receiver.clone()),
        };
        let group = match r.kind {
            RefKind::Call => 0u8,
            RefKind::Value => 1,
            _ => 2,
        };
        let key = (r.file_id, group, receiver.clone(), r.name.clone());
        if let Some(hit) = self.memo.get(&key) {
            return hit.map(|d| (src, d));
        }
        let res = self.cascade(r.file_id, r.kind, &receiver, &r.name);
        self.memo.insert(key, res);
        res.map(|d| (src, d))
    }

    /// The implementing/deriving type: the enclosing class (TS/Python), a same-file type, or
    /// whatever the cascade finds for its name.
    fn base_src(&mut self, r: &RefRow, src_ty: &str) -> Option<i64> {
        if src_ty.is_empty() {
            return None;
        }
        if let Some(s) = r.src {
            if self.sym_by_id(s).is_some_and(|x| x.name == src_ty) {
                return Some(s);
            }
        }
        let same_file = self
            .u
            .by_file_name
            .get(&(r.file_id, src_ty.to_string()))
            .and_then(|v| {
                v.iter()
                    .map(|i| &self.u.syms[*i])
                    .find(|s| TYPE_KINDS.contains(&s.kind.as_str()))
            })
            .map(|s| s.id);
        same_file.or_else(|| {
            self.cascade(r.file_id, RefKind::Type, "", src_ty)
                .map(|d| d.dst)
        })
    }

    fn sym_by_id(&self, id: i64) -> Option<&'u SymRow> {
        self.u.sym_ix.get(&id).map(|i| &self.u.syms[*i])
    }

    fn cascade(&mut self, f: i64, kind: RefKind, receiver: &str, name: &str) -> Option<Resolved> {
        let u = self.u;
        let fam = u.fam_of(f);
        let (segs, qualified) = parse_receiver(receiver);
        let member = !segs.is_empty() && !qualified;
        if fam == RUST && member && RUST_STD_METHODS.contains(&name) {
            return None;
        }
        let ok = |s: &SymRow| kind_ok(kind, s) && u.fam_of(s.file_id) == fam;
        let value = kind == RefKind::Value;

        // Rust paths through the real module tree.
        if fam == RUST && qualified {
            if let Some(abs) = rust_abs(u, &self.libs, &u.file(f).module, &segs) {
                if let Some((_, m, rest)) = rust_longest_module(u, &abs) {
                    let files: Vec<i64> = u.files_of_module(RUST, &m).to_vec();
                    let need: Vec<&str> = rest.iter().map(String::as_str).collect();
                    let c = self.in_files(&files, name, &ok, &need, true);
                    if !c.is_empty() {
                        return Some(self.pick(f, &c, 0.95, "module_path"));
                    }
                }
            }
        }

        // S1 import_map / S1b import_map_suffix.
        if let Some((b, rest)) = self.binding_for(f, &segs, name) {
            let (files, mut need) = self.binding_scope(fam, &b, &rest);
            let target_name = match (&b.symbol, segs.is_empty()) {
                (Some(s), true) if s != "*" && s != "default" => s.clone(),
                _ => name.to_string(),
            };
            if !segs.is_empty() {
                if let Some(s) = b.symbol.as_deref().filter(|s| *s != "*" && *s != "default") {
                    need.insert(0, s.to_string());
                }
            }
            let need_refs: Vec<&str> = need.iter().map(String::as_str).collect();
            let mut c = self.in_files(&files, &target_name, &ok, &need_refs, true);
            if c.is_empty() && segs.is_empty() && b.symbol.as_deref() == Some("default") {
                c = self.default_export(&files, &ok);
            }
            if !c.is_empty() {
                return Some(self.pick(f, &c, 0.95, "import_map"));
            }
            if let Some(m) = b.module.as_deref() {
                let c: Vec<usize> = self
                    .by_name(name)
                    .iter()
                    .copied()
                    .filter(|i| {
                        ok(&u.syms[*i]) && module_within(&u.file(u.syms[*i].file_id).module, m)
                    })
                    .collect();
                if !c.is_empty() {
                    return Some(self.pick(f, &c, 0.85, "import_map_suffix"));
                }
            }
        } else if segs.is_empty() {
            let globs: Vec<Binding> = self
                .bindings
                .get(&f)
                .map(|v| v.iter().filter(|b| b.glob).cloned().collect())
                .unwrap_or_default();
            for b in globs {
                let (files, need) = self.binding_scope(fam, &b, &[]);
                let need_refs: Vec<&str> = need.iter().map(String::as_str).collect();
                let c = self.in_files(&files, name, &ok, &need_refs, true);
                if !c.is_empty() {
                    return Some(self.pick(f, &c, 0.85, "import_map_suffix"));
                }
            }
        }

        // S2 same_module.
        if !member || fam == RUST || fam == GO {
            let files: Vec<i64> = u.files_of_module(fam, &u.file(f).module).to_vec();
            let c: Vec<usize> = self
                .in_files(&files, name, &ok, &[], false)
                .into_iter()
                .filter(|i| admits(u, &segs, *i) && (!member || is_method(u, *i)))
                .collect();
            if !c.is_empty() {
                return Some(self.pick(f, &c, 0.90, "same_module"));
            }
        }

        // S3: by simple name.
        let all: Vec<usize> = self
            .by_name(name)
            .iter()
            .copied()
            .filter(|i| ok(&u.syms[*i]))
            .collect();
        if all.is_empty() || all.len() > MAX_CANDIDATES {
            return None;
        }
        let mut pool = all;
        if let Some(tail) = segs
            .last()
            .filter(|_| qualified || segs.iter().any(|s| starts_upper(s)))
        {
            let q: Vec<usize> = pool
                .iter()
                .copied()
                .filter(|i| parent_named(u, *i, tail))
                .collect();
            if q.len() == 1 {
                return Some(self.pick(f, &q, 0.90, "qualified_suffix"));
            }
            if q.len() > 1 {
                pool = q;
            }
        }
        if value {
            return None;
        }
        let pool: Vec<usize> = pool.into_iter().filter(|i| admits(u, &segs, *i)).collect();
        if pool.is_empty() {
            return None;
        }
        if pool.len() == 1 {
            let i = pool[0];
            if weak_member_rejects(fam, member, "unique_name", u, i) {
                return None;
            }
            let reach = self.reachable(f, i);
            return Some(self.pick(f, &pool, if reach { 0.75 } else { 0.375 }, "unique_name"));
        }
        if weak_member_rejects(fam, member, "suffix_match", u, pool[0]) {
            return None;
        }
        let reachable: Vec<usize> = pool
            .iter()
            .copied()
            .filter(|i| self.reachable(f, *i))
            .collect();
        let (pool, factor) = if reachable.is_empty() {
            (pool, 0.5)
        } else {
            (reachable, 1.0)
        };
        let conf = 0.55 * (3.0 / pool.len() as f32).min(1.0) * factor;
        Some(self.pick(f, &pool, conf, "suffix_match"))
    }

    fn by_name(&self, name: &str) -> &'u [usize] {
        self.u.by_name.get(name).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Candidates named `name` in `files` whose ancestry contains every segment of `need`
    /// (only the upper-case ones unless `strict`), following re-exports when a file has none.
    fn in_files(
        &self,
        files: &[i64],
        name: &str,
        ok: &dyn Fn(&SymRow) -> bool,
        need: &[&str],
        follow: bool,
    ) -> Vec<usize> {
        let u = self.u;
        let matches = |fid: i64| -> Vec<usize> {
            u.by_file_name
                .get(&(fid, name.to_string()))
                .map(|v| {
                    v.iter()
                        .copied()
                        .filter(|i| ok(&u.syms[*i]) && need.iter().all(|n| in_ancestry(u, *i, n)))
                        .collect()
                })
                .unwrap_or_default()
        };
        let mut out: Vec<usize> = files.iter().flat_map(|f| matches(*f)).collect();
        if out.is_empty() && follow {
            let head = need.first().copied().unwrap_or(name);
            for fid in files {
                if let Some(def) = self.reexports.chase(*fid, head) {
                    out.extend(matches(def));
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// TS `import D from './x'`: the file's only exported callable/type, if unambiguous.
    fn default_export(&self, files: &[i64], ok: &dyn Fn(&SymRow) -> bool) -> Vec<usize> {
        let u = self.u;
        let exported: Vec<usize> = (0..u.syms.len())
            .filter(|i| {
                files.contains(&u.syms[*i].file_id)
                    && u.syms[*i].exported
                    && u.syms[*i].parent.is_none()
                    && ok(&u.syms[*i])
            })
            .collect();
        if exported.len() == 1 {
            exported
        } else {
            Vec::new()
        }
    }

    /// The import binding a receiver (or a bare name) goes through, plus the leftover segments.
    fn binding_for(&self, f: i64, segs: &[&str], name: &str) -> Option<(Binding, Vec<String>)> {
        let list = self.bindings.get(&f)?;
        if segs.is_empty() {
            return list
                .iter()
                .find(|b| !b.glob && b.local == name)
                .map(|b| (b.clone(), Vec::new()));
        }
        // Python binds dotted names (`import a.b`): try the longest dotted prefix first.
        for k in (1..=segs.len()).rev() {
            let key = segs[..k].join(".");
            if let Some(b) = list.iter().find(|b| !b.glob && b.local == key) {
                return Some((
                    b.clone(),
                    segs[k..].iter().map(ToString::to_string).collect(),
                ));
            }
        }
        None
    }

    /// Files a binding points into, and the ancestry still required of a candidate.
    fn binding_scope(&self, fam: u8, b: &Binding, rest: &[String]) -> (Vec<i64>, Vec<String>) {
        let u = self.u;
        match (fam, &b.module) {
            (RUST, Some(m)) if b.symbol.is_none() => {
                // `use crate::a; a::b::f()` — descend through child modules first.
                let mut module = m.clone();
                let mut i = 0;
                while i < rest.len()
                    && !u
                        .files_of_module(RUST, &format!("{module}::{}", rest[i]))
                        .is_empty()
                {
                    module = format!("{module}::{}", rest[i]);
                    i += 1;
                }
                (
                    u.files_of_module(RUST, &module).to_vec(),
                    rest[i..].to_vec(),
                )
            }
            (GO, Some(m)) => (u.files_of_module(GO, m).to_vec(), rest.to_vec()),
            _ => (
                b.file.into_iter().collect(),
                rest.iter().filter(|s| starts_upper(s)).cloned().collect(),
            ),
        }
    }

    /// Is the candidate's file reachable through `f`'s imports (or `f` itself)?
    fn reachable(&mut self, f: i64, cand: usize) -> bool {
        let u = self.u;
        if !self.reach.contains_key(&f) {
            let mut files: HashSet<i64> = HashSet::from([f]);
            let mut modules: Vec<String> = Vec::new();
            for b in self.bindings.get(&f).into_iter().flatten() {
                files.extend(b.file);
                if let Some(m) = &b.module {
                    modules.push(m.clone());
                }
            }
            self.reach.insert(f, (files, modules));
        }
        let (files, modules) = &self.reach[&f];
        let c = &u.syms[cand];
        files.contains(&c.file_id)
            || modules
                .iter()
                .any(|m| module_within(&u.file(c.file_id).module, m))
    }

    /// Deterministic best candidate: non-test +1000, module-prefix proximity, shallower QN,
    /// then QN, then id.
    fn pick(&self, f: i64, cands: &[usize], confidence: f32, strategy: &'static str) -> Resolved {
        let u = self.u;
        let my_mod = &u.file(f).module;
        let best = cands
            .iter()
            .copied()
            .max_by(|a, b| {
                let (sa, sb) = (&u.syms[*a], &u.syms[*b]);
                let score = |s: &SymRow| {
                    (if s.is_test { 0 } else { 1000 })
                        + common_prefix(&u.file(s.file_id).module, my_mod)
                };
                score(sa)
                    .cmp(&score(sb))
                    .then_with(|| qn_depth(&sb.qn).cmp(&qn_depth(&sa.qn)))
                    .then_with(|| sb.qn.cmp(&sa.qn))
                    .then_with(|| sb.id.cmp(&sa.id))
            })
            .expect("non-empty candidates");
        Resolved {
            dst: u.syms[best].id,
            confidence,
            strategy,
        }
    }
}

/// `""` → no receiver; `"a::B::"` → qualified segments; `"x.y"` → member segments.
pub(crate) fn parse_receiver(receiver: &str) -> (Vec<&str>, bool) {
    if receiver.is_empty() {
        return (Vec::new(), false);
    }
    if let Some(path) = receiver.strip_suffix("::") {
        return (path.split("::").filter(|s| !s.is_empty()).collect(), true);
    }
    (
        receiver.split('.').filter(|s| !s.is_empty()).collect(),
        false,
    )
}

fn kind_ok(kind: RefKind, s: &SymRow) -> bool {
    let k = s.kind.as_str();
    match kind {
        RefKind::Call => CALLABLE_KINDS.contains(&k) || CONSTRUCTIBLE_KINDS.contains(&k),
        RefKind::Value => CALLABLE_KINDS.contains(&k),
        RefKind::Type | RefKind::Inherit | RefKind::Impl => TYPE_KINDS.contains(&k),
    }
}

fn starts_upper(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

fn split_segments(s: &str) -> impl Iterator<Item = &str> {
    s.split(|c| c == ':' || c == '.' || c == '/' || c == '#')
        .filter(|x| !x.is_empty())
}

fn qn_depth(qn: &str) -> usize {
    split_segments(qn).count()
}

fn common_prefix(a: &str, b: &str) -> usize {
    split_segments(a)
        .zip(split_segments(b))
        .take_while(|(x, y)| x == y)
        .count()
}

/// `m` equals `prefix` or lies under it.
fn module_within(m: &str, prefix: &str) -> bool {
    m == prefix
        || (m.starts_with(prefix)
            && matches!(
                m[prefix.len()..].chars().next(),
                Some(':') | Some('.') | Some('/')
            ))
}

/// Parent names, QN segments and the file's module segments of a symbol.
fn in_ancestry(u: &Universe, i: usize, seg: &str) -> bool {
    let s = &u.syms[i];
    let mut p = s.parent;
    let mut guard = 0;
    while let Some(pid) = p {
        let Some(pi) = u.sym_ix.get(&pid) else { break };
        if u.syms[*pi].name == seg {
            return true;
        }
        p = u.syms[*pi].parent;
        guard += 1;
        if guard > 32 {
            break;
        }
    }
    split_segments(&s.qn).any(|x| x == seg)
        || split_segments(&u.file(s.file_id).module).any(|x| x == seg)
}

/// CMM `receiver_chain_admits`: an upper-case receiver chain must name an ancestor.
fn admits(u: &Universe, segs: &[&str], i: usize) -> bool {
    let upper: Vec<&&str> = segs.iter().filter(|s| starts_upper(s)).collect();
    upper.is_empty() || upper.iter().any(|s| in_ancestry(u, i, s))
}

/// Qualified tail: the candidate's parent (or QN segment before its name) is `tail`.
fn parent_named(u: &Universe, i: usize, tail: &str) -> bool {
    let s = &u.syms[i];
    if let Some(pi) = s.parent.and_then(|p| u.sym_ix.get(&p)) {
        if u.syms[*pi].name == tail {
            return true;
        }
    }
    let segs: Vec<&str> = split_segments(&s.qn).collect();
    segs.len() >= 2 && segs[segs.len() - 2] == tail
}

fn is_method(u: &Universe, i: usize) -> bool {
    let s = &u.syms[i];
    if s.kind == "method" {
        return true;
    }
    if let Some(pi) = s.parent.and_then(|p| u.sym_ix.get(&p)) {
        let k = u.syms[*pi].kind.as_str();
        return TYPE_KINDS.contains(&k) || k == "impl";
    }
    let segs: Vec<&str> = split_segments(&s.qn).collect();
    segs.len() >= 2 && starts_upper(segs[segs.len() - 2])
}

/// No plain edge for `x.f()` matched by name alone: never in Python/JS/TS; in Rust/Go only a
/// `unique_name` hit on a method survives.
fn weak_member_rejects(fam: u8, member: bool, strategy: &str, u: &Universe, cand: usize) -> bool {
    if !member {
        return false;
    }
    match fam {
        PY | TS => true,
        _ => strategy == "suffix_match" || !is_method(u, cand),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::universe::{FileRow, ImportRow, SymRow};
    use std::collections::HashMap;

    fn file(id: i64, rel: &str, lang: &str, module: &str) -> FileRow {
        FileRow {
            id,
            rel: rel.into(),
            lang: lang.into(),
            module: module.into(),
        }
    }

    fn sym(id: i64, file_id: i64, parent: Option<i64>, kind: &str, name: &str, qn: &str) -> SymRow {
        SymRow {
            id,
            file_id,
            parent,
            kind: kind.into(),
            name: name.into(),
            qn: qn.into(),
            exported: true,
            is_test: false,
        }
    }

    fn call(file_id: i64, src: i64, name: &str, receiver: &str) -> RefRow {
        RefRow {
            id: 1,
            file_id,
            src: Some(src),
            kind: RefKind::Call,
            name: name.into(),
            receiver: receiver.into(),
        }
    }

    fn imp(file_id: i64, local: &str, module: &str, imported: &str) -> ImportRow {
        ImportRow {
            rowid: 0,
            file_id,
            local_name: local.into(),
            module_path: module.into(),
            imported_name: imported.into(),
            is_pub: false,
            resolved_file_id: None,
        }
    }

    fn resolver(u: &Universe, targets: Vec<ImportTarget>) -> Resolver<'_> {
        Resolver::new(u, &targets, BTreeSet::new())
    }

    #[test]
    fn unique_name_halved_when_not_import_reachable() {
        let u = Universe::from_parts(
            vec![
                file(1, "a.py", "python", "a"),
                file(2, "b.py", "python", "b"),
            ],
            vec![
                sym(10, 1, None, "fn", "caller", "a.caller"),
                sym(20, 2, None, "fn", "target", "b.target"),
            ],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        let (_, d) = r.resolve(&call(1, 10, "target", "")).unwrap();
        assert_eq!((d.dst, d.strategy), (20, "unique_name"));
        assert!((d.confidence - 0.375).abs() < 1e-6);
    }

    #[test]
    fn import_map_beats_same_name_elsewhere() {
        let u = Universe::from_parts(
            vec![
                file(1, "a.py", "python", "a"),
                file(2, "b.py", "python", "b"),
                file(3, "c.py", "python", "c"),
            ],
            vec![
                sym(10, 1, None, "fn", "caller", "a.caller"),
                sym(20, 2, None, "fn", "run", "b.run"),
                sym(30, 3, None, "fn", "run", "c.run"),
            ],
            vec![imp(1, "run", "c", "run")],
            HashMap::new(),
        );
        let t = vec![ImportTarget {
            file: Some(3),
            module: Some("c".into()),
            symbol: Some("run".into()),
            glob: false,
        }];
        let mut r = resolver(&u, t);
        let (_, d) = r.resolve(&call(1, 10, "run", "")).unwrap();
        assert_eq!((d.dst, d.strategy, d.confidence), (30, "import_map", 0.95));
    }

    #[test]
    fn suffix_match_confidence_scales_with_candidates_and_prefers_non_test() {
        let mut syms = vec![sym(1, 1, None, "fn", "caller", "m.caller")];
        for k in 0..6 {
            let mut s = sym(100 + k, 2 + k, None, "fn", "run", &format!("p{k}.run"));
            s.is_test = k != 4;
            syms.push(s);
        }
        let mut files = vec![file(1, "m.py", "python", "m")];
        files.extend((0..6).map(|k| file(2 + k, &format!("p{k}.py"), "python", &format!("p{k}"))));
        let u = Universe::from_parts(files, syms, vec![], HashMap::new());
        let mut r = resolver(&u, vec![]);
        let (_, d) = r.resolve(&call(1, 1, "run", "")).unwrap();
        assert_eq!((d.dst, d.strategy), (104, "suffix_match"));
        // 6 candidates, none import-reachable: 0.55 · 3/6 · 0.5
        assert!((d.confidence - 0.1375).abs() < 1e-6);
    }

    #[test]
    fn more_than_256_candidates_gives_up() {
        let mut syms = vec![sym(1, 1, None, "fn", "caller", "m.caller")];
        let mut files = vec![file(1, "m.go", "go", "m")];
        for k in 0..257 {
            files.push(file(2 + k, &format!("p{k}/x.go"), "go", &format!("p{k}")));
            syms.push(sym(
                1000 + k,
                2 + k,
                None,
                "fn",
                "Dup",
                &format!("p{k}.Dup"),
            ));
        }
        let u = Universe::from_parts(files, syms, vec![], HashMap::new());
        let mut r = resolver(&u, vec![]);
        assert!(r.resolve(&call(1, 1, "Dup", "")).is_none());
    }

    #[test]
    fn ambiguous_new_resolved_by_receiver_type() {
        let u = Universe::from_parts(
            vec![
                file(1, "a.rs", "rust", "c::a"),
                file(2, "b.rs", "rust", "c::b"),
                file(3, "d.rs", "rust", "c::d"),
            ],
            vec![
                sym(1, 1, None, "fn", "caller", "caller"),
                sym(10, 2, None, "struct", "Engine", "Engine"),
                sym(11, 2, Some(10), "method", "new", "Engine::new"),
                sym(20, 3, None, "struct", "Part", "Part"),
                sym(21, 3, Some(20), "method", "new", "Part::new"),
            ],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        let (_, d) = r.resolve(&call(1, 1, "new", "Part::")).unwrap();
        assert_eq!((d.dst, d.strategy), (21, "qualified_suffix"));
        // a receiver chain naming no ancestor is refused rather than guessed
        assert!(r.resolve(&call(1, 1, "new", "Gadget::")).is_none());
    }

    #[test]
    fn weak_member_calls_get_no_edge_in_dynamic_languages() {
        let u = Universe::from_parts(
            vec![
                file(1, "a.ts", "typescript", "a"),
                file(2, "s.ts", "typescript", "s"),
            ],
            vec![
                sym(1, 1, None, "fn", "caller", "caller"),
                sym(10, 2, None, "class", "Store", "Store"),
                sym(11, 2, Some(10), "method", "save", "Store.save"),
            ],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        assert!(r.resolve(&call(1, 1, "save", "x")).is_none());
        // typed receiver (`this` in Store, or `new Store()` local) still binds
        assert_eq!(r.resolve(&call(1, 1, "save", "Store::")).unwrap().1.dst, 11);
    }

    #[test]
    fn cross_language_veto() {
        let u = Universe::from_parts(
            vec![
                file(1, "a.py", "python", "a"),
                file(2, "b.ts", "typescript", "b"),
            ],
            vec![
                sym(1, 1, None, "fn", "caller", "caller"),
                sym(10, 2, None, "fn", "commit", "commit"),
            ],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        assert!(r.resolve(&call(1, 1, "commit", "")).is_none());
    }

    #[test]
    fn rust_std_method_names_on_untyped_receivers_never_bind() {
        let u = Universe::from_parts(
            vec![file(1, "a.rs", "rust", "c::a")],
            vec![
                sym(1, 1, None, "fn", "caller", "caller"),
                sym(10, 1, None, "struct", "Buf", "Buf"),
                sym(11, 1, Some(10), "method", "clone", "Buf::clone"),
            ],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        assert!(r.resolve(&call(1, 1, "clone", "x")).is_none());
        assert_eq!(r.resolve(&call(1, 1, "clone", "Buf::")).unwrap().1.dst, 11);
    }

    #[test]
    fn value_refs_only_bind_through_scope() {
        let u = Universe::from_parts(
            vec![
                file(1, "a.rs", "rust", "c::a"),
                file(2, "b.rs", "rust", "c::b"),
            ],
            vec![
                sym(1, 1, None, "fn", "caller", "caller"),
                sym(2, 1, None, "fn", "local_fn", "local_fn"),
                sym(10, 2, None, "fn", "far_fn", "far_fn"),
            ],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        let v = |name: &str| RefRow {
            id: 1,
            file_id: 1,
            src: Some(1),
            kind: RefKind::Value,
            name: name.into(),
            receiver: String::new(),
        };
        assert_eq!(r.resolve(&v("local_fn")).unwrap().1.strategy, "same_module");
        assert!(r.resolve(&v("far_fn")).is_none());
    }

    #[test]
    fn deterministic_tie_break_is_order_independent() {
        let build = |rev: bool| {
            let mut syms = vec![
                sym(1, 1, None, "fn", "caller", "m.caller"),
                sym(50, 2, None, "fn", "go", "x.y.go"),
                sym(60, 3, None, "fn", "go", "x.go"),
            ];
            if rev {
                syms.reverse();
            }
            Universe::from_parts(
                vec![
                    file(1, "m.py", "python", "m"),
                    file(2, "x/y.py", "python", "x.y"),
                    file(3, "x.py", "python", "x"),
                ],
                syms,
                vec![],
                HashMap::new(),
            )
        };
        let (a, b) = (build(false), build(true));
        let da = resolver(&a, vec![])
            .resolve(&call(1, 1, "go", ""))
            .unwrap()
            .1;
        let db = resolver(&b, vec![])
            .resolve(&call(1, 1, "go", ""))
            .unwrap()
            .1;
        assert_eq!(da, db);
        assert_eq!(da.dst, 60); // shallower QN wins the tie
    }

    #[test]
    fn negative_results_are_memoized_per_file() {
        let u = Universe::from_parts(
            vec![file(1, "a.py", "python", "a")],
            vec![sym(1, 1, None, "fn", "caller", "caller")],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        assert!(r.resolve(&call(1, 1, "nothing", "")).is_none());
        assert_eq!(
            r.memo.get(&(1, 0, String::new(), "nothing".to_string())),
            Some(&None)
        );
    }

    #[test]
    fn impl_refs_resolve_both_ends() {
        let u = Universe::from_parts(
            vec![
                file(1, "a.rs", "rust", "c::a"),
                file(2, "t.rs", "rust", "c::t"),
            ],
            vec![
                sym(1, 1, None, "struct", "Square", "Square"),
                sym(10, 2, None, "trait", "Shape", "Shape"),
            ],
            vec![],
            HashMap::new(),
        );
        let mut r = resolver(&u, vec![]);
        let rr = RefRow {
            id: 1,
            file_id: 1,
            src: None,
            kind: RefKind::Impl,
            name: "Shape".into(),
            receiver: "Square\t".into(),
        };
        let (src, d) = r.resolve(&rr).unwrap();
        assert_eq!((src, d.dst), (1, 10));
    }
}
