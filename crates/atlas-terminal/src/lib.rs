pub mod command;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::mpsc;
use uuid::Uuid;

pub struct TerminalSession {
    /// Kept alive (rather than dropped after taking the writer/reader) so
    /// `resize` can drive `MasterPty::resize` — the previous build dropped
    /// the pair and resize was a silent no-op, leaving columns clipped after
    /// a pane resize.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// PID of the spawned login shell. Used by `cwd` to resolve relative file
    /// paths clicked in the terminal against the shell's live directory.
    pid: Option<u32>,
    _reader_handle: std::thread::JoinHandle<()>,
}

pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalOutput {
    pub id: String,
    pub data: Vec<u8>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn create_session(
        &mut self,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        // BOUNDED. When the consumer falls behind, `blocking_send` parks this
        // session's reader thread, the kernel tty queue fills, and the child's
        // write() stalls — real flow control instead of unbounded buffering
        // (the same backpressure shape Ghostty's fixed ring of read buffers
        // produces). Nothing is ever dropped.
        sender: mpsc::Sender<TerminalOutput>,
    ) -> anyhow::Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = detect_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l"); // login shell — sources the user's profile so PATH etc. are correct
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        // Set TERM for proper terminal behavior.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Ensure a UTF-8 locale even if the user's profile doesn't set one,
        // so box-drawing / multi-byte glyphs render correctly.
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        // Shell integration: for zsh (the macOS default) point ZDOTDIR at a
        // generated dir whose rc files chain to the user's config and add
        // OSC 133 / OSC 7 / command hooks. That lets the frontend segment
        // output into command "blocks" with exit codes + cwd.
        // Non-zsh shells run plain (the UI degrades to a single stream).
        if shell.ends_with("zsh") {
            if let Some(dir) = ensure_zsh_integration_dir() {
                let user_zdotdir = std::env::var("ZDOTDIR")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| std::env::var("HOME").ok())
                    .unwrap_or_default();
                cmd.env("ATLAS_USER_ZDOTDIR", user_zdotdir);
                cmd.env("ZDOTDIR", dir.to_string_lossy().to_string());
            }
        }

        let mut child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id();
        drop(pair.slave); // drop slave so reads on master detect EOF

        let writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;
        // Retain the master so resize works for the session's lifetime.
        let master = Arc::new(Mutex::new(pair.master));

        let id = Uuid::new_v4().to_string();
        let session_id = id.clone();

        let reader_handle = std::thread::spawn(move || {
            // 64 KiB read buffer (was 4 KiB) — fewer syscalls / channel sends
            // on high-throughput output (builds, `cat` of large files).
            let mut buf = vec![0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = TerminalOutput {
                            id: session_id.clone(),
                            data: buf[..n].to_vec(),
                        };
                        if sender.blocking_send(output).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            // Reap the shell. portable-pty's unix Child does not waitpid on
            // Drop, so without this every exited shell stayed <defunct> until
            // app quit. The reader unblocks exactly when the shell dies (EOF)
            // or the session closes (channel gone → master drops → shell gets
            // HUP), so wait() here returns promptly in both paths.
            let _ = child.wait();
        });

        self.sessions.insert(
            id.clone(),
            TerminalSession {
                master,
                writer: Arc::new(Mutex::new(writer)),
                pid,
                _reader_handle: reader_handle,
            },
        );

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal session not found: {}", id))?;
        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal session not found: {}", id))?;
        let master = session
            .master
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal master mutex poisoned"))?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Kill the PTY's foreground job without killing the login shell. Returns
    /// false when the shell already owns the foreground (the job exited, or the
    /// terminal is idle), which also makes a late force-stop click race-safe.
    pub fn kill_foreground(&self, id: &str) -> anyhow::Result<bool> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal session not found: {}", id))?;

        #[cfg(unix)]
        {
            let foreground = session
                .master
                .lock()
                .map_err(|_| anyhow::anyhow!("terminal master mutex poisoned"))?
                .process_group_leader();
            let Some(pgid) = foreground_job_pgid(session.pid, foreground) else {
                return Ok(false);
            };
            let result = unsafe { libc::kill(-pgid, libc::SIGKILL) };
            if result == 0 {
                return Ok(true);
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(false);
            }
            Err(error.into())
        }

        #[cfg(not(unix))]
        {
            let _ = session;
            anyhow::bail!("Force stopping foreground terminal jobs is unsupported on this platform")
        }
    }

    pub fn close(&mut self, id: &str) {
        self.sessions.remove(id);
    }

    /// PID of the session's login shell (for `cwd_of_pid`).
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.sessions.get(id)?.pid
    }

    /// A handle for sampling this session's tty line discipline. See
    /// [`TtyModeProbe`].
    pub fn mode_probe(&self, id: &str) -> Option<TtyModeProbe> {
        Some(TtyModeProbe {
            master: Arc::downgrade(&self.sessions.get(id)?.master),
        })
    }
}

/// Samples whether the pty is in raw mode, so the UI can tell a full-screen /
/// inline TUI apart from a program reading lines.
///
/// Reads the termios of the MASTER fd: on both macOS and Linux the master
/// reports the slave's line discipline, so this sees an app's `tcsetattr` in
/// the child without any cooperation from it.
///
/// Holds a `Weak` deliberately — the master must stay droppable by
/// `TerminalManager::close` or the shell never gets its HUP, and a probe that
/// outlived the session would otherwise ioctl a recycled fd.
pub struct TtyModeProbe {
    master: Weak<Mutex<Box<dyn MasterPty + Send>>>,
}

