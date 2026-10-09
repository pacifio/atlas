//! `atlas mcp-bridge <url> <token file>`: a stdio MCP server that forwards
//! every message to Atlas's own loopback tool server (ADR-0019), for every
//! agent that runs in another process (ADR-0020). The session token is read
//! from a file only this user can read ([`TokenFiles`]); the command line
//! names the file, never the token, because an agent may put the whole MCP
//! entry — arguments and environment alike — on its own command line, where
//! any local user's `ps` reads it.
//!
//! One JSON-RPC message per input line is POSTed to the server; every
//! message in the answer (a JSON body, or each SSE `data:` line) is written
//! back as one line, whatever the HTTP status. The MCP session id the server
//! hands out on `initialize` rides every later request, with the protocol
//! version that `initialize` negotiated. When the server has dropped the
//! session, the client's own handshake is replayed to open a new one.

use anyhow::{bail, Result};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// Where offered sessions' tokens are written for the bridge to read: one
/// file per offer, readable only by this user, in a directory of this
/// launch's own that only this user can enter.
///
/// Tokens live in Atlas's memory, so a file whose token is dead holds nothing
/// that opens anything; the files are tidied all the same. An offer released
/// unbound removes its file, and a bound one's goes when its session ends
/// ([`session_ended`](Self::session_ended)); every write sweeps this launch's
/// files whose token has since been revoked; and at startup
/// ([`sweep_stale_launches`](Self::sweep_stale_launches), off the runtime)
/// the directories of launches that have ended and were untouched for
/// [`STALE_LAUNCH`] go. Never another live launch's directory: a dev build
/// and the installed app run side by side on one data directory, and a
/// bridge an agent relaunches reads its file again. A live launch holds a
/// lock on its directory's [`LOCK_FILE`] for as long as it runs, and
/// refreshes that file's mtime on every write.
pub struct TokenFiles {
    root: std::path::PathBuf,
    dir: std::path::PathBuf,
    /// This launch's directory, made on the first write; holds the lock.
    prepared: std::sync::OnceLock<std::result::Result<std::fs::File, String>>,
    written: std::sync::Mutex<Vec<Written>>,
    /// A test's root, removed when it drops (even after a failed assertion).
    #[cfg(test)]
    _temp: Option<tempfile::TempDir>,
}

/// One file [`TokenFiles::write`] made: its token, and the session it was
/// bound to once the agent answered.
struct Written {
    path: std::path::PathBuf,
    token: String,
    session: Option<String>,
}

/// A launch directory not written for this long, whose launch has ended,
/// is swept.
pub const STALE_LAUNCH: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// The file in a launch directory its launch holds locked while it runs.
pub const LOCK_FILE: &str = ".launch.lock";

impl TokenFiles {
    /// Token files under `root`, which belongs to Atlas alone, in a directory
    /// of this launch's own.
    pub fn new(root: std::path::PathBuf) -> Self {
        let dir = root.join(uuid::Uuid::new_v4().simple().to_string());
        Self {
            root,
            dir,
            prepared: std::sync::OnceLock::new(),
            written: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            _temp: None,
        }
    }

    /// Token files under a fresh directory of their own in the system's
    /// temporary directory: for a host that names none. Nothing is created
    /// until the first write.
    #[cfg(not(test))]
    pub fn in_temp() -> Self {
        Self::new(std::env::temp_dir().join(format!(
            "atlas-mcp-bridge-{}",
            uuid::Uuid::new_v4().simple()
        )))
    }

