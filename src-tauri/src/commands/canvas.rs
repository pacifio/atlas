use std::fs;
use std::path::Path;

const DEFAULT_EMPTY: &str = r#"{"version":2,"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}"#;

#[tauri::command]
pub async fn load_canvas(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = Path::new(&project_path).join(".atlas").join("canvas.json");
        if !path.exists() {
            return Ok(DEFAULT_EMPTY.to_string());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_canvas(project_path: String, payload: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dir = Path::new(&project_path).join(".atlas");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let final_path = dir.join("canvas.json");
        let tmp_path = dir.join("canvas.json.tmp");
        fs::write(&tmp_path, &payload).map_err(|e| e.to_string())?;
        // Atomic rename — avoids partial writes on crash.
        fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a user-picked image/video into `.atlas/canvas-media/` and return its
/// relative filename (stored on the media node). Mirrors `knowledge_cover_upload`.
#[tauri::command]
pub async fn canvas_media_upload(project_path: String, src_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let src = Path::new(&src_path);
        if !src.exists() {
            return Err("source file not found".to_string());
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_lowercase();
        // Unique flat name so two files with the same basename don't collide.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let rel = format!("media_{nanos}.{ext}");
        let dir = Path::new(&project_path).join(".atlas").join("canvas-media");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::copy(src, dir.join(&rel)).map_err(|e| e.to_string())?;
        Ok(rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a canvas media file and return it as a `data:` URL (base64). Media lives
/// under `.atlas/`, which the asset protocol 403s, so we embed the bytes directly
/// (mirrors `knowledge_cover_data_url`). Handles images and video.
#[tauri::command]
pub async fn canvas_media_data_url(project_path: String, src: String) -> Result<String, String> {
    use base64::Engine;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let abs = Path::new(&project_path)
            .join(".atlas")
            .join("canvas-media")
            .join(&src);
        let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
        let mime = match abs
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .as_deref()
        {
            Some("png") => "image/png",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("svg") => "image/svg+xml",
            Some("avif") => "image/avif",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("mp4") => "video/mp4",
            Some("webm") => "video/webm",
            Some("mov") => "video/quicktime",
            Some("m4v") => "video/x-m4v",
            _ => "application/octet-stream",
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{};base64,{}", mime, b64))
    })
    .await
    .map_err(|e| e.to_string())?
}
