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

/** A placed media file as a base64 data URL: `.atlas/canvas-media/` is outside
 *  the asset protocol's scope, so it can't be loaded by path. */
export function canvasMediaDataUrl(projectPath: string, src: string): Promise<string> {
  return invoke<string>("canvas_media_data_url", { projectPath, src });
}
