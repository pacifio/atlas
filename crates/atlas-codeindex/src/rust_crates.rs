//! Rust crate roots and the real module tree (`crate::a::b`), which CMM only approximates.
//!
//! Crate roots come from `cargo metadata --format-version 1 --no-deps --offline` (every target's
//! `src_path`). When cargo is missing or fails (GUI apps on macOS often lack the shell PATH),
//! the same roots are read from the `Cargo.toml` files directly.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::graph_extract::RawMod;

const CARGO_TIMEOUT: Duration = Duration::from_secs(20);
/// How deep below the project root a workspace's `Cargo.toml` is looked for.
const MANIFEST_DEPTH: usize = 4;

/// The names a Rust path can start with to reach a workspace library, each
/// mapped to that library's own name (see [`CrateGraph::lib_names`]).
pub(crate) type Libs = BTreeMap<String, String>;

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
    /// Renamed dependencies on a workspace library (`alpha2 = { package =
    /// "alpha" }`): the name paths use (`alpha2`) → the library's (`alpha`).
    #[serde(default)]
    pub aliases: BTreeMap<String, String>,
}

impl CrateGraph {
    /// Crate roots for every Cargo project at `root` or below it (a Tauri app's `src-tauri/`,
    /// a workspace in `rust/ws/`; see [`top_manifests`]). `cargo metadata` first, manifests
    /// as the fallback.
    pub fn discover(root: &Path) -> CrateGraph {
        let mut roots = BTreeSet::new();
        let mut aliases = BTreeMap::new();
        for manifest in top_manifests(root) {
            let graph = cargo_metadata(&manifest)
                .and_then(|json| CrateGraph::from_metadata_json(&json, root))
                .unwrap_or_else(|| {
                    let dir = manifest.parent().unwrap_or(root);
                    CrateGraph::from_manifests(root, dir)
                });
            roots.extend(graph.roots);
            aliases.extend(graph.aliases);
        }
        CrateGraph::from_roots(roots).with_aliases(aliases)
    }

    /// Keeps the aliases that name a library of this graph and are not one's
    /// own name.
    fn with_aliases(mut self, aliases: BTreeMap<String, String>) -> CrateGraph {
        let libs: BTreeSet<&str> = self
            .roots
            .iter()
            .filter(|r| r.is_lib)
            .map(|r| r.name.as_str())
            .collect();
        let aliases = aliases
            .into_iter()
            .filter(|(alias, lib)| !libs.contains(alias.as_str()) && libs.contains(lib.as_str()))
            .collect();
        self.aliases = aliases;
        self
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
        CrateGraph {
            roots,
            aliases: BTreeMap::new(),
        }
    }