    /// In tests, a [`tempfile::TempDir`] removed when these files drop.
    #[cfg(test)]
    pub fn in_temp() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("atlas-mcp-bridge-test-")
            .tempdir()
            .expect("a temporary directory");
        let mut files = Self::new(temp.path().join("mcp-bridge"));
        files._temp = Some(temp);
        files
    }

    fn written(&self) -> std::sync::MutexGuard<'_, Vec<Written>> {
        self.written
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Write `token` to a new file of its own and return its path, first
    /// removing this launch's files whose token `is_live` no longer admits.
    /// A few small syscalls: the stale-launch sweep is
    /// [`sweep_stale_launches`](Self::sweep_stale_launches)'s, at startup.
    pub fn write(&self, token: &str, is_live: impl Fn(&str) -> bool) -> Result<std::path::PathBuf> {
        let lock = self
            .prepared
            .get_or_init(|| self.prepare().map_err(|e| format!("{e:#}")))
            .as_ref()
            .map_err(|e| anyhow::Error::msg(e.clone()))?;
        // This launch is in use: its directory reads as fresh to a sweep.
        let _ = lock.set_modified(std::time::SystemTime::now());
        let mut written = self.written();
        written.retain(|w| {
            let live = is_live(&w.token);
            if !live {
                let _ = std::fs::remove_file(&w.path);
            }
            live
        });
        let path = self
            .dir
            .join(format!("{}.token", uuid::Uuid::new_v4().simple()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&path)?;
        std::io::Write::write_all(&mut file, token.as_bytes())?;
        written.push(Written {
            path: path.clone(),
            token: token.to_string(),
            session: None,
        });
        Ok(path)
    }

    /// The file at `path` now belongs to `session_id`: it goes when that
    /// session ends. Any earlier file of that session goes now (binding a
    /// new token revoked the old one).
    pub fn bind(&self, path: &std::path::Path, session_id: &str) {
        let mut written = self.written();
        written.retain(|w| {
            let earlier = w.path != path && w.session.as_deref() == Some(session_id);
            if earlier {
                let _ = std::fs::remove_file(&w.path);
            }
            !earlier
        });
        if let Some(w) = written.iter_mut().find(|w| w.path == path) {
            w.session = Some(session_id.to_string());
        }
    }

    /// Remove the files of `session_id`, which has ended. Idempotent.
    pub fn session_ended(&self, session_id: &str) {
        self.written().retain(|w| {
            let ended = w.session.as_deref() == Some(session_id);
            if ended {
                let _ = std::fs::remove_file(&w.path);
            }
            !ended
        });
    }

    /// Remove a file [`write`](Self::write) made. Idempotent.
    pub fn remove(&self, path: &std::path::Path) {
        self.written().retain(|w| w.path != path);
        if path.parent() == Some(self.dir.as_path()) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Remove the directories of ended launches untouched for
    /// [`STALE_LAUNCH`]: never this launch's, nor one whose [`LOCK_FILE`] is
    /// held (its launch is running, however long since it wrote). Blocking
    /// file I/O, run once at startup on a blocking thread.
    pub fn sweep_stale_launches(&self) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == self.dir || !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if launch_is_stale(&path) {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }

    /// The root, enterable only by this user; this launch's directory made
    /// with `create_dir`, never through an existing path, so nobody else's
    /// directory (or a link to one) is adopted; and its lock, held from now
    /// until this launch ends.
    fn prepare(&self) -> Result<std::fs::File> {
        std::fs::create_dir_all(&self.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&self.dir)?;
        let lock = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.dir.join(LOCK_FILE))?;
        lock.try_lock()
            .map_err(|e| anyhow::anyhow!("cannot lock this launch's token directory: {e}"))?;
        Ok(lock)
    }
}

