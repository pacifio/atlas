//! Graph persistence and the resolve pass, hooked into Phase 2's write path.
//!
//! Phase 2's writer calls, inside its write transaction:
//! `before_change(rel)` before it replaces or deletes an existing file's rows,
//! `after_write(rel, &extract.graph)` after it inserted the file's symbols,
//! `after_delete(rel)` after it removed a file, and `finish(root)` before commit.
//!
//! Incremental rule (surface-hash early cutoff, CMM `lsp_surface.c`): a changed file's own refs
//! are always re-resolved; refs elsewhere are re-resolved only when a changed file's surface
//! (symbol names/kinds/signatures, `pub use`s, `mod` decls) changed, and then only those whose
//! `name` (or type receiver) is in the added/removed/changed name set. Inbound edges of a
//! rewritten file are re-pointed at the new symbol ids by (qualified name, kind, ordinal).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::graph_extract::{GraphExtract, RefKind};
use crate::import_resolve::{
    compute_modules, install_module_aliases, resolve_imports, ProjectConfig,
};
use crate::importance;
use crate::resolve::{RefRow, Resolver};
use crate::rust_crates::CrateGraph;
use crate::universe::Universe;
use crate::IndexError;

/// Files whose change invalidates import configuration.
const CONFIG_FILES: &[&str] = &[
    "Cargo.toml",
    "package.json",
    "pnpm-workspace.yaml",
    "go.mod",
];

/// Whether a file named `name` configures import resolution: one of [`CONFIG_FILES`], or
/// any `tsconfig*.json` / `jsconfig*.json`, since `tsconfig.json` can `extends` another
/// (`tsconfig.base.json`).
pub(crate) fn is_config_file(name: &str) -> bool {
    CONFIG_FILES.contains(&name)
        || ((name.starts_with("tsconfig") || name.starts_with("jsconfig"))
            && name.ends_with(".json"))
}
/// Above this many changed files (and 30% of the index), re-resolve everything.
const INCREMENTAL_MAX_FILES: usize = 64;
const META_CRATES: &str = "graph.rust_crates";
const META_STATS: &str = "graph.last_stats";

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GraphStats {
    pub full: bool,
    pub refs_resolved: usize,
    pub edges_written: usize,
    pub edges_remapped: usize,
}

struct Inbound {
    ref_id: i64,
    src: i64,
    kind: String,
    confidence: f64,
    strategy: String,
    key: (String, String, usize),
}

struct PreImage {
    module: String,
    surface: Option<Vec<u8>>,
    names: BTreeMap<String, BTreeSet<(String, String)>>,
    inbound: Vec<Inbound>,
}

pub struct GraphBatch {
    full: bool,
    config_touched: bool,
    pre: BTreeMap<String, PreImage>,
    written: BTreeSet<String>,
    deleted: BTreeSet<String>,
}

impl GraphBatch {
    /// For `full_build`: resolve everything at `finish`.
    pub fn full() -> GraphBatch {
        GraphBatch {
            full: true,
            config_touched: false,
            pre: BTreeMap::new(),
            written: BTreeSet::new(),
            deleted: BTreeSet::new(),
        }
    }

    /// For `update_paths` / `reconcile`.
    pub fn incremental() -> GraphBatch {
        GraphBatch {
            full: false,
            ..GraphBatch::full()
        }
    }

