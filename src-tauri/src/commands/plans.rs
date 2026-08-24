//! Persistent per-project store of Claude Code plans.
//!
//! Every time the agent proposes a plan (the ExitPlanMode permission, which
//! carries `{ plan: "<markdown>" }`), the frontend captures it here together
//! with the user message that triggered it and a timestamp. The Plans panel
//! reads them back so the user can browse every plan ever made for the
//! project, across sessions.
//!
//! Stored as `<project>/.atlas/plans.json` — same simple atomic-write pattern
//! as `canvas.rs`.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRecord {
    /// Stable id (frontend-generated). Used for dedup + React keys.
    pub id: String,
    /// ACP session id the plan belongs to (also the JSONL transcript stem).
    #[serde(default)]
    pub session_id: Option<String>,
    /// Chat session title at capture time, for display.
    #[serde(default)]
    pub session_title: Option<String>,
    /// The user message that triggered the plan.
    pub user_message: String,
    /// The plan itself, as markdown.
    pub plan: String,
    /// ISO 8601 capture time (frontend clock — Rust avoids wall-clock here).
    pub timestamp: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PlansFile {
    #[serde(default)]
    pub plans: Vec<PlanRecord>,
}

fn plans_path(project_path: &str) -> std::path::PathBuf {
    Path::new(project_path).join(".atlas").join("plans.json")
}

fn read_plans(project_path: &str) -> PlansFile {
    let path = plans_path(project_path);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<PlansFile>(&raw).unwrap_or_default(),
        Err(_) => PlansFile::default(),
    }
}

fn write_plans(project_path: &str, file: &PlansFile) -> Result<(), String> {
    let dir = Path::new(project_path).join(".atlas");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_path = dir.join("plans.json");
    let tmp_path = dir.join("plans.json.tmp");
    let payload = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, &payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Return every saved plan for the project, newest first.
#[tauri::command]
pub async fn plans_load(project_path: String) -> Result<Vec<PlanRecord>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<PlanRecord>, String> {
        let mut plans = read_plans(&project_path).plans;
        // Newest first — the panel shows most-recent plans at the top.
        plans.reverse();
        Ok(plans)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append a plan, returning the full list (newest first). Idempotent: a plan
/// with the same `(session_id, plan)` content is not stored twice, so a
/// re-delivered permission can't create duplicates.
#[tauri::command]
pub async fn plans_append(
    project_path: String,
    record: PlanRecord,
) -> Result<Vec<PlanRecord>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<PlanRecord>, String> {
        let mut file = read_plans(&project_path);
        let dup = file
            .plans
            .iter()
            .any(|p| p.session_id == record.session_id && p.plan == record.plan);
        if !dup {
            file.plans.push(record);
            write_plans(&project_path, &file)?;
        }
        let mut plans = file.plans;
        plans.reverse();
        Ok(plans)
    })
    .await
    .map_err(|e| e.to_string())?
}
