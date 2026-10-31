//! Resolved packages from the lockfiles Atlas users commit.
//!
//! Only packages resolved from the **public** registry of their ecosystem are
//! kept (crates.io, registry.npmjs.org, pypi.org). Git, path, workspace and
//! link dependencies have no public advisories, and a private registry's
//! package that shares a public name would otherwise match the public
//! package's advisories and block a commit that is fine.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Ecosystem {
    CratesIo,
    Npm,
    PyPI,
}

impl Ecosystem {
    pub const ALL: [Ecosystem; 3] = [Ecosystem::CratesIo, Ecosystem::Npm, Ecosystem::PyPI];

    /// OSV's name for the ecosystem.
    pub fn osv_name(self) -> &'static str {
        match self {
            Ecosystem::CratesIo => "crates.io",
            Ecosystem::Npm => "npm",
            Ecosystem::PyPI => "PyPI",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Pkg {
    pub eco: Ecosystem,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepChange {
    pub pkg: Pkg,
    /// The version before, for a bump; `None` for a newly added package.
    pub old_version: Option<String>,
}

/// Whether this version reads the lockfile at `path` at all.
pub fn is_supported(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "Cargo.lock" | "package-lock.json" | "bun.lock" | "uv.lock" | "poetry.lock"
    ) || (name.starts_with("requirements") && name.ends_with(".txt"))
}

/// The ecosystem a supported lockfile resolves packages from.
pub fn ecosystem_of(path: &str) -> Option<Ecosystem> {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name {
        "Cargo.lock" => Some(Ecosystem::CratesIo),
        "package-lock.json" | "bun.lock" => Some(Ecosystem::Npm),
        "uv.lock" | "poetry.lock" => Some(Ecosystem::PyPI),
        n if n.starts_with("requirements") && n.ends_with(".txt") => Some(Ecosystem::PyPI),
        _ => None,
    }
}

/// The packages in a lockfile, or `None` for a format this version does not
/// read or a file that does not parse.
pub fn parse_lockfile(path: &str, bytes: &[u8]) -> Option<Vec<Pkg>> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let text = std::str::from_utf8(bytes).ok()?;
    match name {
        "Cargo.lock" => cargo_lock(text),
        "package-lock.json" => package_lock(text),
        "bun.lock" => bun_lock(text),
        "uv.lock" => uv_lock(text),
        "poetry.lock" => poetry_lock(text),
        n if n.starts_with("requirements") && n.ends_with(".txt") => Some(requirements(text)),
        _ => None,
    }
}

/// Added and bumped packages; removals carry no new risk.
pub fn dep_changes(before: &[Pkg], after: &[Pkg]) -> Vec<DepChange> {
    let mut old: HashMap<(Ecosystem, &str), Vec<&str>> = HashMap::new();
    for p in before {
        old.entry((p.eco, p.name.as_str()))
            .or_default()
            .push(p.version.as_str());
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in after {
        if !seen.insert(p.clone()) {
            continue;
        }
        match old.get(&(p.eco, p.name.as_str())) {
            None => out.push(DepChange {
                pkg: p.clone(),
                old_version: None,
            }),
            Some(versions) if !versions.contains(&p.version.as_str()) => out.push(DepChange {
                pkg: p.clone(),
                old_version: versions.first().map(ToString::to_string),
            }),
            Some(_) => {}
        }
    }
    out
}

/// PEP 503: lowercase, runs of `-`, `_` and `.` become one `-`.
pub fn normalize_pypi(name: &str) -> String {
    static RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[-_.]+").expect("compiles"));
    RUNS.replace_all(&name.to_ascii_lowercase(), "-")
        .into_owned()
}

fn pkg(eco: Ecosystem, name: &str, version: &str) -> Pkg {
    let name = match eco {
        Ecosystem::PyPI => normalize_pypi(name),
        _ => name.to_string(),
    };
    Pkg {
        eco,
        name,
        version: version.to_string(),
    }
}

fn toml_packages(text: &str) -> Option<Vec<toml::Table>> {
    let doc: toml::Table = toml::from_str(text).ok()?;
    let list = match doc.get("package") {
        Some(toml::Value::Array(a)) => a.clone(),
        None => Vec::new(),
        Some(_) => return None,
    };
    Some(
        list.into_iter()
            .filter_map(|v| match v {
                toml::Value::Table(t) => Some(t),
                _ => None,
            })
            .collect(),
    )
}

fn str_field<'a>(t: &'a toml::Table, key: &str) -> Option<&'a str> {
    t.get(key).and_then(|v| v.as_str())
}

fn cargo_lock(text: &str) -> Option<Vec<Pkg>> {
    let mut out = Vec::new();
    for t in toml_packages(text)? {
        let (Some(name), Some(version)) = (str_field(&t, "name"), str_field(&t, "version")) else {
            continue;
        };
        let public = matches!(
            str_field(&t, "source"),
            Some(
                "registry+https://github.com/rust-lang/crates.io-index"
                    | "sparse+https://index.crates.io/"
            )
        );
        if public {
            out.push(pkg(Ecosystem::CratesIo, name, version));
        }
    }
    Some(out)
}