    /// Changed paths as the watcher reported them; config files force a full resolve.
    pub fn note_paths(&mut self, changed: &[PathBuf]) {
        if changed.iter().any(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_config_file)
        }) {
            self.config_touched = true;
        }
    }

    /// A config file changed in a way no watcher path reported (seen by a
    /// reconcile's walk): resolve everything.
    pub fn note_config_change(&mut self) {
        self.config_touched = true;
    }

    /// Call before replacing or deleting the rows of an already-indexed file.
    pub fn before_change(&mut self, conn: &Connection, rel: &str) -> Result<(), IndexError> {
        if self.full || self.pre.contains_key(rel) {
            return Ok(());
        }
        let row: Option<(i64, String, Option<Vec<u8>>)> = conn
            .query_row(
                "SELECT id, module, surface_hash FROM files WHERE rel = ?1",
                [rel],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((fid, module, surface)) = row else {
            return Ok(());
        };
        let names = surface_names(conn, fid)?;
        let keys = symbol_keys(conn, fid)?;
        let mut stmt = conn.prepare(
            "SELECT e.ref_id, e.src_symbol_id, e.kind, e.confidence, e.strategy, e.dst_symbol_id
             FROM edges e JOIN symbols s ON s.id = e.dst_symbol_id JOIN refs r ON r.id = e.ref_id
             WHERE s.file_id = ?1 AND r.file_id <> ?1",
        )?;
        let inbound = stmt
            .query_map([fid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })?
            .filter_map(Result::ok)
            .filter_map(|(ref_id, src, kind, confidence, strategy, dst)| {
                keys.get(&dst).map(|key| Inbound {
                    ref_id,
                    src,
                    kind,
                    confidence,
                    strategy,
                    key: key.clone(),
                })
            })
            .collect();
        self.pre.insert(
            rel.to_string(),
            PreImage {
                module,
                surface,
                names,
                inbound,
            },
        );
        Ok(())
    }

    /// Store a file's refs, imports and `mod` declarations, and its surface hash.
    /// Call after Phase 2 inserted the file's symbols.
    pub fn after_write(
        &mut self,
        conn: &Connection,
        rel: &str,
        g: &GraphExtract,
    ) -> Result<(), IndexError> {
        let fid: i64 =
            conn.query_row("SELECT id FROM files WHERE rel = ?1", [rel], |r| r.get(0))?;
        conn.execute("DELETE FROM refs WHERE file_id = ?1", [fid])?;
        conn.execute("DELETE FROM imports WHERE file_id = ?1", [fid])?;
        conn.execute("DELETE FROM rust_mods WHERE file_id = ?1", [fid])?;
        let mut ins = conn.prepare_cached(
            "INSERT INTO imports(file_id, local_name, module_path, line, imported_name, is_pub) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for i in &g.imports {
            ins.execute(params![
                fid,
                i.local_name,
                i.module_path,
                i.line,
                i.imported_name,
                i.is_pub
            ])?;
        }
        let mut ins = conn.prepare_cached("INSERT INTO rust_mods(file_id, name, path_attr, inline_parent, line) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for m in &g.mods {
            ins.execute(params![fid, m.name, m.path_attr, m.inline_parent, m.line])?;
        }
        let spans: Vec<(i64, u32, u32)> = conn
            .prepare("SELECT id, start_byte, end_byte FROM symbols WHERE file_id = ?1 ORDER BY start_byte, end_byte DESC, id")?
            .query_map([fid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut ins = conn.prepare_cached(
            "INSERT INTO refs(file_id, src_symbol_id, kind, name, receiver, line, start_byte, end_byte) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let mut enclosing = Enclosing::new(&spans);
        for r in &g.refs {
            let src = enclosing.at(r.start_byte);
            ins.execute(params![
                fid,
                src,
                r.kind.as_str(),
                r.name,
                r.receiver,
                r.line,
                r.start_byte,
                r.end_byte
            ])?;
        }
        conn.execute(
            "UPDATE files SET surface_hash = ?2 WHERE id = ?1",
            params![fid, surface_hash(conn, fid)?],
        )?;
        self.written.insert(rel.to_string());
        Ok(())
    }

    pub fn after_delete(&mut self, rel: &str) {
        self.written.remove(rel);
        self.deleted.insert(rel.to_string());
    }

    /// Resolve and persist edges and importance. Call before committing the transaction.
    pub fn finish(self, conn: &Connection, root: &Path) -> Result<GraphStats, IndexError> {
        if self.written.is_empty() && self.deleted.is_empty() && !self.full && !self.config_touched
        {
            return Ok(GraphStats::default());
        }
        let total: usize =
            conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get::<_, i64>(0))? as usize;
        let changed = self.written.len() + self.deleted.len();
        let stats = if self.full
            || self.config_touched
            || (changed > INCREMENTAL_MAX_FILES && changed * 10 > total * 3)
        {
            resolve_all(conn, root, self.full || self.config_touched)?
        } else {
            self.resolve_incremental(conn, root)?
        };
        conn.execute(
            "INSERT INTO meta(k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![
                META_STATS,
                serde_json::to_string(&stats).unwrap_or_default()
            ],
        )?;
        Ok(stats)
    }

    fn resolve_incremental(self, conn: &Connection, root: &Path) -> Result<GraphStats, IndexError> {
        let mut u = Universe::load(conn)?;
        let mut cfg = ProjectConfig::new(root, load_crates(conn, root, false)?);
        let (modules, aliases) = compute_modules(&u, &cfg);
        let moved = u.files.iter().zip(&modules).any(|(f, m)| {
            let before = if self.written.contains(&f.rel) {
                self.pre.get(&f.rel).map(|p| p.module.as_str())
            } else {
                Some(f.module.as_str())
            };
            before.is_some_and(|b| b != m)
        });
        if moved {
            // A module moved (mod decl edit, new crate root): paths changed everywhere.
            return resolve_all(conn, root, false);
        }
        write_modules(conn, &u, &modules)?;
        u.set_modules(modules);
        install_module_aliases(&mut u, &aliases);
        let targets = resolve_imports(&u, &mut cfg);
        // A rewritten file may come back under a new id; importers' rows were SET NULL by the
        // cascade and now point at the same file again — not a binding change.
        let rewritten: BTreeSet<i64> = self
            .written
            .iter()
            .filter(|r| self.pre.contains_key(*r))
            .filter_map(|r| u.rel_ix.get(r).copied())
            .collect();
        let mut redo_files: BTreeSet<i64> = write_import_targets(conn, &u, &targets, &rewritten)?;

        let mut redo_refs: BTreeSet<i64> = BTreeSet::new();
        let mut names_delta: BTreeSet<String> = BTreeSet::new();
        let mut remapped = 0;
        for rel in &self.written {
            let Some(&fid) = u.rel_ix.get(rel) else {
                continue;
            };
            redo_files.insert(fid);
            let Some(pre) = self.pre.get(rel) else {
                let mut stmt =
                    conn.prepare("SELECT DISTINCT name FROM symbols WHERE file_id = ?1")?;
                for n in stmt.query_map([fid], |r| r.get::<_, String>(0))? {
                    names_delta.insert(n?);
                }
                continue;
            };
            let keys: HashMap<(String, String, usize), i64> = symbol_keys(conn, fid)?
                .into_iter()
                .map(|(id, k)| (k, id))
                .collect();
            for e in &pre.inbound {
                let ref_alive: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM refs WHERE id = ?1)",
                    [e.ref_id],
                    |r| r.get(0),
                )?;
                if !ref_alive {
                    continue;
                }
                match keys.get(&e.key) {
                    Some(dst) => {
                        conn.execute("DELETE FROM edges WHERE ref_id = ?1", [e.ref_id])?;
                        conn.execute(
                            "INSERT INTO edges(src_symbol_id, dst_symbol_id, ref_id, kind, confidence, strategy) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![e.src, dst, e.ref_id, e.kind, e.confidence, e.strategy],
                        )?;
                        remapped += 1;
                    }
                    None => {
                        redo_refs.insert(e.ref_id);
                    }
                }
            }
            let surface: Option<Vec<u8>> =
                conn.query_row("SELECT surface_hash FROM files WHERE id = ?1", [fid], |r| {
                    r.get(0)
                })?;
            if surface != pre.surface {
                let now = surface_names(conn, fid)?;
                for n in pre.names.keys().chain(now.keys()) {
                    if pre.names.get(n) != now.get(n) {
                        names_delta.insert(n.clone());
                    }
                }
            }
        }
        for rel in &self.deleted {
            if let Some(pre) = self.pre.get(rel) {
                names_delta.extend(pre.names.keys().cloned());
                redo_refs.extend(pre.inbound.iter().map(|e| e.ref_id));
            }
        }

        let mut refs = load_refs(
            conn,
            "WHERE file_id IN (SELECT value FROM json_each(?1))",
            Some(&json_ids(&redo_files)),
        )?;
        let typed: BTreeSet<String> = names_delta.iter().map(|n| format!("{n}::")).collect();
        refs.extend(load_refs(
            conn,
            "WHERE name IN (SELECT value FROM json_each(?1))",
            Some(&json_strs(&names_delta)),
        )?);
        refs.extend(load_refs(
            conn,
            "WHERE receiver IN (SELECT value FROM json_each(?1))",
            Some(&json_strs(&typed)),
        )?);
        refs.extend(
            load_refs(conn, "WHERE kind IN ('inherit','impl')", None)?
                .into_iter()
                .filter(|r| {
                    r.receiver
                        .split('\t')
                        .next()
                        .is_some_and(|src| names_delta.contains(src))
                }),
        );
        refs.extend(load_refs(
            conn,
            "WHERE id IN (SELECT value FROM json_each(?1))",
            Some(&json_ids(&redo_refs)),
        )?);
        // A typed chain (`~…`) reads return types and fields of files it never names.
        if !names_delta.is_empty() {
            refs.extend(load_refs(conn, "WHERE receiver LIKE '~%'", None)?);
        }
        refs.sort_by_key(|r| r.id);
        refs.dedup_by_key(|r| r.id);

        let mut resolver = Resolver::new(&u, &targets, cfg.crates.lib_names());
        let mut stats = GraphStats {
            full: false,
            refs_resolved: refs.len(),
            edges_written: 0,
            edges_remapped: remapped,
        };
        let mut del = conn.prepare_cached("DELETE FROM edges WHERE ref_id = ?1")?;
        for r in &refs {
            del.execute([r.id])?;
        }
        stats.edges_written = write_edges(conn, &mut resolver, &refs)?;
        if stats.refs_resolved > 0 || !self.deleted.is_empty() {
            importance::recompute(conn)?;
        }
        Ok(stats)
    }
}

