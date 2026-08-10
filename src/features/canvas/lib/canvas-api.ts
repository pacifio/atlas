import { invoke } from "@tauri-apps/api/core";

export function loadCanvas(projectPath: string): Promise<string> {
  return invoke<string>("load_canvas", { projectPath });
}

export function saveCanvas(projectPath: string, payload: string): Promise<void> {
  return invoke<void>("save_canvas", { projectPath, payload });
}

/** Copy a picked image/video into `.atlas/canvas-media/`; returns its rel name. */
export function canvasMediaUpload(projectPath: string, srcPath: string): Promise<string> {
  return invoke<string>("canvas_media_upload", { projectPath, srcPath });
}

/** Compact codebase-structure summary (top files by dependency rank) for the AI
 *  copilot's architecture prompts. Empty string if the codebase index isn't built. */
export function canvasCodebaseContext(projectPath: string, maxFiles?: number): Promise<string> {
  return invoke<string>("canvas_codebase_context", { projectPath, maxFiles });
}

/** RAG-augmented context prompt over project memory + codebase (BYOK-safe: does no
 *  local generation). Reused from Memory ▸ Chat. */
export function memoryChatRetrieve(
  projectPath: string,
  query: string,
): Promise<{ prompt: string; sources: unknown[] }> {
  return invoke("memory_chat_retrieve", { projectPath, query });
}
