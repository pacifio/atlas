//! The single git spawn chokepoint — every git subprocess in Atlas should go
//! through [`GitCommand`]. Ported from GitHub Desktop's `git()` (core.ts):
//! per-call success-exit-code contracts, stderr→typed-error parsing on
//! failure, and a streaming variant that feeds hook/progress output line by
//! line while retaining a bounded tail for error context.
//!
//! Always the REAL git binary: hooks, credential helpers, LFS filters and
//! user config all behave exactly as in a terminal.

use crate::error::{self, GitErrorPayload};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Which pipe a streamed line arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Receives live output from [`GitCommand::run_streaming`]. Implemented by
/// the Tauri glue, which forwards lines as `atlas:git:op` events.
pub trait OpSink: Send + Sync {
    fn output(&self, stream: Stream, line: &str);
}

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Keep only the newest `cap` bytes of streamed output (whole lines) — the
/// same idea as Desktop's 256 KB terminal ring buffer.
const TAIL_CAP: usize = 256 * 1024;

fn push_capped(buf: &mut String, line: &str) {
    buf.push_str(line);
    buf.push('\n');
    if buf.len() > TAIL_CAP {
        let cut = buf.len() - TAIL_CAP;
        // Trim at a line boundary so the tail starts clean.
        let cut = buf[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
        buf.drain(..cut);
    }
}

/// A single git invocation. Build with [`GitCommand::new`], chain options,
/// then call [`run`](Self::run) or [`run_streaming`](Self::run_streaming).
pub struct GitCommand {
    cwd: PathBuf,
    args: Vec<String>,
    envs: Vec<(String, String)>,
    success_exit_codes: HashSet<i32>,
    stdin: Option<Vec<u8>>,
    read_only: bool,
}

impl GitCommand {
    pub fn new(cwd: impl Into<PathBuf>, args: &[&str]) -> Self {
        GitCommand {
            cwd: cwd.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            envs: Vec::new(),
            success_exit_codes: HashSet::from([0]),
            stdin: None,
            read_only: false,
        }
    }

    pub fn new_owned(cwd: impl Into<PathBuf>, args: Vec<String>) -> Self {
        GitCommand {
            cwd: cwd.into(),
            args,
            envs: Vec::new(),
            success_exit_codes: HashSet::from([0]),
            stdin: None,
            read_only: false,
        }
    }

    /// Mark as a read query: prepends `--no-optional-locks` so background
    /// status/log refreshes never take `index.lock` out from under a
    /// user-initiated mutation (Desktop does this on every status call).
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// Accept additional exit codes as success (e.g. `{0, 1}` for
    /// `git diff --check`, which exits 1 when conflicts markers exist).
    pub fn success_codes(mut self, codes: &[i32]) -> Self {
        self.success_exit_codes = codes.iter().copied().collect();
        self
    }

    pub fn env(mut self, key: &str, val: &str) -> Self {
        self.envs.push((key.to_string(), val.to_string()));
        self
    }

    /// Bytes piped to git's stdin (commit messages via `-F -`, patches for
    /// `apply`, path lists for `update-index --stdin`).
    pub fn stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }

    /// `git <args>` as a display string for error payloads / logs.
    fn display(&self) -> String {
        let mut s = String::from("git");
        for a in &self.args {
            s.push(' ');
            // Keep messages readable — elide long stdin-ish args.
            if a.len() > 60 {
                s.push_str(&a[..57]);
                s.push('…');
            } else {
                s.push_str(a);
            }
        }
        s
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new("git");
        if self.read_only {
            cmd.arg("--no-optional-locks");
        }
        cmd.args(&self.args)
            .current_dir(&self.cwd)
            // Never hang on a credential prompt — fail fast and let the UI
            // route the typed AuthFailed error instead.
            .env("GIT_TERMINAL_PROMPT", "0")
            // Stable English output so the error regex table matches
            // regardless of the user's locale.
            .env("LC_ALL", "C")
            .env("TERM", "dumb");
        for (k, v) in &self.envs {
            cmd.env(k, v);
        }
        cmd
    }

    /// Buffered run. `Ok` when the exit code is in `success_exit_codes`,
    /// otherwise a typed [`GitErrorPayload`] classified from stderr/stdout.
    pub fn run(self) -> Result<GitOutput, GitErrorPayload> {
        let display = self.display();
        let mut cmd = self.command();
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() });

        let mut child = cmd.spawn().map_err(|e| spawn_error(&display, &e))?;

        // Feed stdin from a thread so a chatty child can't deadlock us.
        let stdin_thread = self.stdin.and_then(|bytes| {
            child.stdin.take().map(|mut pipe| {
                std::thread::spawn(move || {
                    let _ = pipe.write_all(&bytes);
                })
            })
        });

        let out = child
            .wait_with_output()
            .map_err(|e| GitErrorPayload::internal(format!("{display}: {e}")))?;
        if let Some(t) = stdin_thread {
            let _ = t.join();
        }

        let exit_code = out.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();

        if self.success_exit_codes.contains(&exit_code) {
            Ok(GitOutput { exit_code, stdout, stderr })
        } else {
            Err(error::payload(display, out.status.code(), &stderr, &stdout))
        }
    }

    /// Streaming run: stdout/stderr are read line by line and forwarded to
    /// `sink` as they arrive (hook output, progress). The full (tail-capped)
    /// text is still collected so failures classify exactly like [`run`].
    pub fn run_streaming(self, sink: &dyn OpSink) -> Result<GitOutput, GitErrorPayload> {
        let display = self.display();
        let mut cmd = self.command();
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() });

        let mut child = cmd.spawn().map_err(|e| spawn_error(&display, &e))?;

        let stdin_thread = self.stdin.and_then(|bytes| {
            child.stdin.take().map(|mut pipe| {
                std::thread::spawn(move || {
                    let _ = pipe.write_all(&bytes);
                })
            })
        });

        // Reader threads: forward each line to the sink and keep the tail.
        std::thread::scope(|scope| {
            let stdout_pipe = child.stdout.take();
            let stderr_pipe = child.stderr.take();

            let out_handle = scope.spawn(move || {
                let mut buf = String::new();
                if let Some(pipe) = stdout_pipe {
                    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                        sink.output(Stream::Stdout, &line);
                        push_capped(&mut buf, &line);
                    }
                }
                buf
            });
            let err_handle = scope.spawn(move || {
                let mut buf = String::new();
                if let Some(pipe) = stderr_pipe {
                    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                        sink.output(Stream::Stderr, &line);
                        push_capped(&mut buf, &line);
                    }
                }
                buf
            });

            let status = child
                .wait()
                .map_err(|e| GitErrorPayload::internal(format!("{display}: {e}")))?;
            let stdout = out_handle.join().unwrap_or_default();
            let stderr = err_handle.join().unwrap_or_default();
            if let Some(t) = stdin_thread {
                let _ = t.join();
            }

            let exit_code = status.code().unwrap_or(-1);
            if self.success_exit_codes.contains(&exit_code) {
                Ok(GitOutput { exit_code, stdout, stderr })
            } else {
                Err(error::payload(display, status.code(), &stderr, &stdout))
            }
        })
    }
}

