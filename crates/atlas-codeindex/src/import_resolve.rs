//! Import resolution: computes `files.module`, fills `imports.resolved_file_id`, and gives the
//! resolver each file's bindings.
//!
//! Module keys (`files.module`) per language family:
//! - rust: `crate::a::b` with the real crate name (`core_lib::engine`); `@<rel>` when no crate
//!   root reaches the file.
//! - ts/js: rel path without extension, `/index` stripped (`src/api`).
//! - python: dotted module under its package root (`app.engine`).
//! - go: the package directory (`pkg/util`, `.` for the root).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::rust_crates::{join_rel, module_tree, parent_dir, CrateGraph};
use crate::universe::{family, Universe, GO, PY, RUST, TS};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ImportTarget {
    pub file: Option<i64>,
    pub module: Option<String>,
    /// The item named inside `file` (`None` = the import names a module/package).
    pub symbol: Option<String>,
    pub glob: bool,
}

/// Filesystem-derived project configuration, cached per resolve pass.
pub(crate) struct ProjectConfig {
    root: PathBuf,
    pub crates: CrateGraph,
    ts: TsEnv,
    /// dir → (go.mod dir, module path) of the nearest go.mod.
    go_mod_of_dir: HashMap<String, Option<(String, String)>>,
}

impl ProjectConfig {
    pub(crate) fn new(root: &Path, crates: CrateGraph) -> ProjectConfig {
        ProjectConfig {
            root: root.to_path_buf(),
            crates,
            ts: TsEnv::new(root),
            go_mod_of_dir: HashMap::new(),
        }
    }

    fn go_mod(&mut self, dir: &str) -> Option<(String, String)> {
        if let Some(hit) = self.go_mod_of_dir.get(dir) {
            return hit.clone();
        }
        let path = self.root.join(dir).join("go.mod");
        let found = std::fs::read_to_string(&path).ok().and_then(|text| {
            text.lines()
                .find_map(|l| l.trim().strip_prefix("module "))
                .map(|m| (dir.to_string(), m.trim().trim_matches('"').to_string()))
        });
        let found = match found {
            Some(f) => Some(f),
            None if dir.is_empty() => None,
            None => self.go_mod(parent_dir(dir)),
        };
        self.go_mod_of_dir.insert(dir.to_string(), found.clone());
        found
    }
}

/// `files.module` for every file, aligned with `u.files`.
pub(crate) fn compute_modules(u: &Universe, cfg: &ProjectConfig) -> Vec<String> {
    let rust_files: std::collections::BTreeMap<String, i64> = u
        .files
        .iter()
        .filter(|f| family(&f.lang) == RUST)
        .map(|f| (f.rel.clone(), f.id))
        .collect();
    let tree = module_tree(&cfg.crates, &rust_files, &u.mods);
    let init_dirs = py_init_dirs(u);
    u.files
        .iter()
        .map(|f| match family(&f.lang) {
            RUST => tree
                .get(&f.id)
                .cloned()
                .unwrap_or_else(|| format!("@{}", f.rel)),
            TS => ts_module(&f.rel),
            PY => py_module(&f.rel, &init_dirs).1,
            GO => go_module(&f.rel),
            _ => f.rel.clone(),
        })
        .collect()
}

fn ts_module(rel: &str) -> String {
    let no_ext = strip_ext(rel);
    let no_ext = no_ext.strip_suffix(".d").unwrap_or(no_ext);
    match no_ext.strip_suffix("/index") {
        Some(dir) => dir.to_string(),
        None if no_ext == "index" => String::new(),
        None => no_ext.to_string(),
    }
}

fn go_module(rel: &str) -> String {
    let d = parent_dir(rel);
    if d.is_empty() {
        ".".to_string()
    } else {
        d.to_string()
    }
}

fn strip_ext(rel: &str) -> &str {
    let name_start = rel.rfind('/').map(|i| i + 1).unwrap_or(0);
    match rel[name_start..].rfind('.') {
        Some(i) => &rel[..name_start + i],
        None => rel,
    }
}

fn py_init_dirs(u: &Universe) -> HashSet<String> {
    u.files
        .iter()
        .filter(|f| family(&f.lang) == PY)
        .filter_map(|f| {
            let name = f.rel.rsplit('/').next().unwrap_or(&f.rel);
            (name == "__init__.py" || name == "__init__.pyi")
                .then(|| parent_dir(&f.rel).to_string())
        })
        .collect()
}

