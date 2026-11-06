use atlas_terminal::TerminalManager;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex, Notify};

/// Max bytes per channel message. Big enough to amortize the per-message IPC
/// crossing, small enough that one message never stalls the JS main thread
/// (Tabby caps at 100 KB; Ghostty's per-lock parse unit is 64 KiB).
const MAX_CHUNK: usize = 128 * 1024;
/// Max unacknowledged chunks in flight to the webview. The JS side acks a
/// chunk only once xterm has PARSED it (batched), so this window is real
/// end-to-end backpressure: with it closed the batcher stops, the bounded
/// reader queue fills, the PTY reader thread parks, and the child's write()
/// blocks. Eight chunks (1 MiB) is enough that a
/// frame's budget is never starved waiting on the round trip.
const MAX_IN_FLIGHT: usize = 8;
/// Reader-thread → batcher queue depth, in 64 KiB reads (≤512 KiB buffered).
const READ_QUEUE_CHUNKS: usize = 8;
/// A read at least this large is forwarded as-is rather than copied into the
/// coalescing buffer — coalescing only pays for small reads.
const DIRECT_SEND_BYTES: usize = MAX_CHUNK / 2;

/// Per-session credit window shared between the emit task and `terminal_ack`.
pub struct AckWindow {
    in_flight: AtomicUsize,
    notify: Notify,
}

pub struct TerminalState {
    pub manager: Arc<Mutex<TerminalManager>>,
    acks: parking_lot::Mutex<HashMap<String, Arc<AckWindow>>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(Mutex::new(TerminalManager::new())),
            acks: parking_lot::Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_output: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let (tx, mut rx) = mpsc::channel::<atlas_terminal::TerminalOutput>(READ_QUEUE_CHUNKS);

    let id = {
        let mut manager = state.manager.lock().await;
        manager
            .create_session(cols, rows, cwd.as_deref(), tx)
            .map_err(|e| e.to_string())?
    };

    let window = Arc::new(AckWindow {
        in_flight: AtomicUsize::new(0),
        notify: Notify::new(),
    });
    state.acks.lock().insert(id.clone(), window.clone());

    // Forward PTY output over the per-session channel as RAW BYTES. The old
    // path emitted a global `terminal-output` event whose `Vec<u8>` serialized
    // as a JSON array of numbers — ~4-6 bytes of JSON per PTY byte, decoded
    // back into a number[] on the JS main thread, for every terminal in every
    // window. The channel is point-to-point and the payload is an ArrayBuffer.
    let app_handle = app.clone();
    let session_id = id.clone();
    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
        loop {
            if buf.is_empty() {
                match rx.recv().await {
                    // A big read moves straight into the buffer (no copy);
                    // small ones are appended and coalesced below.
                    Some(output) if output.data.len() >= DIRECT_SEND_BYTES => buf = output.data,
                    Some(output) => buf.extend_from_slice(&output.data),
                    None => break,
                }
            }
            // Coalesce whatever else already arrived, up to one chunk.
            while buf.len() < MAX_CHUNK {
                match rx.try_recv() {
                    Ok(output) => buf.extend_from_slice(&output.data),
                    Err(_) => break,
                }
            }
            // Credit window: wait for the webview to ack before queueing more.
            // (`Notify` stores a permit, so an ack landing between the load and
            // the await is not lost.)
            while window.in_flight.load(Ordering::Acquire) >= MAX_IN_FLIGHT {
                window.notify.notified().await;
                // `terminal_close` force-opens the window; the send below then
                // fails if the webview side is gone and we exit.
            }
            let chunk = if buf.len() > MAX_CHUNK {
                let rest = buf.split_off(MAX_CHUNK);
                std::mem::replace(&mut buf, rest)
            } else {
                std::mem::take(&mut buf)
            };
            window.in_flight.fetch_add(1, Ordering::AcqRel);
            if on_output.send(InvokeResponseBody::Raw(chunk)).is_err() {
                break;
            }
        }
        app_handle
            .state::<TerminalState>()
            .acks
            .lock()
            .remove(&session_id);
        let _ = app_handle.emit("terminal-exit", serde_json::json!({ "id": session_id }));
    });

    Ok(id)
}

