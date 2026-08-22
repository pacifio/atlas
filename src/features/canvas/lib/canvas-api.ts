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
