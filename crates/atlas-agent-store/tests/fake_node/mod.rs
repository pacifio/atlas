//! A managed Node.js runtime that is really a shell script, so the install
//! path can be driven through every failure npm has — without npm.
//!
//! Nothing in this crate could run `npm` before this: the only Node the tests
//! knew was [`NodeRuntime::unavailable`], so a dropped install, a wedged
//! install, an install that exits 0 with half a tree, and two installs racing
//! one directory were all untested. This plants a `node` whose behaviour is
//! read from a config file beside it, and the production code runs it exactly
//! as it would the real one: `node <npm> install <spec> --save-exact
//! --prefer-online …`.
//!
//! The script tells `--version` (the health check) apart from `install`, and
//! `--prefer-online` from `--prefer-offline`, because the production code's
//! fallback ladder is what the tests are about. It records every invocation to
//! a log so a test can assert how many times npm actually ran.
//!
//! Unix only: the production script path is `bin/node`, and `/bin/sh` is the
//! interpreter. The Windows layout (`node.exe`) is out of scope here.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// The managed runtime's directory name for this host, as `node.rs` builds
/// it. Kept in step with `NODE_VERSION` there; a mismatch makes the health
/// check look for a directory that does not exist, which reads as "not
/// installed" and triggers a download the fake HTTP client will 404.
pub const NODE_VERSION: &str = "v24.22.2";

fn node_platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        other => panic!("fake node has no layout for {other}"),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => panic!("fake node has no layout for {other}"),
    };
    (os, arch)
}

/// `<data_dir>/node/node-<ver>-<os>-<arch>` — where `NodeRuntime::managed`
/// expects to find a runtime.
pub fn node_dir(data_dir: &Path) -> PathBuf {
    let (os, arch) = node_platform();
    data_dir
        .join("node")
        .join(format!("node-{NODE_VERSION}-{os}-{arch}"))
}

/// What the fake npm does on each kind of call. Every field has the
/// "behaves like a healthy npm" default, so a test states only the fault.
#[derive(Debug, Clone)]
pub struct Behaviour {
    /// Exit status of `npm --version` (the health check). Non-zero makes the
    /// runtime look broken, which triggers a re-download.
    pub version_exit: i32,
    /// Seconds `npm --version` sleeps before answering.
    pub version_sleep: f64,
    /// Exit status of `npm install … --prefer-online`.
    pub online_exit: i32,
    /// Exit status of `npm install … --prefer-offline`.
    pub offline_exit: i32,
    /// Seconds every `npm install` sleeps before doing anything.
    pub install_sleep: f64,
    /// What an online install writes as `node_modules`: a directory to copy,
    /// or nothing (npm "succeeded" without landing a tree).
    pub online_tree: Option<PathBuf>,
    /// Same, for an offline install (npm's cache).
    pub offline_tree: Option<PathBuf>,
    /// Text every failing install prints to stderr.
    pub stderr: String,
}

impl Default for Behaviour {
    fn default() -> Self {
        Self {
            version_exit: 0,
            version_sleep: 0.0,
            online_exit: 0,
            offline_exit: 0,
            install_sleep: 0.0,
            online_tree: None,
            offline_tree: None,
            stderr: String::new(),
        }
    }
}

/// A planted fake runtime.
pub struct FakeNode {
    pub data_dir: PathBuf,
    pub node_dir: PathBuf,
    pub log: PathBuf,
}

impl FakeNode {
    /// Plant a runtime under `data_dir` that already passes the health check,
    /// behaving per `behaviour`.
    pub fn plant(data_dir: &Path, behaviour: &Behaviour) -> Self {
        let node_dir = node_dir(data_dir);
        let bin = node_dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let log = node_dir.join("fake-npm.log");
        std::fs::write(&log, "").unwrap();
        // `npm` only has to exist: the health check and `npm_attempt` both
        // stat it, then run `node <npm> …`, and the script ignores argv[1].
        std::fs::write(bin.join("npm"), "").unwrap();
        let node = Self {
            data_dir: data_dir.to_path_buf(),
            node_dir,
            log,
        };
        node.set(behaviour);
        node.write_script();
        node
    }