/// (package root dir, dotted module) for a Python file.
fn py_module(rel: &str, init_dirs: &HashSet<String>) -> (String, String) {
    let mut base = parent_dir(rel);
    while !base.is_empty() && init_dirs.contains(base) {
        base = parent_dir(base);
    }
    let tail = if base.is_empty() {
        rel
    } else {
        &rel[base.len() + 1..]
    };
    let dotted = strip_ext(tail).replace('/', ".");
    let module = match dotted.strip_suffix(".__init__") {
        Some(pkg) => pkg.to_string(),
        None if dotted == "__init__" => String::new(),
        None => dotted,
    };
    (base.to_string(), module)
}

/// Resolve every import row (aligned with `u.imports`). `u` must carry computed modules.
pub(crate) fn resolve_imports(u: &Universe, cfg: &mut ProjectConfig) -> Vec<ImportTarget> {
    let libs = cfg.crates.lib_names();
    let init_dirs = py_init_dirs(u);
    let mut py_mods: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for f in u.files.iter().filter(|f| family(&f.lang) == PY) {
        let (base, module) = py_module(&f.rel, &init_dirs);
        py_mods.entry(module).or_default().push((base, f.id));
    }
    // Every go.mod any Go file sits under, known up front so lookups don't depend on row order.
    let go_dirs: BTreeSet<String> = u
        .files
        .iter()
        .filter(|f| family(&f.lang) == GO)
        .map(|f| parent_dir(&f.rel).to_string())
        .collect();
    let mut go_mods: Vec<(String, String)> = go_dirs.iter().filter_map(|d| cfg.go_mod(d)).collect();
    go_mods.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.cmp(b)));
    go_mods.dedup();

    let mut out: Vec<ImportTarget> = u
        .imports
        .iter()
        .map(|row| {
            let f = u.file(row.file_id);
            match family(&f.lang) {
                RUST => rust_target(u, &libs, &f.module, &row.module_path, &row.local_name),
                TS => {
                    if row.module_path.is_empty() {
                        return ImportTarget::default();
                    }
                    let file = cfg.ts.resolve(&f.rel, &row.module_path, &u.rel_ix);
                    let symbol = match row.imported_name.as_str() {
                        "" | "*" => None,
                        s => Some(s.to_string()),
                    };
                    ImportTarget {
                        file,
                        module: file.map(|id| u.file(id).module.clone()),
                        symbol,
                        glob: row.local_name == "*",
                    }
                }
                PY => py_target(u, &py_mods, &init_dirs, &f.rel, row),
                GO => go_target(u, &go_mods, &row.module_path, &row.local_name),
                _ => ImportTarget::default(),
            }
        })
        .collect();

    // Follow re-exports (`pub use`, `export … from`, `__init__.py`) to the defining file.
    let graph = ReexportGraph::new(u, &out);
    for t in out.iter_mut() {
        let (Some(file), Some(sym)) = (t.file, t.symbol.clone()) else {
            continue;
        };
        if sym == "default" || u.has_sym(file, &sym) {
            continue;
        }
        if let Some(found) = graph.chase(file, &sym) {
            t.file = Some(found);
            t.module = Some(u.file(found).module.clone());
        }
    }
    out
}

/// Re-export edges by file: what each file passes on, by local name and by glob.
pub(crate) struct ReexportGraph<'u> {
    u: &'u Universe,
    named: HashMap<(i64, String), Vec<(i64, String)>>,
    globs: HashMap<i64, Vec<i64>>,
}