/// Re-resolve the whole graph: modules, imports, every edge, importance.
pub(crate) fn resolve_all(
    conn: &Connection,
    root: &Path,
    refresh_crates: bool,
) -> Result<GraphStats, IndexError> {
    let mut u = Universe::load(conn)?;
    let mut cfg = ProjectConfig::new(root, load_crates(conn, root, refresh_crates)?);
    let (modules, aliases) = compute_modules(&u, &cfg);
    write_modules(conn, &u, &modules)?;
    u.set_modules(modules);
    install_module_aliases(&mut u, &aliases);
    let targets = resolve_imports(&u, &mut cfg);
    write_import_targets(conn, &u, &targets, &BTreeSet::new())?;
    conn.execute("DELETE FROM edges", [])?;
    let refs = load_refs(conn, "", None)?;
    let mut resolver = Resolver::new(&u, &targets, cfg.crates.lib_names());
    let edges_written = write_edges(conn, &mut resolver, &refs)?;
    importance::recompute(conn)?;
    Ok(GraphStats {
        full: true,
        refs_resolved: refs.len(),
        edges_written,
        edges_remapped: 0,
    })
}

/// Crate roots: cached in `meta` (cargo is a subprocess); rediscovered on `refresh`.
fn load_crates(conn: &Connection, root: &Path, refresh: bool) -> Result<CrateGraph, IndexError> {
    if !refresh {
        let cached: Option<String> = conn
            .query_row("SELECT v FROM meta WHERE k = ?1", [META_CRATES], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(g) = cached.and_then(|c| serde_json::from_str::<CrateGraph>(&c).ok()) {
            return Ok(g);
        }
    }
    let g = CrateGraph::discover(root);
    conn.execute(
        "INSERT INTO meta(k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        params![META_CRATES, serde_json::to_string(&g).unwrap_or_default()],
    )?;
    Ok(g)
}

fn write_modules(conn: &Connection, u: &Universe, modules: &[String]) -> Result<(), IndexError> {
    let mut upd = conn.prepare_cached("UPDATE files SET module = ?2 WHERE id = ?1")?;
    for (f, m) in u.files.iter().zip(modules) {
        if &f.module != m {
            upd.execute(params![f.id, m])?;
        }
    }
    Ok(())
}

/// Persist `resolved_file_id`s that changed; returns the files whose bindings moved.
fn write_import_targets(
    conn: &Connection,
    u: &Universe,
    targets: &[crate::import_resolve::ImportTarget],
    rewritten: &BTreeSet<i64>,
) -> Result<BTreeSet<i64>, IndexError> {
    let mut changed = BTreeSet::new();
    let mut upd =
        conn.prepare_cached("UPDATE imports SET resolved_file_id = ?2 WHERE rowid = ?1")?;
    for (row, t) in u.imports.iter().zip(targets) {
        if row.resolved_file_id != t.file {
            upd.execute(params![row.rowid, t.file])?;
            let reattached =
                row.resolved_file_id.is_none() && t.file.is_some_and(|f| rewritten.contains(&f));
            if !reattached {
                changed.insert(row.file_id);
            }
        }
    }
    Ok(changed)
}

/// Refs matching `filter` (`""` = all; `?1` binds `arg` when given), ascending id.
fn load_refs(
    conn: &Connection,
    filter: &str,
    arg: Option<&str>,
) -> Result<Vec<RefRow>, IndexError> {
    let sql = format!(
        "SELECT id, file_id, src_symbol_id, kind, name, receiver FROM refs {filter} ORDER BY id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(arg.iter()), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, file_id, src, kind, name, receiver) = row?;
        if let Some(kind) = RefKind::parse(&kind) {
            out.push(RefRow {
                id,
                file_id,
                src,
                kind,
                name,
                receiver,
            });
        }
    }
    Ok(out)
}

fn write_edges(
    conn: &Connection,
    resolver: &mut Resolver,
    refs: &[RefRow],
) -> Result<usize, IndexError> {
    let mut ins = conn.prepare_cached(
        "INSERT INTO edges(src_symbol_id, dst_symbol_id, ref_id, kind, confidence, strategy) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    let mut n = 0;
    for r in refs {
        if let Some((src, d)) = resolver.resolve(r) {
            ins.execute(params![
                src,
                d.dst,
                r.id,
                r.kind.as_str(),
                d.confidence as f64,
                d.strategy
            ])?;
            n += 1;
        }
    }
    Ok(n)
}

fn json_ids(ids: &BTreeSet<i64>) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".into())
}

fn json_strs(v: &BTreeSet<String>) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// symbol id → (qualified name, kind, ordinal among equal (qn, kind) in byte order).
fn symbol_keys(
    conn: &Connection,
    fid: i64,
) -> Result<HashMap<i64, (String, String, usize)>, IndexError> {
    let rows: Vec<(i64, String, String)> = conn
        .prepare("SELECT id, qualified_name, kind FROM symbols WHERE file_id = ?1 ORDER BY start_byte, id")?
        .query_map([fid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    let mut out = HashMap::new();
    for (id, qn, kind) in rows {
        let ord = seen.entry((qn.clone(), kind.clone())).or_insert(0);
        out.insert(id, (qn, kind, *ord));
        *ord += 1;
    }
    Ok(out)
}

/// Name → `(kind, signature)` of a file's symbols, plus `("field", "name: type")` under each
/// struct's name: what a change to is a change other files' resolution may see.
fn surface_names(
    conn: &Connection,
    fid: i64,
) -> Result<BTreeMap<String, BTreeSet<(String, String)>>, IndexError> {
    let mut names: BTreeMap<String, BTreeSet<(String, String)>> = BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT name, kind, signature FROM symbols WHERE file_id = ?1
         UNION ALL
         SELECT s.name, 'field', r.name || ': ' || r.receiver FROM refs r
           JOIN symbols s ON s.id = r.src_symbol_id WHERE r.file_id = ?1 AND r.kind = 'field'",
    )?;
    for row in stmt.query_map([fid], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (n, k, s) = row?;
        names.entry(n).or_default().insert((k, s));
    }
    Ok(names)
}

/// blake3 over what other files' resolution can see: symbols (qn, kind, signature, exported),
/// struct fields, `pub` imports and `mod` declarations.
fn surface_hash(conn: &Connection, fid: i64) -> Result<Vec<u8>, IndexError> {
    let mut h = blake3::Hasher::new();
    let mut stmt = conn.prepare(
        "SELECT kind, qualified_name, signature, exported FROM symbols WHERE file_id = ?1 ORDER BY qualified_name, kind, signature, exported",
    )?;
    for row in stmt.query_map([fid], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })? {
        let (k, qn, sig, exp) = row?;
        h.update(format!("s\t{k}\t{qn}\t{sig}\t{exp}\n").as_bytes());
    }
    let mut stmt = conn.prepare(
        "SELECT s.qualified_name, r.name, r.receiver FROM refs r JOIN symbols s ON s.id = r.src_symbol_id
         WHERE r.file_id = ?1 AND r.kind = 'field' ORDER BY r.start_byte",
    )?;
    for row in stmt.query_map([fid], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (owner, n, ty) = row?;
        h.update(format!("f\t{owner}\t{n}\t{ty}\n").as_bytes());
    }
    let mut stmt = conn.prepare(
        "SELECT local_name, module_path, imported_name FROM imports WHERE file_id = ?1 AND is_pub = 1 ORDER BY local_name, module_path, imported_name",
    )?;
    for row in stmt.query_map([fid], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (l, m, i) = row?;
        h.update(format!("r\t{l}\t{m}\t{i}\n").as_bytes());
    }
    let mut stmt = conn.prepare("SELECT inline_parent, name, path_attr FROM rust_mods WHERE file_id = ?1 ORDER BY inline_parent, name")?;
    for row in stmt.query_map([fid], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (p, n, a) = row?;
        h.update(format!("m\t{p}\t{n}\t{}\n", a.unwrap_or_default()).as_bytes());
    }
    Ok(h.finalize().as_bytes().to_vec())
}

/// Tightest enclosing symbol for ascending byte offsets (spans sorted by start asc, end desc).
struct Enclosing<'a> {
    spans: &'a [(i64, u32, u32)],
    next: usize,
    stack: Vec<(u32, i64)>,
}

