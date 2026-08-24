//! Per-project persistence of editable PDF annotations (highlights, freehand,
//! notes). Stored as `<project>/.atlas/pdf-annotations.json` — a map keyed by
//! the PDF's absolute path → its annotations.
//!
//! Annotations are kept as editable data (NOT flattened into the PDF) so they
//! stay erasable/movable across sessions. Geometry is normalized (0..1) on the
//! frontend; this layer just persists the opaque JSON. Same atomic tmp+rename
//! pattern as `plans.rs`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Opaque per-annotation JSON — the frontend owns the schema (discriminated by
/// `kind`: highlight | pencil | note).
pub type Annotation = serde_json::Value;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PdfAnnotationsFile {
    #[serde(default, rename = "byPath")]
    pub by_path: HashMap<String, Vec<Annotation>>,
}

fn annotations_path(project_path: &str) -> std::path::PathBuf {
    Path::new(project_path)
        .join(".atlas")
        .join("pdf-annotations.json")
}

fn read_all(project_path: &str) -> PdfAnnotationsFile {
    match fs::read_to_string(annotations_path(project_path)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => PdfAnnotationsFile::default(),
    }
}

fn write_all(project_path: &str, file: &PdfAnnotationsFile) -> Result<(), String> {
    let dir = Path::new(project_path).join(".atlas");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_path = dir.join("pdf-annotations.json");
    let tmp_path = dir.join("pdf-annotations.json.tmp");
    let payload = serde_json::to_string(file).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, &payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// All annotations for one PDF (empty if none saved yet).
#[tauri::command]
pub async fn pdf_annotations_load(
    project_path: String,
    pdf_path: String,
) -> Result<Vec<Annotation>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(read_all(&project_path)
            .by_path
            .remove(&pdf_path)
            .unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the annotation set for one PDF. An empty vec drops the entry so the
/// file doesn't accumulate keys for PDFs whose annotations were all erased.
#[tauri::command]
pub async fn pdf_annotations_save(
    project_path: String,
    pdf_path: String,
    annotations: Vec<Annotation>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut file = read_all(&project_path);
        if annotations.is_empty() {
            file.by_path.remove(&pdf_path);
        } else {
            file.by_path.insert(pdf_path, annotations);
        }
        write_all(&project_path, &file)
    })
    .await
    .map_err(|e| e.to_string())?
}