/// Whether the launch directory `dir` belongs to a launch that has ended and
/// was untouched for [`STALE_LAUNCH`]: by its [`LOCK_FILE`]'s mtime (which
/// every write refreshes) when it has one, else by the directory's own.
fn launch_is_stale(dir: &std::path::Path) -> bool {
    let lock_path = dir.join(LOCK_FILE);
    let modified = std::fs::metadata(&lock_path)
        .or_else(|_| std::fs::metadata(dir))
        .and_then(|m| m.modified());
    let old = modified
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > STALE_LAUNCH);
    if !old {
        return false;
    }
    // A held lock is a running launch. A lock file that cannot be opened is
    // left alone: nothing proves its launch has ended.
    match std::fs::OpenOptions::new().write(true).open(&lock_path) {
        Ok(file) => file.try_lock().is_ok(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// The token in the file the bridge was pointed at.
pub fn read_token_file(path: &std::path::Path) -> Result<String> {
    let token = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("cannot read the token file {}: {e}", path.display()))?;
    let token = token.trim();
    if token.is_empty() {
        bail!("the token file {} is empty", path.display());
    }
    Ok(token.to_string())
}

/// Forward `input` to the server at `url` until `input` ends.
pub async fn bridge(
    url: &str,
    token: &str,
    input: impl AsyncBufRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<()> {
    let server = Server {
        url: loopback_url(url)?,
        // Loopback only, so never through a proxy from the agent's
        // environment: it could not reach this machine's loopback, and the
        // token would land in its logs.
        client: reqwest::Client::builder().no_proxy().build()?,
        token,
    };
    let mut session: Option<String> = None;
    let mut protocol: Option<String> = None;
    // The client's handshake, kept to open a new session with.
    let mut initialize: Option<String> = None;
    let mut initialized: Option<String> = None;
    let mut lines = input.lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(&line).unwrap_or_default();
        let method = message.get("method").and_then(Value::as_str);
        match method {
            Some("initialize") => initialize = Some(line.clone()),
            Some("notifications/initialized") => initialized = Some(line.clone()),
            _ => {}
        }
        // `initialize` carries its version in the body, and a header that
        // disagreed with it would be refused.
        let is_init = method == Some("initialize");
        let mut answer = server
            .post(
                &line,
                session.as_deref(),
                protocol.as_deref().filter(|_| !is_init),
            )
            .await?;
        if answer.status == reqwest::StatusCode::NOT_FOUND
            && session.is_some()
            && !answer.is_jsonrpc()
        {
            // The server no longer knows the session (it idled out, or the
            // app restarted the server): open a new one with the client's
            // handshake, dropping its answers, and retry this line once.
            if let Some(init) = &initialize {
                let opened = server.post(init, None, None).await?;
                protocol = opened.protocol_version().or(protocol);
                session = opened.session;
                if let Some(note) = &initialized {
                    server
                        .post(note, session.as_deref(), protocol.as_deref())
                        .await?;
                }
                answer = server
                    .post(
                        &line,
                        session.as_deref(),
                        protocol.as_deref().filter(|_| !is_init),
                    )
                    .await?;
            }
        }
        if let Some(id) = answer.session.take() {
            session = Some(id);
        }
        if is_init {
            protocol = answer.protocol_version().or(protocol);
        }
        // A JSON-RPC error is the client's to read, whatever the status;
        // only an answer that is not JSON-RPC at all ends the bridge.
        if !answer.status.is_success() && !answer.is_jsonrpc() {
            bail!(
                "the memory server answered {}: {}",
                answer.status,
                answer.body.trim()
            );
        }
        for message in &answer.messages {
            output.write_all(message.as_bytes()).await?;
            output.write_all(b"\n").await?;
        }
        output.flush().await?;
    }
    Ok(())
}

/// `url` parsed, when it names Atlas's loopback server: plain `http` to
/// `localhost` or a loopback address, with no userinfo (which would move the
/// real host past the `@`).
fn loopback_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).ok().filter(|u| {
        let host = u.host_str().unwrap_or_default();
        let loopback = host == "localhost"
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback());
        u.scheme() == "http" && loopback && u.username().is_empty() && u.password().is_none()
    });
    match parsed {
        Some(url) => Ok(url),
        None => bail!("the bridge only forwards to Atlas's loopback server"),
    }
}

/// Where the bridge forwards to.
struct Server<'a> {
    url: reqwest::Url,
    client: reqwest::Client,
    token: &'a str,
}

/// One answer from the server.
struct Answer {
    status: reqwest::StatusCode,
    /// The `Mcp-Session-Id` it handed out, if any.
    session: Option<String>,
    body: String,
    messages: Vec<String>,
}

