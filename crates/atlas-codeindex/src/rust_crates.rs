//! Rust crate roots and the real module tree (`crate::a::b`), which CMM only approximates.
//!
//! Crate roots come from `cargo metadata --format-version 1 --no-deps --offline` (every target's
//! `src_path`). When cargo is missing or fails (GUI apps on macOS often lack the shell PATH),
//! the same roots are read from the `Cargo.toml` files directly.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::graph_extract::RawMod;

const CARGO_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct CrateRoot {
    /// Name as written in paths: `-` → `_`.
    pub name: String,
    /// Project-relative, `/`-separated root file (`crates/x/src/lib.rs`).
    pub root_rel: String,
    /// A library target: other crates can name it (`atlas_search::compact`).
    pub is_lib: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrateGraph {
    /// Sorted: libs first, then by name, then by root file.
    pub roots: Vec<CrateRoot>,
}

impl CrateGraph {
    /// Crate roots for every Cargo project at `root` or one directory below it (a Tauri app's
    /// `src-tauri/`). `cargo metadata` first, manifests as the fallback.
    pub fn discover(root: &Path) -> CrateGraph {
        let mut roots = BTreeSet::new();
        for manifest in top_manifests(root) {
            let graph = cargo_metadata(&manifest)
                .and_then(|json| CrateGraph::from_metadata_json(&json, root))
                .unwrap_or_else(|| {
                    let dir = manifest.parent().unwrap_or(root);
                    CrateGraph::from_manifests(root, dir)
                });
            roots.extend(graph.roots);
        }
        CrateGraph::from_roots(roots)
    }

    fn from_roots(roots: impl IntoIterator<Item = CrateRoot>) -> CrateGraph {
        let mut roots: Vec<CrateRoot> = roots
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        roots.sort_by(|a, b| {
            (!a.is_lib, &a.name, &a.root_rel).cmp(&(!b.is_lib, &b.name, &b.root_rel))
        });
        CrateGraph { roots }
    }

    /// Parse `cargo metadata --format-version 1` output. Targets outside `root` are dropped.
    pub fn from_metadata_json(json: &str, root: &Path) -> Option<CrateGraph> {
        #[derive(Deserialize)]
        struct Meta {
            packages: Vec<Package>,
        }
        #[derive(Deserialize)]
        struct Package {
            targets: Vec<Target>,
        }
        #[derive(Deserialize)]
        struct Target {
            name: String,
            kind: Vec<String>,
            src_path: PathBuf,
        }
        let meta: Meta = serde_json::from_str(json).ok()?;
        let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut roots = Vec::new();
        for t in meta.packages.into_iter().flat_map(|p| p.targets) {
            let src = t.src_path.canonicalize().unwrap_or(t.src_path);
            let Ok(rel) = src.strip_prefix(&canon_root) else {
                continue;
            };
            let is_lib = t.kind.iter().any(|k| {
                matches!(
                    k.as_str(),
                    "lib" | "rlib" | "dylib" | "cdylib" | "staticlib" | "proc-macro"
                )
            });
            roots.push(CrateRoot {
                name: t.name.replace('-', "_"),
                root_rel: rel_string(rel),
                is_lib,
            });
        }
        Some(CrateGraph::from_roots(roots))
    }

    /// Fallback: read `<dir>/Cargo.toml` (+ workspace members) without cargo.
    pub fn from_manifests(root: &Path, dir: &Path) -> CrateGraph {
        let mut roots = Vec::new();
        let Some(top) = read_toml(&dir.join("Cargo.toml")) else {
            return CrateGraph::default();
        };
        let mut package_dirs: BTreeSet<PathBuf> = BTreeSet::new();
        if top.get("package").is_some() {
            package_dirs.insert(dir.to_path_buf());
        }
        if let Some(ws) = top.get("workspace").and_then(|w| w.as_table()) {
            let excluded: BTreeSet<PathBuf> = str_array(ws.get("exclude"))
                .iter()
                .map(|e| dir.join(e))
                .collect();
            for member in str_array(ws.get("members")) {
                for d in expand_member(dir, &member) {
                    if !excluded.contains(&d) && d.join("Cargo.toml").is_file() {
                        package_dirs.insert(d);
                    }
                }
            }
        }
        for pkg_dir in package_dirs {
            let Some(manifest) = read_toml(&pkg_dir.join("Cargo.toml")) else {
                continue;
            };
            let Some(pkg_name) = manifest
                .get("package")
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
            else {
                continue;
            };
            let mut add = |name: &str, path: PathBuf, is_lib: bool| {
                if let Ok(rel) = path.strip_prefix(root) {
                    if path.is_file() {
                        roots.push(CrateRoot {
                            name: name.replace('-', "_"),
                            root_rel: rel_string(rel),
                            is_lib,
                        });
                    }
                }
            };
            let lib = manifest.get("lib");
            let lib_name = lib
                .and_then(|l| l.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or(pkg_name);
            let lib_path = lib
                .and_then(|l| l.get("path"))
                .and_then(|p| p.as_str())
                .unwrap_or("src/lib.rs");
            add(lib_name, pkg_dir.join(lib_path), true);
            let bins = manifest.get("bin").and_then(|b| b.as_array());
            for b in bins.into_iter().flatten() {
                let name = b.get("name").and_then(|n| n.as_str()).unwrap_or(pkg_name);
                let default = format!("src/bin/{name}.rs");
                let path = b.get("path").and_then(|p| p.as_str()).unwrap_or(&default);
                add(name, pkg_dir.join(path), false);
            }
            add(pkg_name, pkg_dir.join("src/main.rs"), false);
            for sub in ["src/bin", "tests", "examples", "benches"] {
                for file in rs_files(&pkg_dir.join(sub)) {
                    let stem = file
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    add(&stem, file, false);
                }
            }
        }
        CrateGraph::from_roots(roots)
    }

    /// Names other crates can use in paths.
    pub fn lib_names(&self) -> BTreeSet<String> {
        self.roots
            .iter()
            .filter(|r| r.is_lib)
            .map(|r| r.name.clone())
            .collect()
    }
}

/// `Cargo.toml` at `root`, else at each direct subdirectory (sorted).
fn top_manifests(root: &Path) -> Vec<PathBuf> {
    let top = root.join("Cargo.toml");
    if top.is_file() {
        return vec![top];
    }
    let mut out: Vec<PathBuf> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join("Cargo.toml"))
        .filter(|p| p.is_file())
        .collect();
    out.sort();
    out
}

fn cargo_candidates() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "cargo.exe" } else { "cargo" };
    let mut v = vec![PathBuf::from("cargo")];
    if let Some(home) = std::env::var_os("CARGO_HOME") {
        v.push(PathBuf::from(home).join("bin").join(exe));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        v.push(PathBuf::from(home).join(".cargo").join("bin").join(exe));
    }
    v
}

