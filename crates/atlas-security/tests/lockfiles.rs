use atlas_security::deps::lockfiles::{dep_changes, parse_lockfile, Ecosystem, Pkg};

fn names(pkgs: &[Pkg]) -> Vec<(String, String)> {
    let mut v: Vec<_> = pkgs
        .iter()
        .map(|p| (p.name.clone(), p.version.clone()))
        .collect();
    v.sort();
    v
}

fn pair(n: &str, v: &str) -> (String, String) {
    (n.to_string(), v.to_string())
}

#[test]
fn cargo_lock_skips_path_git_and_alternate_registries() {
    let lock = r#"
version = 4

[[package]]
name = "serde"
version = "1.0.219"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tokio"
version = "1.40.0"
source = "sparse+https://index.crates.io/"

[[package]]
name = "atlas-redact"
version = "0.1.0"

[[package]]
name = "gitdep"
version = "0.2.0"
source = "git+https://github.com/x/y#abc"

[[package]]
name = "serde"
version = "9.9.9"
source = "registry+https://my-company.example/index"
"#;
    let pkgs = parse_lockfile("Cargo.lock", lock.as_bytes()).unwrap();
    assert!(pkgs.iter().all(|p| p.eco == Ecosystem::CratesIo));
    assert_eq!(
        names(&pkgs),
        vec![pair("serde", "1.0.219"), pair("tokio", "1.40.0")]
    );
}

#[test]
fn package_lock_v3_reads_versions_and_skips_links() {
    let lock = r#"{
  "name": "app", "lockfileVersion": 3,
  "packages": {
    "": { "name": "app", "version": "1.0.0" },
    "node_modules/lodash": { "version": "4.17.20", "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" },
    "node_modules/@types/node": { "version": "22.0.0", "resolved": "https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz" },
    "node_modules/a/node_modules/minimist": { "version": "1.2.5", "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.5.tgz" },
    "node_modules/local": { "resolved": "packages/local", "link": true },
    "node_modules/fromgit": { "version": "1.0.0", "resolved": "git+ssh://git@github.com/x/y.git#abc" },
    "node_modules/private": { "version": "2.0.0", "resolved": "https://npm.my-company.example/private/-/private-2.0.0.tgz" }
  }
}"#;
    let pkgs = parse_lockfile("package-lock.json", lock.as_bytes()).unwrap();
    assert!(pkgs.iter().all(|p| p.eco == Ecosystem::Npm));
    assert_eq!(
        names(&pkgs),
        vec![
            pair("@types/node", "22.0.0"),
            pair("lodash", "4.17.20"),
            pair("minimist", "1.2.5")
        ]
    );
}

#[test]
fn bun_lock_jsonc_parses_with_trailing_commas() {
    let lock = r#"{
  // bun's text lockfile
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", }, },
  "packages": {
    "react": ["react@19.1.0", "", {}, "sha512-abc"],
    "@types/node": ["@types/node@22.0.0", "", {}, "sha512-def"],
    "my-ws": ["my-ws@workspace:packages/x"],
    "linked": ["linked@link:../linked"],
    "custom": ["custom@1.0.0", "https://npm.my-company.example/", {}, "sha512-x"],
  },
}"#;
    let pkgs = parse_lockfile("bun.lock", lock.as_bytes()).unwrap();
    assert_eq!(
        names(&pkgs),
        vec![pair("@types/node", "22.0.0"), pair("react", "19.1.0")]
    );
}

#[test]
fn uv_lock_keeps_pypi_and_skips_editable_git_path() {
    let lock = r#"
version = 1

[[package]]
name = "Django"
version = "4.2.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "myapp"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "fromgit"
version = "1.0.0"
source = { git = "https://github.com/x/y" }

[[package]]
name = "internal"
version = "3.0.0"
source = { registry = "https://pypi.my-company.example/simple" }
"#;
    let pkgs = parse_lockfile("uv.lock", lock.as_bytes()).unwrap();
    assert!(pkgs.iter().all(|p| p.eco == Ecosystem::PyPI));
    assert_eq!(names(&pkgs), vec![pair("django", "4.2.1")]);
}

#[test]
fn poetry_lock_skips_sourced_packages() {
    let lock = r#"
[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "localpkg"
version = "0.1.0"

[package.source]
type = "directory"
url = "../localpkg"
"#;
    let pkgs = parse_lockfile("poetry.lock", lock.as_bytes()).unwrap();
    assert_eq!(names(&pkgs), vec![pair("requests", "2.31.0")]);
}

#[test]
fn requirements_only_pinned() {
    let req = "django==4.2.1\nrequests>=2\n-e .\ngit+https://github.com/x/y\n# comment\nPyYAML[extra]==6.0 ; python_version >= \"3.8\"\nflask == 2.0.1  # pinned\n-r other.txt\n";
    let pkgs = parse_lockfile("requirements-dev.txt", req.as_bytes()).unwrap();
    assert_eq!(
        names(&pkgs),
        vec![
            pair("django", "4.2.1"),
            pair("flask", "2.0.1"),
            pair("pyyaml", "6.0")
        ]
    );
}

#[test]
fn pypi_names_normalised() {
    let req = "Django_REST.framework==3.14.0\n";
    let pkgs = parse_lockfile("requirements.txt", req.as_bytes()).unwrap();
    assert_eq!(pkgs[0].name, "django-rest-framework");
}

#[test]
fn dep_changes_reports_added_and_bumped_not_removed() {
    let p = |n: &str, v: &str| Pkg {
        eco: Ecosystem::Npm,
        name: n.to_string(),
        version: v.to_string(),
    };
    let before = vec![p("a", "1.0.0"), p("b", "1.0.0"), p("gone", "1.0.0")];
    let after = vec![p("a", "1.0.0"), p("b", "1.1.0"), p("new", "2.0.0")];
    let changes = dep_changes(&before, &after);
    let mut got: Vec<_> = changes
        .iter()
        .map(|c| {
            (
                c.pkg.name.as_str(),
                c.old_version.as_deref(),
                c.pkg.version.as_str(),
            )
        })
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![("b", Some("1.0.0"), "1.1.0"), ("new", None, "2.0.0")]
    );
}

#[test]
fn unsupported_and_broken_lockfiles_return_none() {
    assert!(parse_lockfile("pnpm-lock.yaml", b"lockfileVersion: '9.0'").is_none());
    assert!(parse_lockfile("yarn.lock", b"# yarn lockfile v1").is_none());
    assert!(parse_lockfile("Cargo.lock", b"[[package]\nname=").is_none());
    assert!(parse_lockfile("package-lock.json", b"{not json").is_none());
}
