//! Helpers shared by the integration tests: real temporary git repositories
//! and sessions on the in-process fake thread server.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use atlas_thread_sync::{FakeThreadServer, FakeTransport, Replica, ThreadSession};

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub fn init_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "--quiet", "--initial-branch=main"]);
    git(dir, &["config", "user.name", "Atlas Test"]);
    git(dir, &["config", "user.email", "test@atlas.invalid"]);
}

pub fn write(dir: &Path, rel: &str, content: &str) {
    let target = dir.join(rel);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(target, content).unwrap();
}

pub fn read(dir: &Path, rel: &str) -> String {
    fs::read_to_string(dir.join(rel)).unwrap()
}

/// Joy's repository with a committed Base and some uncommitted work on top,
/// and Monzim's clone of it — so both hold the Base.
pub struct World {
    pub _tmp: tempfile::TempDir,
    pub joy: PathBuf,
    pub monzim: PathBuf,
    pub base: String,
    pub replicas: PathBuf,
}

pub fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let joy = tmp.path().join("joy");
    init_repo(&joy);
    write(&joy, "src/banner.css", ".banner {\n  color: blue;\n}\n");
    write(&joy, "README.md", "# Site\n");
    write(&joy, ".gitignore", "dist/\n");
    git(&joy, &["add", "-A"]);
    git(&joy, &["commit", "--quiet", "-m", "base"]);
    let base = git(&joy, &["rev-parse", "HEAD"]);

    let monzim = tmp.path().join("monzim");
    git(
        tmp.path(),
        &[
            "clone",
            "--quiet",
            joy.to_str().unwrap(),
            monzim.to_str().unwrap(),
        ],
    );

    // Joy's uncommitted work: an edit, a new file, and build output that
    // must never sync.
    write(&joy, "src/banner.css", ".banner {\n  color: green;\n}\n");
    write(&joy, "notes.md", "todo: red?\n");
    write(&joy, "dist/bundle.js", "minified();\n");
    write(&joy, ".env.local", "STRIPE_KEY=sk_live_not_really\n");

    let replicas = tmp.path().join("replicas");
    World {
        _tmp: tmp,
        joy,
        monzim,
        base,
        replicas,
    }
}

pub async fn open(
    server: &FakeThreadServer,
    repo: &Path,
    base: &str,
    root: &Path,
    user: &str,
) -> ThreadSession<FakeTransport> {
    let replica = Replica::new(repo, base, root).unwrap();
    ThreadSession::connect(
        server.connect(user),
        replica,
        &format!("{user}-replica-1"),
        std::sync::Arc::new(server.store()),
    )
    .await
    .unwrap()
}
