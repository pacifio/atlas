//! `Skill` — the native Atlas agent's skill loader.
//!
//! Atlas installs skills into `<root>/.atlas/skills/<name>/SKILL.md` and, when a
//! skill is toggled ON for the Atlas agent, symlinks it into a dedicated dir
//! `.atlas/agent-skills/<name>` (handled Rust-side by the skills `"atlas"` tool
//! registry). This tool reads ONLY from that dir — so the Settings → Skills
//! "Atlas" toggle is the exclusive gate for what the native agent sees (no
//! `~/.claude` / bundled-skill leakage from cersei's built-in discovery).
//!
//! The tool is deliberately named `"Skill"` so `build_system_prompt` adds the
//! skills guidance, and uses the same `{skill, args}` schema as cersei's
//! `SkillTool`: `{skill:"list"}` lists, `{skill:"<name>", args}` expands a body.

use std::path::PathBuf;

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{coerce, errors};

const AGENT_SKILLS_REL: &str = ".atlas/agent-skills";

const DESCRIPTION: &str = "Invoke a Skill — a reusable prompt/instruction template enabled for \
the Atlas agent. Call with {\"skill\":\"list\"} to see available skills, then \
{\"skill\":\"<name>\",\"args\":\"...\"} to load one. The returned text is guidance for you to \
follow; `$ARGUMENTS` in the skill is replaced with `args`. Only use skills listed as available.";

#[derive(Deserialize)]
struct Input {
    skill: String,
    #[serde(default)]
    args: Option<String>,
}

/// One discovered skill: directory name + its `SKILL.md` path + frontmatter description.
struct Found {
    name: String,
    path: PathBuf,
    description: String,
}

pub struct AtlasSkillTool;

#[async_trait]
impl Tool for AtlasSkillTool {
    fn name(&self) -> &str {
        "Skill"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Orchestration
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "skill": { "type": "string", "description": "Skill name, or \"list\" to list available skills" },
                "args":  { "type": "string", "description": "Arguments substituted for $ARGUMENTS in the skill" }
            },
            "required": ["skill"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "Skill",
                    &e.to_string(),
                    r#"{"skill": "list"}"#,
                ))
            }
        };

        let dirs = skill_dirs(&ctx.working_dir);
        let found = discover(&dirs);

        let key = input.skill.trim();
        if key.is_empty() || key.eq_ignore_ascii_case("list") {
            if found.is_empty() {
                return ToolResult::success(
                    "No skills are enabled for the Atlas agent. Enable skills in \
                     Settings → Skills (toggle the \"Atlas\" target on a skill)."
                        .to_string(),
                );
            }
            let mut body = format!("Available skills ({}):\n", found.len());
            for f in &found {
                if f.description.is_empty() {
                    body.push_str(&format!("- {}\n", f.name));
                } else {
                    body.push_str(&format!("- {} — {}\n", f.name, f.description));
                }
            }
            body.push_str("\nInvoke one with {\"skill\":\"<name>\",\"args\":\"...\"}.");
            return ToolResult::success(body);
        }

        match found.iter().find(|f| f.name.eq_ignore_ascii_case(key)) {
            Some(f) => {
                let raw = match std::fs::read_to_string(&f.path) {
                    Ok(s) => s,
                    Err(e) => {
                        return ToolResult::error(format!(
                            "Failed to read skill '{}': {e}",
                            f.name
                        ))
                    }
                };
                let (_desc, body) = parse_skill_md(&raw);
                let expanded = expand_arguments(&body, input.args.as_deref().unwrap_or(""));
                ToolResult::success(expanded)
            }
            None => ToolResult::error(format!(
                "Skill '{key}' is not enabled for Atlas. Use {{\"skill\":\"list\"}} to see \
                 available skills."
            )),
        }
    }
}

/// The two dirs to scan: project (`<cwd>/.atlas/agent-skills`) then global
/// (`~/.atlas/agent-skills`). Project entries win on a name collision.
fn skill_dirs(working_dir: &std::path::Path) -> Vec<PathBuf> {
    let mut dirs = vec![working_dir.join(AGENT_SKILLS_REL)];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(AGENT_SKILLS_REL));
    }
    dirs
}

/// Each immediate subdir owning a `SKILL.md` is one skill. First occurrence wins
/// (so project shadows global), matching the toggle semantics.
fn discover(dirs: &[PathBuf]) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for entry in rd.flatten() {
            let p = entry.path();
            let md = p.join("SKILL.md");
            if !md.is_file() {
                continue;
            }
            let Some(name) = p.file_name().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            if out.iter().any(|f| f.name == name) {
                continue; // already found at higher priority
            }
            let description = std::fs::read_to_string(&md)
                .map(|raw| parse_skill_md(&raw).0)
                .unwrap_or_default();
            out.push(Found { name, path: md, description });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Split a `SKILL.md`: returns `(description, body)` with the YAML frontmatter
/// block stripped. Minimal hand-rolled parse (only `description:` is read).
fn parse_skill_md(raw: &str) -> (String, String) {
    let trimmed = raw.trim_start_matches(['\u{feff}', '\n', '\r', ' ']);
    if let Some(rest) = trimmed.strip_prefix("---") {
        // Find the closing `---` fence on its own line.
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            let body = rest[end + 4..].trim_start_matches(['\n', '\r']);
            let mut desc = String::new();
            for line in front.lines() {
                if let Some(v) = line.trim().strip_prefix("description:") {
                    desc = v.trim().trim_matches(['"', '\'']).to_string();
                }
            }
            return (desc, body.to_string());
        }
    }
    (String::new(), raw.to_string())
}

/// Replace `$ARGUMENTS` with the caller-provided args (empty string when none).
fn expand_arguments(body: &str, args: &str) -> String {
    body.replace("$ARGUMENTS", args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    fn plant(root: &std::path::Path, name: &str, front: &str, body: &str) {
        let dir = root.join(AGENT_SKILLS_REL).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), format!("---\n{front}\n---\n\n{body}\n")).unwrap();
    }

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        AtlasSkillTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn lists_and_loads_enabled_skills() {
        let tmp = TmpDir::new();
        plant(tmp.path(), "review", "name: review\ndescription: Review a diff", "Do a review of $ARGUMENTS.");

        let r = run(tmp.path(), serde_json::json!({"skill": "list"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("review"));
        assert!(r.content.contains("Review a diff"));

        let r = run(tmp.path(), serde_json::json!({"skill": "review", "args": "the auth change"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("Do a review of the auth change."));
        assert!(!r.content.contains("---"), "frontmatter not stripped: {}", r.content);
    }

    #[tokio::test]
    async fn empty_when_none_enabled() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"skill": "list"})).await;
        assert!(!r.is_error);
        assert!(r.content.contains("No skills"));
    }

    #[tokio::test]
    async fn unknown_skill_errors() {
        let tmp = TmpDir::new();
        plant(tmp.path(), "a", "name: a", "body");
        let r = run(tmp.path(), serde_json::json!({"skill": "nope"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("not enabled"));
    }
}