impl TtyModeProbe {
    /// `Some(true)` when the tty is in raw mode (ICANON cleared); `None` once
    /// the session is gone or the ioctl fails.
    ///
    /// Raw mode ALONE does not mean an interactive app is running: zsh's line
    /// editor puts the tty in raw mode at every prompt, and a TUI that exits
    /// without restoring leaves it raw. Callers must pair this with "a command
    /// is currently running" — zsh restores cooked mode before it execs.
    pub fn is_raw(&self) -> Option<bool> {
        #[cfg(unix)]
        {
            let master = self.master.upgrade()?;
            let guard = master.lock().ok()?;
            let fd = guard.as_raw_fd()?;
            let mut attrs: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(fd, &mut attrs) } != 0 {
                return None;
            }
            Some(attrs.c_lflag & libc::ICANON == 0)
        }
        #[cfg(not(unix))]
        {
            let _ = &self.master;
            None
        }
    }
}

#[cfg(unix)]
fn foreground_job_pgid(shell_pid: Option<u32>, foreground_pgid: Option<i32>) -> Option<i32> {
    let pgid = foreground_pgid.filter(|pid| *pid > 0)?;
    (shell_pid != Some(pgid as u32)).then_some(pgid)
}

#[cfg(all(test, unix))]
mod tests {
    use super::foreground_job_pgid;

    #[test]
    fn foreground_job_excludes_the_login_shell() {
        assert_eq!(foreground_job_pgid(Some(42), Some(42)), None);
        assert_eq!(foreground_job_pgid(Some(42), Some(84)), Some(84));
        assert_eq!(foreground_job_pgid(Some(42), None), None);
        assert_eq!(foreground_job_pgid(Some(42), Some(0)), None);
    }
}

/// The live working directory of a shell pid, used to resolve relative file
/// paths clicked in the terminal. Linux reads the `/proc/<pid>/cwd` symlink;
/// macOS shells out to `lsof` (no `/proc`). BLOCKING (lsof) — call off-thread.
pub fn cwd_of_pid(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
    #[cfg(target_os = "macos")]
    {
        // `lsof -a -d cwd -p <pid> -Fn` prints `n<path>` for the cwd fd.
        let out = std::process::Command::new("lsof")
            .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        s.lines()
            .find_map(|l| l.strip_prefix('n').map(|p| p.to_string()))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

fn detect_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

// ── zsh shell integration ──────────────────────────────────────────────────
//
// Each rc file chains to the user's real config (under ATLAS_USER_ZDOTDIR),
// preserving ZDOTDIR across the source so plugins/configs that read it still
// work. `.zshrc` additionally installs precmd/preexec hooks that emit:
//   OSC 133 ; D ; <exit>   previous command ended (exit code)
//   OSC 133 ; A            new prompt
//   OSC 7   ; file://…      cwd
//   OSC 133 ; C            command output begins
//   OSC 6973 ; C ; <cmd>   the command text (Atlas-private OSC)

const ZSHENV: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zshenv" ] && source "$ATLAS_USER_ZDOTDIR/.zshenv"
ZDOTDIR="$ATLAS_SELF"
"#;

const ZPROFILE: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zprofile" ] && source "$ATLAS_USER_ZDOTDIR/.zprofile"
ZDOTDIR="$ATLAS_SELF"
"#;

const ZLOGIN: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zlogin" ] && source "$ATLAS_USER_ZDOTDIR/.zlogin"
ZDOTDIR="$ATLAS_SELF"
"#;

const ZSHRC: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zshrc" ] && source "$ATLAS_USER_ZDOTDIR/.zshrc"

# Atlas shell integration (OSC 133 prompt markers + cwd + command text).
# Suppress zsh's partial-line indicator (the reverse `%` shown at the end of
# output without a trailing newline) — in the block UI it just looks like junk.
unsetopt PROMPT_SP 2>/dev/null
PROMPT_EOL_MARK=''
autoload -Uz add-zsh-hook 2>/dev/null
_atlas_precmd() {
  local _atlas_exit=$?
  printf '\033]133;D;%s\007' "$_atlas_exit"
  printf '\033]133;A\007'
  printf '\033]7;file://%s%s\007' "${HOST}" "${PWD}"
}
_atlas_preexec() {
  # Emit the command text (6973) BEFORE the output-start marker (133;C) so the
  # parser has the command in hand when it opens the block — otherwise the very
  # first block opens with an empty header (off-by-one vs the previous command).
  printf '\033]6973;C;%s\007' "$1"
  printf '\033]133;C\007'
}
add-zsh-hook precmd _atlas_precmd 2>/dev/null
add-zsh-hook preexec _atlas_preexec 2>/dev/null

# Hand the interactive session the user's ZDOTDIR.
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
"#;

/// Public accessor for the zsh integration ZDOTDIR — used to relaunch an
/// interactive root shell (`sudo -s` / `-i` / `su`) WITH Atlas's shell
/// integration so command blocks / prompt markers keep working as root.
pub fn zsh_integration_dir() -> Option<std::path::PathBuf> {
    ensure_zsh_integration_dir()
}

/// Create (idempotently) the temp ZDOTDIR holding the zsh integration rc files
/// and return its path. `None` if the files can't be written.
fn ensure_zsh_integration_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join("atlas-zsh-integration");
    std::fs::create_dir_all(&dir).ok()?;
    for (name, body) in [
        (".zshenv", ZSHENV),
        (".zprofile", ZPROFILE),
        (".zlogin", ZLOGIN),
        (".zshrc", ZSHRC),
    ] {
        std::fs::write(dir.join(name), body).ok()?;
    }
    Some(dir)
}