impl<'u> ReexportGraph<'u> {
    pub(crate) fn new(u: &'u Universe, targets: &[ImportTarget]) -> ReexportGraph<'u> {
        let mut named: HashMap<(i64, String), Vec<(i64, String)>> = HashMap::new();
        let mut globs: HashMap<i64, Vec<i64>> = HashMap::new();
        for (row, t) in u.imports.iter().zip(targets) {
            let f = u.file(row.file_id);
            let is_init = f.rel.ends_with("__init__.py") || f.rel.ends_with("__init__.pyi");
            if !(row.is_pub || is_init) {
                continue;
            }
            let Some(target) = t.file else { continue };
            if row.local_name == "*" {
                globs.entry(row.file_id).or_default().push(target);
            } else if !row.local_name.is_empty() {
                let inner = t.symbol.clone().unwrap_or_else(|| row.local_name.clone());
                named
                    .entry((row.file_id, row.local_name.clone()))
                    .or_default()
                    .push((target, inner));
            }
        }
        ReexportGraph { u, named, globs }
    }

    /// The file that defines `name` as re-exported by `file` (≤ 8 hops, cycle-safe).
    pub(crate) fn chase(&self, file: i64, name: &str) -> Option<i64> {
        let mut seen = HashSet::new();
        self.chase_inner(file, name, 0, &mut seen)
    }

    fn chase_inner(
        &self,
        file: i64,
        name: &str,
        depth: u8,
        seen: &mut HashSet<(i64, String)>,
    ) -> Option<i64> {
        if depth > 8 || !seen.insert((file, name.to_string())) {
            return None;
        }
        if let Some(hops) = self.named.get(&(file, name.to_string())) {
            for (target, inner) in hops {
                if self.u.has_sym(*target, inner) {
                    return Some(*target);
                }
                if let Some(f) = self.chase_inner(*target, inner, depth + 1, seen) {
                    return Some(f);
                }
            }
        }
        for target in self.globs.get(&file).into_iter().flatten() {
            if self.u.has_sym(*target, name) {
                return Some(*target);
            }
            if let Some(f) = self.chase_inner(*target, name, depth + 1, seen) {
                return Some(f);
            }
        }
        None
    }
}

/// Absolute module path segments for a Rust path used in a file whose module is `module`.
pub(crate) fn rust_abs(
    u: &Universe,
    libs: &BTreeSet<String>,
    module: &str,
    segs: &[&str],
) -> Option<Vec<String>> {
    let first = *segs.first()?;
    let mods: Vec<&str> = if module.starts_with('@') {
        Vec::new()
    } else {
        module.split("::").collect()
    };
    let owned = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match first {
        "crate" => {
            let mut v = owned(mods.get(..1)?);
            v.extend(owned(&segs[1..]));
            Some(v)
        }
        "self" => {
            if mods.is_empty() {
                return None;
            }
            let mut v = owned(&mods);
            v.extend(owned(&segs[1..]));
            Some(v)
        }
        "super" => {
            let k = segs.iter().take_while(|s| **s == "super").count();
            if k >= mods.len() {
                return None;
            }
            let mut v = owned(&mods[..mods.len() - k]);
            v.extend(owned(&segs[k..]));
            Some(v)
        }
        _ => {
            if !mods.is_empty()
                && !u
                    .files_of_module(RUST, &format!("{module}::{first}"))
                    .is_empty()
            {
                let mut v = owned(&mods);
                v.extend(owned(segs));
                Some(v)
            } else if libs.contains(first) {
                Some(owned(segs))
            } else {
                None
            }
        }
    }
}

/// Longest prefix of `abs` that is a module: (its first file, module key, remaining segments).
pub(crate) fn rust_longest_module(
    u: &Universe,
    abs: &[String],
) -> Option<(i64, String, Vec<String>)> {
    (1..=abs.len()).rev().find_map(|k| {
        let m = abs[..k].join("::");
        u.files_of_module(RUST, &m)
            .first()
            .map(|fid| (*fid, m, abs[k..].to_vec()))
    })
}

fn rust_target(
    u: &Universe,
    libs: &BTreeSet<String>,
    module: &str,
    path: &str,
    local: &str,
) -> ImportTarget {
    let segs: Vec<&str> = path.split("::").filter(|s| !s.is_empty()).collect();
    let Some(abs) = rust_abs(u, libs, module, &segs) else {
        return ImportTarget::default();
    };
    let Some((file, m, rest)) = rust_longest_module(u, &abs) else {
        return ImportTarget::default();
    };
    let glob = local == "*";
    let symbol = match (rest.first(), rest.last()) {
        (None, _) => None,
        (Some(first), Some(last)) => Some(if u.has_sym(file, last) {
            last.clone()
        } else {
            first.clone()
        }),
        _ => None,
    };
    ImportTarget {
        file: Some(file),
        module: Some(m),
        symbol,
        glob,
    }
}

fn py_target(
    u: &Universe,
    py_mods: &HashMap<String, Vec<(String, i64)>>,
    init_dirs: &HashSet<String>,
    importer_rel: &str,
    row: &crate::universe::ImportRow,
) -> ImportTarget {
    let (base, importer_mod) = py_module(importer_rel, init_dirs);
    let dots = row.module_path.chars().take_while(|c| *c == '.').count();
    let rest = &row.module_path[dots..];
    let abs = if dots == 0 {
        rest.to_string()
    } else {
        let is_init =
            importer_rel.ends_with("__init__.py") || importer_rel.ends_with("__init__.pyi");
        let mut pkg: Vec<&str> = importer_mod.split('.').filter(|s| !s.is_empty()).collect();
        if !is_init {
            pkg.pop();
        }
        for _ in 1..dots {
            if pkg.pop().is_none() {
                return ImportTarget::default();
            }
        }
        if !rest.is_empty() {
            pkg.push(rest);
        }
        pkg.join(".")
    };
    let find = |m: &str| -> Option<i64> {
        let cands = py_mods.get(m)?;
        cands
            .iter()
            .find(|(b, _)| *b == base)
            .or_else(|| cands.iter().find(|(b, _)| b.is_empty()))
            .or_else(|| cands.first())
            .map(|(_, id)| *id)
    };
    let module_target = |m: &str, symbol: Option<String>, glob: bool| match find(m) {
        Some(id) => ImportTarget {
            file: Some(id),
            module: Some(u.file(id).module.clone()),
            symbol,
            glob,
        },
        None => ImportTarget::default(),
    };
    if row.local_name == "*" {
        return module_target(&abs, None, true);
    }
    if row.imported_name == "*" {
        return module_target(&abs, None, false);
    }
    let sub = if abs.is_empty() {
        row.imported_name.clone()
    } else {
        format!("{abs}.{}", row.imported_name)
    };
    if find(&sub).is_some() {
        return module_target(&sub, None, false);
    }
    module_target(&abs, Some(row.imported_name.clone()), false)
}

fn go_target(u: &Universe, go_mods: &[(String, String)], path: &str, local: &str) -> ImportTarget {
    for (dir, module) in go_mods {
        let sub = if path == module {
            ""
        } else if let Some(s) = path
            .strip_prefix(module.as_str())
            .and_then(|s| s.strip_prefix('/'))
        {
            s
        } else {
            continue;
        };
        let Some(pkg_dir) = join_rel(dir, sub) else {
            continue;
        };
        let key = if pkg_dir.is_empty() {
            ".".to_string()
        } else {
            pkg_dir
        };
        if let Some(first) = u.files_of_module(GO, &key).first() {
            return ImportTarget {
                file: Some(*first),
                module: Some(key),
                symbol: None,
                glob: local == "*",
            };
        }
    }
    ImportTarget::default()
}

// ── TypeScript / JavaScript ─────────────────────────────────────────────────

const TS_EXTS: &[&str] = &[".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

struct TsConfig {
    base_url: Option<String>,
    paths: Vec<(String, Vec<String>)>,
    paths_base: String,
}

struct WsPkg {
    name: String,
    dir: String,
    entries: Vec<String>,
}

struct TsEnv {
    root: PathBuf,
    by_dir: HashMap<String, Option<Rc<TsConfig>>>,
    workspaces: Option<Vec<WsPkg>>,
}

impl TsEnv {
    fn new(root: &Path) -> TsEnv {
        TsEnv {
            root: root.to_path_buf(),
            by_dir: HashMap::new(),
            workspaces: None,
        }
    }

    fn resolve(&mut self, from_rel: &str, spec: &str, files: &HashMap<String, i64>) -> Option<i64> {
        let dir = parent_dir(from_rel).to_string();
        if spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == ".." {
            return join_rel(&dir, spec).and_then(|p| probe(files, &p));
        }
        if let Some(cfg) = self.nearest(&dir) {
            let mut matches: Vec<(usize, &str, &Vec<String>)> = cfg
                .paths
                .iter()
                .filter_map(|(pat, subs)| match pat.split_once('*') {
                    None => (pat == spec).then_some((usize::MAX, "", subs)),
                    Some((pre, suf)) => (spec.len() >= pre.len() + suf.len()
                        && spec.starts_with(pre)
                        && spec.ends_with(suf))
                    .then(|| (pre.len(), &spec[pre.len()..spec.len() - suf.len()], subs)),
                })
                .collect();
            matches.sort_by(|a, b| b.0.cmp(&a.0));
            for (_, captured, subs) in matches {
                for sub in subs {
                    let target = sub.replacen('*', captured, 1);
                    if let Some(id) =
                        join_rel(&cfg.paths_base, &target).and_then(|p| probe(files, &p))
                    {
                        return Some(id);
                    }
                }
            }
            if let Some(base) = &cfg.base_url {
                if let Some(id) = join_rel(base, spec).and_then(|p| probe(files, &p)) {
                    return Some(id);
                }
            }
        }
        let ws = self.workspaces();
        let mut best: Option<&WsPkg> = None;
        for p in ws {
            if (spec == p.name || spec.starts_with(&format!("{}/", p.name)))
                && best.is_none_or(|b| p.name.len() > b.name.len())
            {
                best = Some(p);
            }
        }
        let pkg = best?;
        let sub = spec[pkg.name.len()..].trim_start_matches('/');
        if sub.is_empty() {
            let mut cands: Vec<String> = pkg
                .entries
                .iter()
                .filter_map(|e| join_rel(&pkg.dir, e))
                .collect();
            cands.extend([
                format!("{}/src/index", pkg.dir),
                format!("{}/index", pkg.dir),
            ]);
            return cands.iter().find_map(|c| probe(files, c));
        }
        [
            join_rel(&pkg.dir, sub),
            join_rel(&pkg.dir, &format!("src/{sub}")),
        ]
        .into_iter()
        .flatten()
        .find_map(|c| probe(files, &c))
    }

    fn nearest(&mut self, dir: &str) -> Option<Rc<TsConfig>> {
        if let Some(hit) = self.by_dir.get(dir) {
            return hit.clone();
        }
        let here = ["tsconfig.json", "jsconfig.json"]
            .iter()
            .map(|n| {
                if dir.is_empty() {
                    n.to_string()
                } else {
                    format!("{dir}/{n}")
                }
            })
            .find(|rel| self.root.join(rel).is_file())
            .and_then(|rel| self.load(&rel, 0))
            .map(Rc::new);
        let found = match here {
            Some(c) => Some(c),
            None if dir.is_empty() => None,
            None => self.nearest(parent_dir(dir)),
        };
        self.by_dir.insert(dir.to_string(), found.clone());
        found
    }

    fn load(&self, rel: &str, depth: u8) -> Option<TsConfig> {
        let text = std::fs::read_to_string(self.root.join(rel)).ok()?;
        let v: serde_json::Value = serde_json::from_str(&strip_jsonc(&text)).ok()?;
        let dir = parent_dir(rel);
        let parent = match v.get("extends").and_then(|e| e.as_str()) {
            Some(ext) if depth < 3 && ext.starts_with('.') => {
                let ext = if ext.ends_with(".json") {
                    ext.to_string()
                } else {
                    format!("{ext}.json")
                };
                join_rel(dir, &ext).and_then(|p| self.load(&p, depth + 1))
            }
            _ => None,
        };
        let co = v.get("compilerOptions");
        let base_url = co
            .and_then(|c| c.get("baseUrl"))
            .and_then(|b| b.as_str())
            .and_then(|b| join_rel(dir, b));
        let paths: Vec<(String, Vec<String>)> = co
            .and_then(|c| c.get("paths"))
            .and_then(|p| p.as_object())
            .map(|m| {
                m.iter()
                    .map(|(k, v)| {
                        let subs = v
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|s| s.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default();
                        (k.clone(), subs)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (paths, paths_base) = if paths.is_empty() {
            match &parent {
                Some(p) => (p.paths.clone(), p.paths_base.clone()),
                None => (Vec::new(), String::new()),
            }
        } else {
            let base = base_url.clone().unwrap_or_else(|| dir.to_string());
            (paths, base)
        };
        let base_url = base_url.or_else(|| parent.as_ref().and_then(|p| p.base_url.clone()));
        Some(TsConfig {
            base_url,
            paths,
            paths_base,
        })
    }

    fn workspaces(&mut self) -> &[WsPkg] {
        if self.workspaces.is_none() {
            self.workspaces = Some(load_workspaces(&self.root));
        }
        self.workspaces.as_deref().unwrap_or(&[])
    }
}

fn probe(files: &HashMap<String, i64>, p: &str) -> Option<i64> {
    if let Some(id) = files.get(p) {
        return Some(*id);
    }
    for e in TS_EXTS {
        if let Some(id) = files.get(&format!("{p}{e}")) {
            return Some(*id);
        }
    }
    // TS ESM style: `./a.js` names `a.ts`.
    for (js, ts_exts) in [
        (".js", &[".ts", ".tsx"][..]),
        (".jsx", &[".tsx"][..]),
        (".mjs", &[".mts"][..]),
        (".cjs", &[".cts"][..]),
    ] {
        if let Some(stem) = p.strip_suffix(js) {
            for t in ts_exts {
                if let Some(id) = files.get(&format!("{stem}{t}")) {
                    return Some(*id);
                }
            }
        }
    }
    for e in TS_EXTS {
        if let Some(id) = files.get(&format!("{p}/index{e}")) {
            return Some(*id);
        }
    }
    None
}

fn load_workspaces(root: &Path) -> Vec<WsPkg> {
    let mut patterns: Vec<String> = Vec::new();
    if let Some(v) = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    {
        let ws = v.get("workspaces");
        let arr = ws.and_then(|w| w.as_array()).or_else(|| {
            ws.and_then(|w| w.get("packages"))
                .and_then(|p| p.as_array())
        });
        patterns.extend(
            arr.into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_string)),
        );
    }
    if let Ok(yaml) = std::fs::read_to_string(root.join("pnpm-workspace.yaml")) {
        let mut in_packages = false;
        for line in yaml.lines() {
            let t = line.trim();
            if t.starts_with("packages:") {
                in_packages = true;
            } else if in_packages {
                match t.strip_prefix('-') {
                    Some(item) => patterns.push(
                        item.trim()
                            .trim_matches(|c| c == '\'' || c == '"')
                            .to_string(),
                    ),
                    None if t.is_empty() || t.starts_with('#') => {}
                    None => in_packages = false,
                }
            }
        }
    }
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    for pat in patterns.iter().filter(|p| !p.starts_with('!')) {
        let pat = pat.trim_end_matches('/');
        match pat.strip_suffix("/**").or_else(|| pat.strip_suffix("/*")) {
            Some(prefix) => {
                for e in std::fs::read_dir(root.join(prefix))
                    .into_iter()
                    .flatten()
                    .flatten()
                {
                    if e.path().is_dir() {
                        if let Some(name) = e.file_name().to_str() {
                            dirs.insert(format!("{prefix}/{name}"));
                        }
                    }
                }
            }
            None => {
                dirs.insert(pat.to_string());
            }
        }
    }
    let mut out = Vec::new();
    for dir in dirs {
        let Some(v) = std::fs::read_to_string(root.join(&dir).join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        else {
            continue;
        };
        let Some(name) = v.get("name").and_then(|n| n.as_str()) else {
            continue;
        };
        let mut entries: Vec<String> = ["types", "typings", "module", "main"]
            .iter()
            .filter_map(|k| v.get(*k).and_then(|x| x.as_str()).map(str::to_string))
            .collect();
        if let Some(exp) = v.get("exports") {
            let dot = exp.get(".").unwrap_or(exp);
            if let Some(s) = dot.as_str() {
                entries.push(s.to_string());
            }
            for k in ["types", "import", "default"] {
                if let Some(s) = dot.get(k).and_then(|x| x.as_str()) {
                    entries.push(s.to_string());
                }
            }
        }
        out.push(WsPkg {
            name: name.to_string(),
            dir,
            entries,
        });
    }
    out
}

/// JSON with comments and trailing commas (tsconfig) → JSON.
pub(crate) fn strip_jsonc(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == b'\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                in_str = true;
                out.push(c);
                i += 1;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b',' => {
                let mut j = i + 1;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if !matches!(b.get(j), Some(b'}') | Some(b']')) {
                    out.push(c);
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