    /// Parse `cargo metadata --format-version 1` output. Targets outside `root` are dropped.
    pub fn from_metadata_json(json: &str, root: &Path) -> Option<CrateGraph> {
        #[derive(Deserialize)]
        struct Meta {
            packages: Vec<Package>,
        }
        #[derive(Deserialize)]
        struct Package {
            name: String,
            targets: Vec<Target>,
            #[serde(default)]
            dependencies: Vec<Dependency>,
        }
        #[derive(Deserialize)]
        struct Dependency {
            name: String,
            #[serde(default)]
            rename: Option<String>,
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
        // Package name → its library's name, for renamed dependencies.
        let mut lib_of: HashMap<String, String> = HashMap::new();
        let mut renames: Vec<(String, String)> = Vec::new();
        for p in meta.packages {
            renames.extend(
                p.dependencies
                    .into_iter()
                    .filter_map(|d| Some((d.rename?, d.name))),
            );
            let package = p.name;
            for t in p.targets {
                let Some(krate) = target_root(t.name, &t.kind, t.src_path, &canon_root) else {
                    continue;
                };
                if krate.is_lib {
                    lib_of.insert(package.clone(), krate.name.clone());
                }
                roots.push(krate);
            }
        }
        Some(CrateGraph::from_roots(roots).with_aliases(aliases_of(renames, &lib_of)))
    }

    /// Fallback: read `<dir>/Cargo.toml` (+ workspace members) without cargo.
    pub fn from_manifests(root: &Path, dir: &Path) -> CrateGraph {
        let mut roots = Vec::new();
        let Some(top) = read_toml(&dir.join("Cargo.toml")) else {
            return CrateGraph::default();
        };
        let mut lib_of: HashMap<String, String> = HashMap::new();
        let mut renames = renamed_dependencies(&top);
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
            renames.extend(renamed_dependencies(&manifest));
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
            if pkg_dir.join(lib_path).is_file() {
                lib_of.insert(pkg_name.to_string(), lib_name.replace('-', "_"));
            }
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
        CrateGraph::from_roots(roots).with_aliases(aliases_of(renames, &lib_of))
    }

    /// Names other crates can use in paths, each mapped to the library it
    /// reaches: every library under its own name, and every renamed
    /// dependency on one under the new name.
    pub(crate) fn lib_names(&self) -> Libs {
        let mut libs = self.aliases.clone();
        for r in self.roots.iter().filter(|r| r.is_lib) {
            libs.insert(r.name.clone(), r.name.clone());
        }
        libs
    }
}

/// One `cargo metadata` target as a crate root, or `None` outside `root`.
fn target_root(name: String, kind: &[String], src: PathBuf, root: &Path) -> Option<CrateRoot> {
    let src = src.canonicalize().unwrap_or(src);
    let rel = src.strip_prefix(root).ok()?;
    let is_lib = kind.iter().any(|k| {
        matches!(
            k.as_str(),
            "lib" | "rlib" | "dylib" | "cdylib" | "staticlib" | "proc-macro"
        )
    });
    Some(CrateRoot {
        name: name.replace('-', "_"),
        root_rel: rel_string(rel),
        is_lib,
    })
}

/// `(new name, package)` for each dependency `manifest` renames with
/// `package = "…"`: in `[dependencies]`, `[dev-dependencies]`,
/// `[build-dependencies]`, their `[target.….]` forms, and
/// `[workspace.dependencies]` (which `alpha2 = { workspace = true }` inherits).
fn renamed_dependencies(manifest: &toml::Table) -> Vec<(String, String)> {
    const KINDS: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];
    let mut scopes: Vec<&toml::Table> = vec![manifest];
    if let Some(targets) = manifest.get("target").and_then(|t| t.as_table()) {
        scopes.extend(targets.values().filter_map(|t| t.as_table()));
    }
    if let Some(ws) = manifest.get("workspace").and_then(|w| w.as_table()) {
        scopes.push(ws);
    }
    scopes
        .into_iter()
        .flat_map(|scope| KINDS.iter().filter_map(move |k| scope.get(*k)?.as_table()))
        .flat_map(|deps| deps.iter())
        .filter_map(|(new, spec)| Some((new.clone(), spec.get("package")?.as_str()?.to_string())))
        .collect()
}

/// Renames of a workspace package, keyed by the new name as paths write it.
fn aliases_of(
    renames: Vec<(String, String)>,
    lib_of: &HashMap<String, String>,
) -> BTreeMap<String, String> {
    renames
        .into_iter()
        .filter_map(|(new, package)| Some((new.replace('-', "_"), lib_of.get(&package)?.clone())))
        .collect()
}

/// The shallowest `Cargo.toml` on each branch of the tree, at most
/// [`MANIFEST_DEPTH`] levels down (`Cargo.toml` at the root covers the whole
/// project; a workspace in `rust/ws/` is found too). Ignored and skipped
/// directories are not entered. Sorted.
fn top_manifests(root: &Path) -> Vec<PathBuf> {
    let rules = Arc::new(crate::skip::Rules::load(root));
    let mut found: Vec<PathBuf> = crate::scan::walker(root, root, rules)
        .max_depth(Some(MANIFEST_DEPTH))
        .build()
        .flatten()
        .filter(|e| e.file_name() == "Cargo.toml" && e.file_type().is_some_and(|t| t.is_file()))
        .map(ignore::DirEntry::into_path)
        .collect();
    found.sort_by_key(|p| p.components().count());
    let mut out: Vec<PathBuf> = Vec::new();
    for manifest in found {
        let dir = manifest.parent().unwrap_or(root);
        if !out
            .iter()
            .any(|top| top.parent().is_some_and(|t| dir.starts_with(t)))
        {
            out.push(manifest);
        }
    }
    out.sort();
    out
}