impl Server<'_> {
    /// POST one message, with the session id and protocol version if known.
    async fn post(
        &self,
        line: &str,
        session: Option<&str>,
        protocol: Option<&str>,
    ) -> Result<Answer> {
        let mut req = self
            .client
            .post(self.url.clone())
            .bearer_auth(self.token)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(line.to_owned());
        if let Some(id) = session {
            req = req.header("Mcp-Session-Id", id);
        }
        if let Some(version) = protocol {
            req = req.header("MCP-Protocol-Version", version);
        }
        let resp = req.send().await?;
        let session = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let status = resp.status();
        let is_sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.starts_with("text/event-stream"));
        let body = resp.text().await?;
        let messages = messages(&body, is_sse);
        Ok(Answer {
            status,
            session,
            body,
            messages,
        })
    }
}

impl Answer {
    /// Whether the answer is one or more JSON-RPC messages.
    fn is_jsonrpc(&self) -> bool {
        !self.messages.is_empty()
            && self
                .messages
                .iter()
                .all(|m| serde_json::from_str::<Value>(m).is_ok_and(|v| v.get("jsonrpc").is_some()))
    }

    /// The protocol version an `initialize` result negotiated.
    fn protocol_version(&self) -> Option<String> {
        self.messages.iter().find_map(|m| {
            serde_json::from_str::<Value>(m)
                .ok()?
                .pointer("/result/protocolVersion")?
                .as_str()
                .map(str::to_owned)
        })
    }
}

