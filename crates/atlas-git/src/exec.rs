//! The single git spawn chokepoint — every git subprocess in Atlas should go
//! through [`GitCommand`]. It provides:
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
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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
        // Trim at a line boundary so the tail starts clean. Searched in bytes:
        // `cut` can fall inside a multi-byte character (every `✓` a test
        // runner prints), where slicing the str panics; a `\n` byte is always
        // a character boundary.
        let cut = buf.as_bytes()[cut..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(buf.len(), |i| cut + i + 1);
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
    timeout: Option<Duration>,
}

impl GitCommand {
    pub fn new(cwd: impl Into<PathBuf>, args: &[&str]) -> Self {
        GitCommand {
            cwd: cwd.into(),
            args: args.iter().map(std::string::ToString::to_string).collect(),
            envs: Vec::new(),
            success_exit_codes: HashSet::from([0]),
            stdin: None,
            read_only: false,
            timeout: None,
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
            timeout: None,
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

    /// Pass `paths` as pathspecs over stdin (`--pathspec-from-file=-`), in
    /// place of `-- <paths>` on the command line. A large change set (Stage
    /// all on a few thousand files) overflows Windows' 32,767-character
    /// command line, and the spawn itself fails. Same pathspec semantics;
    /// only for commands that take the flag (`add`, `restore`, `rm`, `reset`,
    /// `checkout`, `commit`, `stash push`). Replaces any [`stdin`](Self::stdin).
    pub fn pathspecs<S: AsRef<str>>(mut self, paths: &[S]) -> Self {
        self.args.push("--pathspec-from-file=-".into());
        self.args.push("--pathspec-file-nul".into());
        let mut bytes = Vec::new();
        for p in paths {
            bytes.extend_from_slice(p.as_ref().as_bytes());
            bytes.push(0);
        }
        self.stdin = Some(bytes);
        self
    }

    /// Kill git if it hasn't exited after `limit` ([`run`](Self::run) only).
    /// For unattended network ops: a remote that never answers otherwise
    /// holds the calling thread for as long as TCP takes to give up, which
    /// can be minutes. Expiry is a `NetworkError`.
    pub fn timeout(mut self, limit: Duration) -> Self {
        self.timeout = Some(limit);
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
        let mut cmd = atlas_process::command("git");
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
        cmd.stdin(if self.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

        let mut child = cmd.spawn().map_err(|e| spawn_error(&display, &e))?;

        // Feed stdin from a thread so a chatty child can't deadlock us.
        let stdin_thread = self.stdin.and_then(|bytes| {
            child.stdin.take().map(|mut pipe| {
                std::thread::spawn(move || {
                    let _ = pipe.write_all(&bytes);
                })
            })
        });

        let out = match self.timeout {
            None => child.wait_with_output(),
            Some(limit) => match wait_with_deadline(child, limit) {
                Ok(Some(out)) => Ok(out),
                Ok(None) => return Err(timed_out(&display, limit)),
                Err(e) => Err(e),
            },
        }
        .map_err(|e| GitErrorPayload::internal(format!("{display}: {e}")))?;
        if let Some(t) = stdin_thread {
            let _ = t.join();
        }

        let exit_code = out.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();

        if self.success_exit_codes.contains(&exit_code) {
            Ok(GitOutput {
                exit_code,
                stdout,
                stderr,
            })
        } else {
            Err(error::payload(display, out.status.code(), &stderr, &stdout))
        }
    }

    /// Streaming run: stdout/stderr are read line by line and forwarded to
    /// `sink` as they arrive (hook output, progress). The full (tail-capped)
    /// text is still collected so failures classify exactly like [`run`].
    ///
    /// Done when git exits, not when its pipes close: a hook that leaves a
    /// process running (a test runner's daemon, a dev server) hands it the
    /// write ends, and waiting for EOF held the operation open for as long
    /// as that process lived. After git exits, output already in flight gets
    /// [`STREAM_DRAIN_GRACE`] to arrive; the reader threads are then left to
    /// end by themselves when the last holder closes the pipe.
    pub fn run_streaming(self, sink: &dyn OpSink) -> Result<GitOutput, GitErrorPayload> {
        use std::sync::mpsc;

        enum Msg {
            Line(Stream, String),
            Eof,
            Exited(std::io::Result<std::process::ExitStatus>),
        }

        let display = self.display();
        let mut cmd = self.command();
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.stdin(if self.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

        let mut child = cmd.spawn().map_err(|e| spawn_error(&display, &e))?;

        let stdin_thread = self.stdin.and_then(|bytes| {
            child.stdin.take().map(|mut pipe| {
                std::thread::spawn(move || {
                    let _ = pipe.write_all(&bytes);
                })
            })
        });

        let (tx, rx) = mpsc::channel::<Msg>();
        let mut readers = 0;
        for (stream, pipe) in [
            (
                Stream::Stdout,
                child
                    .stdout
                    .take()
                    .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
            ),
            (
                Stream::Stderr,
                child
                    .stderr
                    .take()
                    .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
            ),
        ] {
            let Some(pipe) = pipe else { continue };
            readers += 1;
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(pipe);
                let mut raw = Vec::new();
                loop {
                    raw.clear();
                    match reader.read_until(b'\n', &mut raw) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if tx.send(Msg::Line(stream, decode_line(&raw))).is_err() {
                        break;
                    }
                }
                let _ = tx.send(Msg::Eof);
            });
        }
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Exited(child.wait()));
        });

        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut status = None;
        let mut deadline: Option<Instant> = None;
        while readers > 0 || status.is_none() {
            let msg = match deadline {
                None => rx.recv().ok(),
                Some(d) => rx
                    .recv_timeout(d.saturating_duration_since(Instant::now()))
                    .ok(),
            };
            match msg {
                // Timed out draining, or every sender is gone.
                None => break,
                Some(Msg::Line(stream, line)) => {
                    sink.output(stream, &line);
                    match stream {
                        Stream::Stdout => push_capped(&mut stdout, &line),
                        Stream::Stderr => push_capped(&mut stderr, &line),
                    }
                }
                Some(Msg::Eof) => readers -= 1,
                Some(Msg::Exited(s)) => {
                    status = Some(s);
                    deadline = Some(Instant::now() + STREAM_DRAIN_GRACE);
                }
            }
        }
        if let Some(t) = stdin_thread {
            let _ = t.join();
        }

