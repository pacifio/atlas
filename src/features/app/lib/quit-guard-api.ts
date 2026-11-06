import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Rust holds a user quit and asks here (`commands/quit_guard.rs`). */
export const QUIT_REQUESTED_EVENT = "atlas:quit-requested";

export function onQuitRequested(handler: () => void): Promise<UnlistenFn> {
  return listen(QUIT_REQUESTED_EVENT, () => handler());
}

/** The listener is installed; until this, Rust never holds a quit. */
export function quitGuardReady(): Promise<void> {
  return invoke("quit_guard_ready");
}

export function quitGuardAnswer(quit: boolean): Promise<void> {
  return invoke("quit_guard_answer", { quit });
}