fn is_public_npm(resolved: Option<&str>) -> bool {
    match resolved {
        // An entry with no `resolved` came from the default registry.
        None | Some("") => true,
        Some(r) => r.starts_with("https://registry.npmjs.org/"),
    }
}

fn package_lock(text: &str) -> Option<Vec<Pkg>> {
    let doc: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut out = Vec::new();
    if let Some(packages) = doc.get("packages").and_then(|p| p.as_object()) {
        for (key, entry) in packages {
            let Some(idx) = key.rfind("node_modules/") else {
                continue;
            };
            let name = &key[idx + "node_modules/".len()..];
            if entry.get("link").and_then(serde_json::Value::as_bool) == Some(true) {
                continue;
            }
            let Some(version) = entry.get("version").and_then(|v| v.as_str()) else {
                continue;
            };
            if is_public_npm(entry.get("resolved").and_then(|r| r.as_str())) {
                out.push(pkg(Ecosystem::Npm, name, version));
            }
        }
    } else if let Some(deps) = doc.get("dependencies").and_then(|d| d.as_object()) {
        // lockfileVersion 1: top-level dependencies only.
        for (name, entry) in deps {
            let Some(version) = entry.get("version").and_then(|v| v.as_str()) else {
                continue;
            };
            if is_public_npm(entry.get("resolved").and_then(|r| r.as_str())) {
                out.push(pkg(Ecosystem::Npm, name, version));
            }
        }
    }
    Some(out)
}

/// bun.lock is JSON with comments and trailing commas.
fn bun_lock(text: &str) -> Option<Vec<Pkg>> {
    static COMMENT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)^\s*//.*$").expect("compiles"));
    static TRAILING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r",(\s*[}\]])").expect("compiles"));
    let no_comments = COMMENT.replace_all(text, "");
    let json = TRAILING.replace_all(&no_comments, "$1");
    let doc: serde_json::Value = serde_json::from_str(&json).ok()?;
    let mut out = Vec::new();
    let Some(packages) = doc.get("packages").and_then(|p| p.as_object()) else {
        return Some(out);
    };
    for entry in packages.values() {
        let Some(arr) = entry.as_array() else {
            continue;
        };
        let Some(spec) = arr.first().and_then(|s| s.as_str()) else {
            continue;
        };
        // `@scope/name@1.2.3`: the version follows the last `@`.
        let Some(at) = spec.rfind('@').filter(|i| *i > 0) else {
            continue;
        };
        let (name, version) = (&spec[..at], &spec[at + 1..]);
        let local = [
            "workspace:",
            "file:",
            "link:",
            "git",
            "github:",
            "npm:",
            "http",
        ]
        .iter()
        .any(|p| version.starts_with(p));
        let registry = arr.get(1).and_then(|r| r.as_str()).unwrap_or("");
        let public = registry.is_empty() || registry.starts_with("https://registry.npmjs.org");
        if !local && public && !version.is_empty() {
            out.push(pkg(Ecosystem::Npm, name, version));
        }
    }
    Some(out)
}

fn uv_lock(text: &str) -> Option<Vec<Pkg>> {
    let mut out = Vec::new();
    for t in toml_packages(text)? {
        let (Some(name), Some(version)) = (str_field(&t, "name"), str_field(&t, "version")) else {
            continue;
        };
        let public = t
            .get("source")
            .and_then(|s| s.as_table())
            .and_then(|s| s.get("registry"))
            .and_then(|r| r.as_str())
            .is_some_and(|r| r.starts_with("https://pypi.org/"));
        if public {
            out.push(pkg(Ecosystem::PyPI, name, version));
        }
    }
    Some(out)
}

fn poetry_lock(text: &str) -> Option<Vec<Pkg>> {
    let mut out = Vec::new();
    for t in toml_packages(text)? {
        let (Some(name), Some(version)) = (str_field(&t, "name"), str_field(&t, "version")) else {
            continue;
        };
        // Any `[package.source]` (git, directory, file, url, a private
        // index) means it did not come from PyPI.
        if !t.contains_key("source") {
            out.push(pkg(Ecosystem::PyPI, name, version));
        }
    }
    Some(out)
}

fn requirements(text: &str) -> Vec<Pkg> {
    static PIN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([A-Za-z0-9.+!_-]+)\s*(;.*)?$",
        )
        .expect("compiles")
    });
    // pip-compile writes `name==1.0 \` and `--hash=…` continuation lines.
    let joined = text.replace("\\\r\n", " ").replace("\\\n", " ");
    joined
        .lines()
        .filter_map(|line| {
            let line = line.split(" #").next().unwrap_or(line);
            let kept: Vec<&str> = line
                .split_whitespace()
                .filter(|t| !t.starts_with("--hash"))
                .collect();
            let logical = kept.join(" ");
            let caps = PIN.captures(&logical)?;
            Some(pkg(Ecosystem::PyPI, &caps[1], &caps[3]))
        })
        .collect()
}