/// Ack consumed output chunks, re-opening the credit window. `count` defaults
/// to one; the frontend passes how many chunks xterm has parsed since its last ack,
/// so this is one IPC per batch rather than one per chunk. Sync + parking_lot.
#[tauri::command]
pub fn terminal_ack(state: State<'_, TerminalState>, id: String, count: Option<usize>) {
    let n = count.unwrap_or(1).max(1);
    let window = state.acks.lock().get(&id).cloned();
    if let Some(w) = window {
        let _ = w
            .in_flight
            .try_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.saturating_sub(n))
            });
        w.notify.notify_one();
    }
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.write(&id, &data).map_err(|e| e.to_string())
}

/// Write text to the PTY. The keystroke path: a JSON string is ~4× smaller on
/// the wire than the `number[]` `terminal_write` takes, and the frontend skips
/// its `Array.from(TextEncoder.encode(...))`. Control bytes still go through
/// `terminal_write`.
#[tauri::command]
pub async fn terminal_write_text(
    state: State<'_, TerminalState>,
    id: String,
    text: String,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager
        .write(&id, text.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, TerminalState>, id: String) -> Result<(), String> {
    {
        let mut manager = state.manager.lock().await;
        manager.close(&id);
    }
    // Force-open the credit window so an emit task parked waiting for acks can
    // run to its exit path (its send fails once the channel is gone).
    if let Some(w) = state.acks.lock().get(&id).cloned() {
        w.in_flight.store(0, Ordering::Release);
        w.notify.notify_one();
    }
    Ok(())
}

/// Resolve a path token clicked in the terminal to an existing absolute path,
/// or `None`. Strips a trailing `:line[:col]` suffix, expands `~`, resolves a
/// relative path against the shell's live cwd, and verifies the file exists
/// (so non-path matches in the link regex silently no-op). Blocking (lsof +
/// stat), so run off the main thread.
#[tauri::command]
pub async fn terminal_resolve_path(
    state: State<'_, TerminalState>,
    id: String,
    raw: String,
) -> Result<Option<String>, String> {
    let pid = {
        let manager = state.manager.lock().await;
        manager.pid(&id)
    };
    tokio::task::spawn_blocking(move || {
        let base = pid.and_then(atlas_terminal::cwd_of_pid);
        resolve_path_with_base(base.as_deref(), &raw)
    })
    .await
    .map_err(|e| e.to_string())
}

fn resolve_path_with_base(base: Option<&str>, raw: &str) -> Option<String> {
    use std::path::PathBuf;

    let mut s = raw.trim().to_string();
    // Trim trailing punctuation that commonly abuts a path in prose/output.
    s = s
        .trim_end_matches(['.', ',', ';', ')', ']', '"', '\''])
        .to_string();
    // Strip up to two trailing `:NN` (line, col) segments.
    for _ in 0..2 {
        if let Some(idx) = s.rfind(':') {
            let tail = &s[idx + 1..];
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                s.truncate(idx);
                continue;
            }
        }
        break;
    }
    if s.is_empty() {
        return None;
    }

    let path: PathBuf = if s == "~" {
        dirs::home_dir()?
    } else if let Some(rest) = s.strip_prefix("~/") {
        dirs::home_dir()?.join(rest)
    } else if s.starts_with('/') {
        PathBuf::from(&s)
    } else {
        // Relative — resolve against the provided base directory.
        let cwd = base?;
        PathBuf::from(cwd).join(s.strip_prefix("./").unwrap_or(&s))
    };

    let canon = dunce::canonicalize(&path).ok()?;
    Some(canon.to_string_lossy().into_owned())
}
