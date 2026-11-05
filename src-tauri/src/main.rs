#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Replace the system allocator with mimalloc — affects every `String::new`,
// `Vec::push`, Tauri internal alloc, etc. across the process. The biggest
// startup wins come from the allocation-heavy phase of WebView init, plugin
// registration, and the IPC bridge setup.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    // The engine re-execs this binary as its sandboxed fs helper and, on
    // Windows, its sandbox launcher; those processes must never reach the GUI.
    atlas_native_agent::run_engine_helper_if_asked();
    // `atlas mcp-bridge <url> <token file>` is the stdio bridge every ACP
    // agent reaches Atlas's tool servers through (ADR-0019, ADR-0020), not
    // the app.
    if atlas_lib::run_bridge_if_asked() {
        return;
    }
    atlas_lib::run()
}