fn cargo_candidates() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "cargo.exe" } else { "cargo" };
    let mut v = vec![PathBuf::from("cargo")];
    if let Some(home) = std::env::var_os("CARGO_HOME") {
        v.push(PathBuf::from(home).join("bin").join(exe));
    }
    if let Some(home) = home_dir() {
        v.push(home.join(".cargo").join("bin").join(exe));
    }
    v
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Run `cargo metadata` with a hard timeout. `None` on any failure.
fn cargo_metadata(manifest: &Path) -> Option<String> {
    // Run from the user's home, never the app's inherited directory: rustup
    // picks the toolchain from `rust-toolchain.toml` and cargo reads
    // `.cargo/config.toml` up the working directory's ancestry, and both name
    // programs to run. The project's own files are not searched from there.
    let cwd = home_dir()?;
    for cargo in cargo_candidates() {
        let mut cmd = atlas_process::command(&cargo);
        cmd.current_dir(&cwd)
            .args([
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
            if let std::collections::btree_map::Entry::Vacant(slot) = assigned.entry(id) {
                // A bin/test/example crate is its own crate even when it shares the lib's name.
                let name = if root.is_lib {
                    root.name.clone()
                } else {
                    format!("{}#bin", root.name)
                };
                slot.insert(name.clone());
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
    fn top_manifests_are_the_shallowest_on_each_branch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for rel in [
            "rust/ws/Cargo.toml",
            "rust/ws/a/Cargo.toml",
            "tools/x/Cargo.toml",
            "web/node_modules/y/Cargo.toml",
        ] {
            std::fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
            std::fs::write(root.join(rel), "").unwrap();
        }
        let rels: Vec<String> = top_manifests(&root)
            .iter()
            .map(|p| rel_string(p.strip_prefix(&root).unwrap()))
            .collect();
        assert_eq!(rels, ["rust/ws/Cargo.toml", "tools/x/Cargo.toml"]);
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        assert_eq!(top_manifests(&root), [root.join("Cargo.toml")]);
    }

    #[test]
    fn renamed_dependencies_alias_their_library() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        write_tree(
            &root,
            &[
                ("Cargo.toml", "[workspace]\nmembers = [\"alpha\", \"beta\"]\n\n[workspace.dependencies]\nalpha-ws = { package = \"alpha\", path = \"alpha\" }\n"),
                ("alpha/Cargo.toml", "[package]\nname = \"alpha\"\nversion = \"0.1.0\"\n\n[lib]\nname = \"alpha_core\"\n"),
                ("alpha/src/lib.rs", ""),
                ("beta/Cargo.toml", "[package]\nname = \"beta\"\nversion = \"0.1.0\"\n\n[dependencies]\nalpha2 = { package = \"alpha\", path = \"../alpha\" }\nserde1 = { package = \"serde\", version = \"1\" }\n"),
                ("beta/src/lib.rs", ""),
            ],
        );
        let want: Libs = [
            ("alpha2", "alpha_core"),
            ("alpha_core", "alpha_core"),
            ("alpha_ws", "alpha_core"),
            ("beta", "beta"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        assert_eq!(CrateGraph::from_manifests(&root, &root).lib_names(), want);
        let json = serde_json::json!({
            "packages": [
                { "name": "alpha", "dependencies": [], "targets": [
                    { "name": "alpha_core", "kind": ["lib"], "src_path": root.join("alpha/src/lib.rs") }
                ] },
                { "name": "beta", "dependencies": [
                    { "name": "alpha", "rename": "alpha2" },
                    { "name": "serde", "rename": "serde1" }
                ], "targets": [
                    { "name": "beta", "kind": ["lib"], "src_path": root.join("beta/src/lib.rs") }
                ] }
            ]
        })
        .to_string();
        let g = CrateGraph::from_metadata_json(&json, &root).unwrap();
        assert_eq!(
            g.aliases,
            BTreeMap::from([("alpha2".to_string(), "alpha_core".to_string())])
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
            ..CrateGraph::default()
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