impl<'a> Enclosing<'a> {
    fn new(spans: &'a [(i64, u32, u32)]) -> Self {
        Enclosing {
            spans,
            next: 0,
            stack: Vec::new(),
        }
    }

    fn at(&mut self, pos: u32) -> Option<i64> {
        while self.next < self.spans.len() && self.spans[self.next].1 <= pos {
            let (id, start, end) = self.spans[self.next];
            while self.stack.last().is_some_and(|(e, _)| *e <= start) {
                self.stack.pop();
            }
            self.stack.push((end, id));
            self.next += 1;
        }
        while self.stack.last().is_some_and(|(e, _)| *e <= pos) {
            self.stack.pop();
        }
        self.stack.last().map(|(_, id)| *id)
    }
}

#[cfg(test)]
mod tests {
    use super::Enclosing;

    #[test]
    fn enclosing_picks_tightest_span() {
        // impl 0..100 { fn a 10..40 { closure 20..30 } fn b 50..90 }
        let spans = [(1, 0, 100), (2, 10, 40), (3, 20, 30), (4, 50, 90)];
        let mut e = Enclosing::new(&spans);
        let got: Vec<Option<i64>> = [5, 15, 25, 35, 45, 60, 95, 120]
            .iter()
            .map(|p| e.at(*p))
            .collect();
        assert_eq!(
            got,
            vec![
                Some(1),
                Some(2),
                Some(3),
                Some(2),
                Some(1),
                Some(4),
                Some(1),
                None
            ]
        );
    }
}