fn spawn_error(display: &str, e: &std::io::Error) -> GitErrorPayload {
    if e.kind() == std::io::ErrorKind::NotFound {
        GitErrorPayload::internal("git was not found on this system. Install git and try again.")
    } else {
        GitErrorPayload::internal(format!("failed to start {display}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct CollectSink(Mutex<Vec<(Stream, String)>>);
    impl OpSink for CollectSink {
        fn output(&self, stream: Stream, line: &str) {
            self.0.lock().unwrap().push((stream, line.to_string()));
        }
    }

    fn temp_repo() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atlas-git-exec-{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        GitCommand::new(&root, &["init", "-q", "-b", "main"]).run().unwrap();
        root
    }

    #[test]
    fn run_success_and_typed_failure() {
        let repo = temp_repo();
        let out = GitCommand::new(&repo, &["status", "--porcelain"]).read_only().run().unwrap();
        assert_eq!(out.exit_code, 0);

        // Unknown ref → typed error, not a raw string.
        let err = GitCommand::new(&repo, &["log", "no-such-ref"]).run().unwrap_err();
        assert_eq!(err.code, crate::GitErrorCode::UnknownRef);
        assert!(!err.raw_stderr.is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn success_codes_contract() {
        let repo = temp_repo();
        // `git diff --check` on a clean tree exits 0; asking for an accepted
        // extra code must not break the success path.
        let out = GitCommand::new(&repo, &["diff", "--check"])
            .success_codes(&[0, 2])
            .run()
            .unwrap();
        assert_eq!(out.exit_code, 0);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn streaming_forwards_lines_and_stdin() {
        let repo = temp_repo();
        std::fs::write(repo.join("f.txt"), "hello\n").unwrap();
        GitCommand::new(&repo, &["add", "f.txt"]).run().unwrap();

        let sink = CollectSink(Mutex::new(Vec::new()));
        let out = GitCommand::new(&repo, &["commit", "-F", "-"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .stdin(b"streamed commit message\n".to_vec())
            .run_streaming(&sink)
            .unwrap();
        assert_eq!(out.exit_code, 0);
        let lines = sink.0.lock().unwrap();
        assert!(
            lines.iter().any(|(_, l)| l.contains("streamed commit message")),
            "commit summary should stream through the sink: {lines:?}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn tail_cap_keeps_newest() {
        let mut buf = String::new();
        for i in 0..20_000 {
            push_capped(&mut buf, &format!("line-{i} pad pad pad pad pad"));
        }
        assert!(buf.len() <= TAIL_CAP + 64);
        assert!(buf.contains("line-19999"));
        assert!(!buf.contains("line-0 "));
    }
}