    /// Change the behaviour of an already-planted runtime mid-test.
    pub fn set(&self, behaviour: &Behaviour) {
        let tree = |t: &Option<PathBuf>| {
            t.as_ref()
                .map_or(String::new(), |p| p.display().to_string())
        };
        let conf = format!(
            "version_exit={}\nversion_sleep={}\nonline_exit={}\noffline_exit={}\ninstall_sleep={}\nonline_tree={}\noffline_tree={}\nstderr={}\n",
            behaviour.version_exit,
            behaviour.version_sleep,
            behaviour.online_exit,
            behaviour.offline_exit,
            behaviour.install_sleep,
            tree(&behaviour.online_tree),
            tree(&behaviour.offline_tree),
            behaviour.stderr.replace('\n', " "),
        );
        std::fs::write(self.node_dir.join("fake-npm.conf"), conf).unwrap();
    }

    /// One line per invocation: `version`, `install online`, `install offline`
    /// (with the working directory appended).
    pub fn invocations(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    pub fn install_count(&self) -> usize {
        self.invocations()
            .iter()
            .filter(|line| line.starts_with("install"))
            .count()
    }

    fn write_script(&self) {
        // POSIX sh. `$0` is the script's own path, so it finds its config and
        // log beside itself regardless of the working directory npm is run in.
        // `cp -R <tree>/. node_modules` copies the tree's *contents*.
        let script = r#"#!/bin/sh
here="$(cd "$(dirname "$0")/.." && pwd)"
conf="$here/fake-npm.conf"
log="$here/fake-npm.log"
get() { sed -n "s/^$1=//p" "$conf" | head -n 1; }

shift  # argv[1] is the npm entry point; the fake ignores it
mode=""
policy="online"
for a in "$@"; do
  case "$a" in
    --version) mode="version" ;;
    install) [ -z "$mode" ] && mode="install" ;;
    --prefer-offline) policy="offline" ;;
    --prefer-online) policy="online" ;;
  esac
done

if [ "$mode" = "version" ]; then
  echo "version" >> "$log"
  s="$(get version_sleep)"; [ "${s:-0}" != "0" ] && sleep "$s"
  echo "10.9.2"
  exit "$(get version_exit)"
fi

if [ "$mode" = "install" ]; then
  echo "install $policy $(pwd)" >> "$log"
  s="$(get install_sleep)"; [ "${s:-0}" != "0" ] && sleep "$s"
  code="$(get ${policy}_exit)"
  tree="$(get ${policy}_tree)"
  if [ "$code" = "0" ] && [ -n "$tree" ]; then
    rm -rf node_modules
    mkdir -p node_modules
    cp -R "$tree/." node_modules/
  fi
  if [ "$code" != "0" ]; then
    echo "$(get stderr)" >&2
  fi
  exit "$code"
fi

echo "fake node: unrecognised call: $*" >&2
exit 64
"#;
        let path = self.node_dir.join("bin").join("node");
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

/// A `node_modules` tree the fake npm can copy into place: the agent package
/// at `version` with a `bin`, and the hidden lockfile npm writes last, naming
/// one optional platform package for this host that is (or is not) present.
///
/// `platform_present: false` is the npm trap: exit 0, lockfile written, and
/// the one package the agent exists to ship marked `ideallyInert`.
pub fn tree(package: &str, version: &str, platform_present: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let (os, arch) = node_platform();
    let root = dir.path();
    let pkg = root.join(package);
    std::fs::create_dir_all(pkg.join("bin")).unwrap();
    std::fs::write(
        pkg.join("package.json"),
        format!(r#"{{"name":"{package}","version":"{version}","bin":{{"agent":"bin/agent.js"}}}}"#),
    )
    .unwrap();
    std::fs::write(pkg.join("bin").join("agent.js"), "// agent\n").unwrap();

    let platform_pkg = format!("{package}-{os}-{arch}");
    if platform_present {
        let dir = root.join(&platform_pkg);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"platform"}"#).unwrap();
    }
    let inert = if platform_present {
        ""
    } else {
        r#", "ideallyInert": true"#
    };
    std::fs::write(
        root.join(".package-lock.json"),
        format!(
            r#"{{
  "lockfileVersion": 3,
  "packages": {{
    "": {{ "name": "root" }},
    "node_modules/{package}": {{ "version": "{version}" }},
    "node_modules/{platform_pkg}": {{ "optional": true{inert}, "os": ["{os}"], "cpu": ["{arch}"] }}
  }}
}}"#
        ),
    )
    .unwrap();
    dir
}