        let status = status
            .unwrap_or_else(|| Err(std::io::Error::other("git exited without a status")))
            .map_err(|e| GitErrorPayload::internal(format!("{display}: {e}")))?;
        let exit_code = status.code().unwrap_or(-1);
        if self.success_exit_codes.contains(&exit_code) {
            Ok(GitOutput {
                exit_code,
                stdout,
                stderr,
            })
        } else {
            Err(error::payload(display, status.code(), &stderr, &stdout))
        }
    }
}

/// How long [`GitCommand::run_streaming`] keeps reading after git exits.
const STREAM_DRAIN_GRACE: Duration = Duration::from_millis(500);

/// One raw line as text: the trailing `\n` / `\r\n` dropped, as
/// [`BufRead::lines`] does, but bytes that are not UTF-8 (a Windows console
/// codepage, a test printing a binary fixture) replaced instead of ending
/// the stream.
fn decode_line(raw: &[u8]) -> String {
    let raw = raw.strip_suffix(b"\n").unwrap_or(raw);
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    String::from_utf8_lossy(raw).into_owned()
}

/// `wait_with_output` with a deadline: `Ok(None)` once `limit` passes, after
/// killing the child. Pipes drain on their own threads so a chatty child
/// can't block on a full pipe while we poll. On expiry those threads are
/// left to finish by themselves rather than joined — a helper git spawned
/// (`ssh`, `git-remote-https`) can hold the pipes open briefly after git
/// itself dies, and it exits once it sees its parent gone.
fn wait_with_deadline(
    mut child: Child,
    limit: Duration,
) -> std::io::Result<Option<std::process::Output>> {
    use std::io::Read;
    fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(std::process::Output {
                status,
                stdout: out.join().unwrap_or_default(),
                stderr: err.join().unwrap_or_default(),
            }));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn timed_out(display: &str, limit: Duration) -> GitErrorPayload {
    let message = format!("{display} timed out after {}s", limit.as_secs());
    GitErrorPayload {
        code: error::GitErrorCode::NetworkError,
        raw_stderr: message.clone(),
        message,
        command: display.to_string(),
        exit_code: None,
        files: Vec::new(),
        hint: None,
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

    fn temp_repo() -> tempfile::TempDir {
        // `SystemTime` names collide when these tests start together, making
        // concurrent `git init` calls race while copying template files.
        // TempDir reserves a unique directory atomically and removes it on
        // drop, covering both parallel tests and failed assertions.
        let root = tempfile::Builder::new()
            .prefix("atlas-git-exec-")
            .tempdir()
            .unwrap();
        GitCommand::new(root.path(), &["init", "-q", "-b", "main"])
            .run()
            .unwrap();
        root
    }

    #[test]
    fn run_success_and_typed_failure() {
        let repo = temp_repo();
        let out = GitCommand::new(repo.path(), &["status", "--porcelain"])
            .read_only()
            .run()
            .unwrap();
        assert_eq!(out.exit_code, 0);

        // Unknown ref → typed error, not a raw string.
        let err = GitCommand::new(repo.path(), &["log", "no-such-ref"])
            .run()
            .unwrap_err();
        assert_eq!(err.code, crate::GitErrorCode::UnknownRef);
        assert!(!err.raw_stderr.is_empty());
    }

    #[test]
    fn timeout_kills_and_returns_promptly() {
        let repo = temp_repo();
        // A shell alias whose grandchild outlives the killed git and holds the
        // pipes open — the case where joining the readers would hang.
        let started = Instant::now();
        let err = GitCommand::new(repo.path(), &["-c", "alias.slow=!sleep 10", "slow"])
            .timeout(Duration::from_millis(300))
            .run()
            .unwrap_err();
        assert_eq!(err.code, crate::GitErrorCode::NetworkError);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );

        // Within the limit, a timed run behaves exactly like an untimed one.
        let out = GitCommand::new(repo.path(), &["status", "--porcelain"])
            .timeout(Duration::from_secs(30))
            .run()
            .unwrap();
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn success_codes_contract() {
        let repo = temp_repo();
        // `git diff --check` on a clean tree exits 0; asking for an accepted
        // extra code must not break the success path.
        let out = GitCommand::new(repo.path(), &["diff", "--check"])
            .success_codes(&[0, 2])
            .run()
            .unwrap();
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn streaming_forwards_lines_and_stdin() {
        let repo = temp_repo();
        std::fs::write(repo.path().join("f.txt"), "hello\n").unwrap();
        GitCommand::new(repo.path(), &["add", "f.txt"])
            .run()
            .unwrap();

        let sink = CollectSink(Mutex::new(Vec::new()));
        let out = GitCommand::new(repo.path(), &["commit", "-F", "-"])
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
            lines
                .iter()
                .any(|(_, l)| l.contains("streamed commit message")),
            "commit summary should stream through the sink: {lines:?}"
        );
    }

    /// A repo with one staged file and `hook` installed as its pre-commit.
    fn repo_with_pre_commit(hook: &str) -> tempfile::TempDir {
        let repo = temp_repo();
        std::fs::write(repo.path().join("f.txt"), "hello\n").unwrap();
        GitCommand::new(repo.path(), &["add", "f.txt"])
            .run()
            .unwrap();
        let hooks = repo.path().join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let path = hooks.join("pre-commit");
        std::fs::write(&path, hook).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        repo
    }

    fn streamed_commit(
        repo: &std::path::Path,
        sink: &CollectSink,
    ) -> Result<GitOutput, GitErrorPayload> {
        GitCommand::new(repo, &["commit", "-q", "-F", "-"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .stdin(b"msg\n".to_vec())
            .run_streaming(sink)
    }

    /// Hook output is not always UTF-8 (a Windows console codepage, a test
    /// printing a binary fixture). One such line must not end the stream:
    /// the reader used to stop there, closing the pipe under the hook.
    #[test]
    fn streaming_survives_non_utf8_output() {
        let repo = repo_with_pre_commit(
            "#!/bin/sh\nprintf 'caf\\351 \\377\\n'\ni=0\nwhile [ $i -lt 3000 ]; do echo \"after $i\"; i=$((i+1)); done\n",
        );
        let sink = CollectSink(Mutex::new(Vec::new()));
        let out = streamed_commit(repo.path(), &sink).unwrap();
        assert_eq!(out.exit_code, 0);
        let lines = sink.0.lock().unwrap();
        assert!(lines.iter().any(|(_, l)| l.starts_with("caf")), "{lines:?}");
        assert!(lines.iter().any(|(_, l)| l == "after 2999"));
        // git sends hook stdout to its own stderr.
        assert!(out.stderr.contains("after 2999"));
    }

    /// A hook that leaves a background process behind (a test runner's
    /// daemon, a watcher) hands it the pipes. Git is done; the operation must
    /// be too, not wait for that process to exit.
    #[test]
    fn streaming_returns_when_git_exits_despite_lingering_grandchild() {
        let repo =
            repo_with_pre_commit("#!/bin/sh\necho hook-ran\n(sleep 20; echo late) &\nexit 0\n");
        let sink = CollectSink(Mutex::new(Vec::new()));
        let started = Instant::now();
        let out = streamed_commit(repo.path(), &sink).unwrap();
        assert_eq!(out.exit_code, 0);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "took {:?}",
            started.elapsed()
        );
        assert!(sink.0.lock().unwrap().iter().any(|(_, l)| l == "hook-ran"));
    }

    /// Stage all on a big change set: well past Windows' 32,767-character
    /// command line when the paths go on argv.
    #[test]
    fn pathspecs_over_stdin_handle_huge_file_lists() {
        let repo = temp_repo();
        let dir = repo.path().join("a-fairly-long-directory-name-for-padding");
        std::fs::create_dir_all(&dir).unwrap();
        let mut files = Vec::new();
        for i in 0..2500 {
            let rel = format!("a-fairly-long-directory-name-for-padding/file with space {i}.txt");
            std::fs::write(repo.path().join(&rel), "x\n").unwrap();
            files.push(rel);
        }
        assert!(files.iter().map(|f| f.len() + 1).sum::<usize>() > 100_000);
        GitCommand::new(repo.path(), &["add"])
            .pathspecs(&files)
            .run()
            .unwrap();
        let staged = GitCommand::new(repo.path(), &["diff", "--cached", "--name-only"])
            .run()
            .unwrap();
        assert_eq!(staged.stdout.lines().count(), 2500);

        GitCommand::new(repo.path(), &["rm", "-q", "--cached", "--ignore-unmatch"])
            .pathspecs(&files[..10])
            .run()
            .unwrap();
        let staged = GitCommand::new(repo.path(), &["diff", "--cached", "--name-only"])
            .run()
            .unwrap();
        assert_eq!(staged.stdout.lines().count(), 2490);
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

    /// The cap used to slice the str at a byte offset, which panics inside a
    /// multi-byte character — the `✓` every passing test prints — and killed
    /// the operation once a hook had printed 256 KB.
    #[test]
    fn tail_cap_survives_multibyte_characters() {
        for pad in 0..4 {
            let mut buf = String::new();
            let prefix = "x".repeat(pad);
            for i in 0..10_000 {
                push_capped(
                    &mut buf,
                    &format!("{prefix}  ✓ suite › case {i} passed (1.2ms)"),
                );
            }
            assert!(buf.len() <= TAIL_CAP);
            assert!(buf.ends_with("case 9999 passed (1.2ms)\n"));
            assert!(buf.starts_with(&prefix));
        }
    }
}