/// Run `cargo metadata` with a hard timeout. `None` on any failure.
fn cargo_metadata(manifest: &Path) -> Option<String> {
    for cargo in cargo_candidates() {
        let mut cmd = atlas_process::command(&cargo);
        cmd.args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--offline",
            "--manifest-path",
        ])
        .arg(manifest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        let Ok(mut child) = cmd.spawn() else { continue };
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stdout.read_to_string(&mut s);
            s
        });
        let deadline = Instant::now() + CARGO_TIMEOUT;
        let ok = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        let text = reader.join().ok()?;
        return ok.then_some(text);
    }
    None
}

fn read_toml(path: &Path) -> Option<toml::Table> {
    toml::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn str_array(v: Option<&toml::Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `crates/*` → every subdirectory of `crates/`; anything else is a literal directory.
fn expand_member(dir: &Path, member: &str) -> Vec<PathBuf> {
    let member = member.trim_end_matches('/');
    match member
        .strip_suffix("/*")
        .or_else(|| member.strip_suffix("/**"))
    {
        Some(prefix) => {
            let mut v: Vec<PathBuf> = std::fs::read_dir(dir.join(prefix))
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            v.sort();
            v
        }
        None => vec![dir.join(member)],
    }
}

fn rs_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "rs"))
        .collect();
    v.sort();
    v
}