/// The JSON-RPC messages in one answer: each SSE `data:` line, or the JSON
/// body. A notification's `202` has none.
fn messages(body: &str, is_sse: bool) -> Vec<String> {
    if is_sse {
        body.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect()
    } else if body.trim().is_empty() {
        Vec::new()
    } else {
        vec![body.trim().to_string()]
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::io::BufReader;

    use super::*;

    const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bridge-test","version":"0"}}}"#;
    const INITIALIZED: &str = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;

    /// A real MCP server on loopback whose sessions end after `keep_alive`
    /// without a request.
    async fn mcp_server(keep_alive: Duration) -> String {
        use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
        use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
        struct Quiet;
        impl rmcp::ServerHandler for Quiet {}
        let mut sessions = LocalSessionManager::default();
        sessions.session_config.keep_alive = Some(keep_alive);
        let service = StreamableHttpService::new(
            || Ok(Quiet),
            Arc::new(sessions),
            StreamableHttpServerConfig::default(),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, axum::Router::new().nest_service("/mcp", service)).await
        });
        format!("http://{addr}/mcp")
    }

    /// A stand-in server: `initialize` answers with a session and a
    /// negotiated version, `fail` with a plain-text 500, anything else with
    /// a JSON-RPC error under HTTP 400. Each answer names the
    /// `MCP-Protocol-Version` the request carried.
    async fn erring_server() -> String {
        use axum::http::{HeaderMap, StatusCode};
        let app = axum::Router::new().route(
            "/mcp",
            axum::routing::post(|headers: HeaderMap, body: String| async move {
                let sent = headers
                    .get("mcp-protocol-version")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("none")
                    .to_owned();
                let json = [
                    ("content-type", "application/json".to_owned()),
                    ("mcp-session-id", "s1".to_owned()),
                ];
                if body.contains(r#""initialize""#) {
                    (
                        StatusCode::OK,
                        json,
                        format!(
                            r#"{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2025-06-18","sent":"{sent}"}}}}"#
                        ),
                    )
                } else if body.contains(r#""fail""#) {
                    (StatusCode::INTERNAL_SERVER_ERROR, json, "broken".to_owned())
                } else {
                    (
                        StatusCode::BAD_REQUEST,
                        json,
                        format!(
                            r#"{{"jsonrpc":"2.0","id":2,"error":{{"code":-32602,"message":"sent {sent}"}}}}"#
                        ),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{addr}/mcp")
    }

    /// The token travels in a file only this user can read, in a directory
    /// only this user can enter; the bridge reads it back.
    #[test]
    fn a_token_file_is_private_and_reads_back() {
        let files = TokenFiles::in_temp();
        let path = files.write("secret-token", |_| true).unwrap();
        assert_eq!(read_token_file(&path).unwrap(), "secret-token");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode();
            assert_eq!(mode(&path) & 0o777, 0o600);
            assert_eq!(mode(path.parent().unwrap()) & 0o777, 0o700);
            assert_eq!(mode(&files.root) & 0o777, 0o700);
        }
        files.remove(&path);
        assert!(read_token_file(&path).is_err());
    }

    /// A file whose token was revoked goes at the next write; another live
    /// launch's directory under the same root is left alone.
    #[test]
    fn dead_tokens_files_are_swept_and_other_launches_are_left_alone() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().to_path_buf();
        let other = TokenFiles::new(root.clone());
        let theirs = other.write("theirs", |_| true).unwrap();
        let files = TokenFiles::new(root);
        let dead = files.write("dead", |_| true).unwrap();
        let live = files.write("live", |_| true).unwrap();
        let next = files.write("next", |t| t != "dead").unwrap();
        assert!(!dead.exists(), "a revoked token's file is swept");
        assert!(live.exists() && next.exists());
        files.sweep_stale_launches();
        assert!(theirs.exists(), "another launch's file stays");
    }

    /// Set `path`'s mtime to longer ago than [`STALE_LAUNCH`].
    fn age(path: &std::path::Path) {
        let then = std::time::SystemTime::now() - STALE_LAUNCH - std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(then)
            .unwrap();
    }

    /// A running launch's directory is never swept, however long since it
    /// last wrote; an ended one's is, once untouched for [`STALE_LAUNCH`];
    /// an ended one written recently is not yet.
    #[test]
    fn only_ended_launches_untouched_for_a_week_are_swept() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().to_path_buf();
        let running = TokenFiles::new(root.clone());
        let running_file = running.write("r", |_| true).unwrap();
        age(&running.dir.join(LOCK_FILE));
        let ended = TokenFiles::new(root.clone());
        let ended_file = ended.write("e", |_| true).unwrap();
        let ended_dir = ended.dir.clone();
        drop(ended);
        age(&ended_dir.join(LOCK_FILE));
        let recent = TokenFiles::new(root.clone());
        let recent_file = recent.write("n", |_| true).unwrap();
        drop(recent);

        let starting = TokenFiles::new(root);
        starting.sweep_stale_launches();
        assert!(running_file.exists(), "a running launch keeps its files");
        assert!(
            !ended_file.exists() && !ended_dir.exists(),
            "an ended, week-old launch goes"
        );
        assert!(
            recent_file.exists(),
            "an ended launch written recently stays for now"
        );
    }

    /// Every write marks the launch as in use, so its age is the time since
    /// its last write, not since it started.
    #[test]
    fn a_write_refreshes_the_launch() {
        let files = TokenFiles::in_temp();
        files.write("a", |_| true).unwrap();
        let lock = files.dir.join(LOCK_FILE);
        age(&lock);
        assert!(launch_is_stale_by_age(&lock));
        files.write("b", |_| true).unwrap();
        assert!(!launch_is_stale_by_age(&lock));
    }

    fn launch_is_stale_by_age(lock: &std::path::Path) -> bool {
        std::fs::metadata(lock)
            .unwrap()
            .modified()
            .unwrap()
            .elapsed()
            .is_ok_and(|a| a > STALE_LAUNCH)
    }

    /// A bound file goes when its session ends; one bound to another session
    /// stays; rebinding a session drops its earlier file.
    #[test]
    fn a_bound_file_goes_when_its_session_ends() {
        let files = TokenFiles::in_temp();
        let first = files.write("t1", |_| true).unwrap();
        let other = files.write("t2", |_| true).unwrap();
        files.bind(&first, "s1");
        files.bind(&other, "s2");
        let again = files.write("t3", |_| true).unwrap();
        files.bind(&again, "s1");
        assert!(!first.exists(), "the session's earlier file goes on rebind");
        files.session_ended("s1");
        assert!(!again.exists(), "an ended session's file goes");
        assert!(other.exists(), "another session's file stays");
        files.session_ended("s1");
    }

    #[test]
    fn an_answer_is_its_sse_data_lines_or_its_body() {
        let sse = "id: 0\ndata:\n\nevent: message\ndata: {\"id\":1}\n\n";
        assert_eq!(messages(sse, true), ["{\"id\":1}"]);
        assert_eq!(messages(" {\"id\":2} ", false), ["{\"id\":2}"]);
        assert!(messages("", false).is_empty());
    }

    #[test]
    fn only_plain_http_to_a_loopback_host_is_forwarded() {
        for ok in [
            "http://127.0.0.1:5/mcp",
            "http://localhost:5/mcp",
            "http://127.0.0.2:5/mcp",
            "http://[::1]:5/mcp",
        ] {
            assert!(loopback_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "https://example.com/mcp",
            "https://127.0.0.1:5/mcp",
            "http://127.0.0.1:1@attacker.example/mcp",
            "http://localhost:80@evil.com/",
            "http://user@127.0.0.1:5/mcp",
            "http://localhost.evil.com:1/",
            "http://10.0.0.1:5/mcp",
            "not a url",
        ] {
            assert!(loopback_url(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn the_bridge_refuses_anything_but_loopback() {
        for url in [
            "https://example.com/mcp",
            "http://127.0.0.1:1@attacker.example/mcp",
            "http://localhost.evil.com:1/",
        ] {
            let err = bridge(url, "t", BufReader::new(&b""[..]), Vec::new())
                .await
                .unwrap_err();
            assert!(err.to_string().contains("loopback"), "{url}: {err}");
        }
    }

    /// A JSON-RPC error comes back to the client as its line whatever the
    /// HTTP status, later requests carry the negotiated protocol version,
    /// and only an answer that is not JSON-RPC ends the bridge.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_json_rpc_error_is_relayed_whatever_the_status() {
        let url = erring_server().await;
        let (mut to_bridge, bridge_in) = tokio::io::duplex(64 * 1024);
        let (bridge_out, from_bridge) = tokio::io::duplex(64 * 1024);
        let run =
            tokio::spawn(
                async move { bridge(&url, "t", BufReader::new(bridge_in), bridge_out).await },
            );
        for line in [
            INITIALIZE,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call"}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"fail"}"#,
        ] {
            to_bridge.write_all(line.as_bytes()).await.unwrap();
            to_bridge.write_all(b"\n").await.unwrap();
        }
        let mut lines = BufReader::new(from_bridge).lines();
        let first = lines.next_line().await.unwrap().unwrap();
        assert!(first.contains(r#""sent":"none""#), "{first}");
        let second = lines.next_line().await.unwrap().unwrap();
        assert!(second.contains(r#""error""#), "{second}");
        assert!(second.contains("sent 2025-06-18"), "{second}");
        let err = run.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("500"), "{err}");
        drop(to_bridge);
    }

    /// A session the server dropped for idling does not end the bridge: the
    /// client's handshake is replayed and the request retried.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_the_server_dropped_is_opened_again() {
        let url = mcp_server(Duration::from_millis(200)).await;
        let (mut to_bridge, bridge_in) = tokio::io::duplex(64 * 1024);
        let (bridge_out, from_bridge) = tokio::io::duplex(64 * 1024);
        let run =
            tokio::spawn(
                async move { bridge(&url, "t", BufReader::new(bridge_in), bridge_out).await },
            );
        for line in [
            INITIALIZE,
            INITIALIZED,
            r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#,
        ] {
            to_bridge.write_all(line.as_bytes()).await.unwrap();
            to_bridge.write_all(b"\n").await.unwrap();
        }
        let mut lines = BufReader::new(from_bridge).lines();
        let first = lines.next_line().await.unwrap().unwrap();
        assert!(first.contains(r#""id":1"#), "{first}");
        let second = lines.next_line().await.unwrap().unwrap();
        assert!(second.contains(r#""id":2"#), "{second}");
        // Well past the keep-alive: the server has closed the session.
        tokio::time::sleep(Duration::from_secs(1)).await;
        to_bridge
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let third = lines.next_line().await.unwrap().unwrap();
        assert!(
            third.contains(r#""id":3"#) && third.contains(r#""result""#),
            "{third}"
        );
        drop(to_bridge);
        run.await.unwrap().unwrap();
    }
}