fn rel_string(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// `/`-path helpers over project-relative paths.
pub(crate) fn parent_dir(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

pub(crate) fn file_stem(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rfind('.').map(|i| &name[..i]).unwrap_or(name)
}

/// Join `base` (a directory) and `tail`, resolving `.`/`..`. `None` if it escapes the root.
pub(crate) fn join_rel(base: &str, tail: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in base.split('/').chain(tail.split('/')) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// Module path for every Rust file reachable from a crate root through `mod` declarations.
/// `files`: rel → file id (Rust files only). `mods`: file id → its `mod x;` declarations.
pub fn module_tree(
    graph: &CrateGraph,
    files: &BTreeMap<String, i64>,
    mods: &HashMap<i64, Vec<RawMod>>,
) -> BTreeMap<i64, String> {
    let rel_of: HashMap<i64, &str> = files.iter().map(|(r, id)| (*id, r.as_str())).collect();
    let mut assigned: BTreeMap<i64, String> = BTreeMap::new();
    let mut queue: VecDeque<(i64, String)> = VecDeque::new();
    for root in &graph.roots {
        if let Some(&id) = files.get(&root.root_rel) {
            if !assigned.contains_key(&id) {
                // A bin/test/example crate is its own crate even when it shares the lib's name.
                let name = if root.is_lib {
                    root.name.clone()
                } else {
                    format!("{}#bin", root.name)
                };
                assigned.insert(id, name.clone());
                queue.push_back((id, name));
            }
        }
    }
    let crate_roots: BTreeSet<&str> = graph.roots.iter().map(|r| r.root_rel.as_str()).collect();
    while let Some((id, module)) = queue.pop_front() {
        let rel = rel_of[&id];
        let dir = parent_dir(rel);
        let mod_rs = crate_roots.contains(rel) || rel.ends_with("/mod.rs") || rel == "mod.rs";
        let base = if mod_rs {
            dir.to_string()
        } else {
            join_rel(dir, file_stem(rel)).unwrap_or_default()
        };
        let mut decls: Vec<&RawMod> = mods
            .get(&id)
            .map(|v| v.iter().collect())
            .unwrap_or_default();
        decls.sort_by(|a, b| (a.line, &a.name).cmp(&(b.line, &b.name)));
        for m in decls {
            let inline: Vec<&str> = m
                .inline_parent
                .split("::")
                .filter(|s| !s.is_empty())
                .collect();
            let inline_dir = inline.join("/");
            let candidates: Vec<String> = match (&m.path_attr, inline.is_empty()) {
                (Some(p), true) => join_rel(dir, p).into_iter().collect(),
                (Some(p), false) => join_rel(&base, &format!("{inline_dir}/{p}"))
                    .into_iter()
                    .collect(),
                (None, _) => {
                    let d = join_rel(&base, &inline_dir).unwrap_or_default();
                    [format!("{}.rs", m.name), format!("{}/mod.rs", m.name)]
                        .iter()
                        .filter_map(|t| join_rel(&d, t))
                        .collect()
                }
            };
            let Some(child) = candidates.iter().find_map(|c| files.get(c)) else {
                continue;
            };
            if assigned.contains_key(child) {
                continue;
            }
            let mut child_mod = module.clone();
            for seg in inline.iter().chain(std::iter::once(&m.name.as_str())) {
                child_mod.push_str("::");
                child_mod.push_str(seg);
            }
            assigned.insert(*child, child_mod.clone());
            queue.push_back((*child, child_mod));
        }
    }
    assigned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_fixtures::{write_tree, RUST_WORKSPACE};

    fn rm(name: &str, path: Option<&str>, inline: &str) -> RawMod {
        RawMod {
            name: name.into(),
            path_attr: path.map(str::to_string),
            inline_parent: inline.into(),
            line: 1,
        }
    }

    #[test]
    fn metadata_json_maps_targets_to_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let json = serde_json::json!({
            "packages": [{
                "name": "my-app",
                "targets": [
                    { "name": "my_app", "kind": ["lib"], "src_path": root.join("app/src/lib.rs") },
                    { "name": "my-app", "kind": ["bin"], "src_path": root.join("app/src/main.rs") },
                    { "name": "outside", "kind": ["lib"], "src_path": "/elsewhere/src/lib.rs" }
                ]
            }]
        })
        .to_string();
        let g = CrateGraph::from_metadata_json(&json, &root).unwrap();
        assert_eq!(
            g.roots,
            vec![
                CrateRoot {
                    name: "my_app".into(),
                    root_rel: "app/src/lib.rs".into(),
                    is_lib: true
                },
                CrateRoot {
                    name: "my_app".into(),
                    root_rel: "app/src/main.rs".into(),
                    is_lib: false
                },
            ]
        );
    }

    #[test]
    fn manifest_fallback_reads_workspace_members() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), RUST_WORKSPACE);
        let g = CrateGraph::from_manifests(dir.path(), dir.path());
        let names: Vec<(&str, &str, bool)> = g
            .roots
            .iter()
            .map(|r| (r.name.as_str(), r.root_rel.as_str(), r.is_lib))
            .collect();
        assert_eq!(
            names,
            vec![
                ("core_lib", "crates/core-lib/src/lib.rs", true),
                ("tool", "crates/tool/src/lib.rs", true),
                ("tool", "crates/tool/src/main.rs", false),
            ]
        );
    }

    #[test]
    fn cargo_and_manifest_fallback_agree() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), RUST_WORKSPACE);
        let root = dir.path().canonicalize().unwrap();
        let discovered = CrateGraph::discover(&root);
        assert_eq!(discovered, CrateGraph::from_manifests(&root, &root));
    }

    #[test]
    fn module_tree_handles_mod_rs_lib_rs_path_attr_and_inline() {
        let files: BTreeMap<String, i64> = [
            ("c/src/lib.rs", 1),
            ("c/src/a.rs", 2),
            ("c/src/a/b.rs", 3),
            ("c/src/net/mod.rs", 4),
            ("c/src/net/tcp.rs", 5),
            ("c/src/gen/x_impl.rs", 6),
            ("c/src/outer/inner.rs", 7),
            ("c/src/orphan.rs", 8),
        ]
        .into_iter()
        .map(|(r, i)| (r.to_string(), i))
        .collect();
        let mut mods = HashMap::new();
        mods.insert(
            1,
            vec![
                rm("a", None, ""),
                rm("net", None, ""),
                rm("x", Some("gen/x_impl.rs"), ""),
                rm("inner", None, "outer"),
            ],
        );
        mods.insert(2, vec![rm("b", None, "")]);
        mods.insert(4, vec![rm("tcp", None, "")]);
        let graph = CrateGraph {
            roots: vec![CrateRoot {
                name: "c".into(),
                root_rel: "c/src/lib.rs".into(),
                is_lib: true,
            }],
        };
        let t = module_tree(&graph, &files, &mods);
        let want: BTreeMap<i64, String> = [
            (1, "c"),
            (2, "c::a"),
            (3, "c::a::b"),
            (4, "c::net"),
            (5, "c::net::tcp"),
            (6, "c::x"),
            (7, "c::outer::inner"),
        ]
        .into_iter()
        .map(|(i, m)| (i, m.to_string()))
        .collect();
        assert_eq!(t, want);
    }

    #[test]
    fn join_rel_normalizes_and_refuses_escape() {
        assert_eq!(join_rel("a/b", "../c.rs").as_deref(), Some("a/c.rs"));
        assert_eq!(join_rel("", "./x/y.rs").as_deref(), Some("x/y.rs"));
        assert_eq!(join_rel("a", "../../x"), None);
    }
}
