//! Session-memory extraction: categories, output parsing, memdir persistence.
//!
//! Ported into Atlas from `cersei_agent::session_memory`. The SDK's
//! `should_extract` / `count_tool_calls_since` are **not** here — they operate on
//! `cersei_types::Message`, and `crate::extract` already reimplements the same
//! gates over its own format-neutral `TranscriptTurn`.
//!
//! Two things in this module are on-disk contracts rather than implementation
//! details, and both are pinned in `tests/cersei_parity.rs`:
//!
//! - [`MemoryCategory::label`] is written into the memdir markdown *and* used as
//!   the graph topic string.
//! - [`persist_memories`]'s rendered line is parsed back by
//!   `crate::consolidate::prune_memdir`, so its exact shape couples the two.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Category of an extracted fact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MemoryCategory {
    UserPreference,
    ProjectFact,
    CodePattern,
    Decision,
    Constraint,
}

impl MemoryCategory {
    /// Wire/disk label. Written into the memdir and used as the graph topic.
    pub fn label(&self) -> &'static str {
        match self {
            Self::UserPreference => "preference",
            Self::ProjectFact => "project",
            Self::CodePattern => "pattern",
            Self::Decision => "decision",
            Self::Constraint => "constraint",
        }
    }

    /// Parse a label. Accepts the aliases a model plausibly emits.
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "preference" | "userpreference" | "user_preference" => Some(Self::UserPreference),
            "project" | "projectfact" | "project_fact" => Some(Self::ProjectFact),
            "pattern" | "codepattern" | "code_pattern" => Some(Self::CodePattern),
            "decision" => Some(Self::Decision),
            "constraint" => Some(Self::Constraint),
            _ => None,
        }
    }
}

/// A single extracted fact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedMemory {
    pub content: String,
    pub category: MemoryCategory,
    pub confidence: f32,
}

/// Tracks extraction progress so the same turns are not mined twice.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionMemoryState {
    pub last_extracted_message_index: usize,
    pub tool_calls_since_last: usize,
    pub extraction_count: u32,
}

/// System prompt for the extraction turn.
///
/// It must keep asking for the exact line shape [`parse_extraction_output`]
/// understands — that parser recognises nothing else.
pub fn extraction_prompt() -> &'static str {
    "You are a memory extraction system. Read the conversation and extract \
    key facts worth remembering for future sessions.\n\n\
    For each fact, output one line in this exact format:\n\
    MEMORY: <category> | <confidence 0-10> | <fact>\n\n\
    Categories: preference, project, pattern, decision, constraint\n\n\
    Only extract facts that would be genuinely useful in future sessions. \
    Don't extract trivial or ephemeral information. Be specific and actionable."
}

/// Parse the model's reply into structured memories.
///
/// Every line is independent: anything that is not a well-formed `MEMORY:` line
/// is skipped silently, so surrounding prose costs nothing. Only the first two
/// `|` are delimiters, which lets a fact contain pipes. A confidence that parses
/// to a negative number is rejected outright; one above ten clamps to 1.0.
pub fn parse_extraction_output(output: &str) -> Vec<ExtractedMemory> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with("MEMORY:") {
                return None;
            }
            let rest = line.strip_prefix("MEMORY:")?.trim();
            let parts: Vec<&str> = rest.splitn(3, '|').collect();
            if parts.len() != 3 {
                return None;
            }

            let category = MemoryCategory::from_str(parts[0].trim())?;
            let confidence = parts[1].trim().parse::<f32>().ok()? / 10.0;
            let content = parts[2].trim().to_string();

            if content.is_empty() || confidence < 0.0 {
                return None;
            }

            Some(ExtractedMemory {
                content,
                category,
                confidence: confidence.clamp(0.0, 1.0),
            })
        })
        .collect()
}

/// Append `memories` to `target_path` under `## Auto-extracted memories`, in a
/// `### Session memories — <UTC date>` block.
///
/// Three cases, in the order they are tested: the section and today's date block
/// both exist (append inside it), the section exists but today's block does not
/// (insert a new block right after the section header), or there is no section
/// at all (create one, preserving any hand-written content above it).
///
/// An empty slice writes nothing — not even an empty file.
pub fn persist_memories(memories: &[ExtractedMemory], target_path: &Path) -> std::io::Result<()> {
    if memories.is_empty() {
        return Ok(());
    }

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let existing = std::fs::read_to_string(target_path).unwrap_or_default();

    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let section_header = "## Auto-extracted memories";
    let date_header = format!("### Session memories — {date}");

    let mut new_entries = String::new();
    for mem in memories {
        new_entries.push_str(&format!(
            "- **[{}]** {} *(confidence: {:.0}%)*\n",
            mem.category.label(),
            mem.content,
            mem.confidence * 100.0,
        ));
    }

    let output = if existing.contains(section_header) {
        if existing.contains(&date_header) {
            existing.replace(&date_header, &format!("{date_header}\n{new_entries}"))
        } else {
            let insert_pos = existing.find(section_header).unwrap() + section_header.len();
            let (before, after) = existing.split_at(insert_pos);
            format!("{before}\n\n{date_header}\n{new_entries}\n{after}")
        }
    } else if existing.is_empty() {
        format!("{section_header}\n\n{date_header}\n{new_entries}")
    } else {
        format!(
            "{}\n\n{section_header}\n\n{date_header}\n{new_entries}",
            existing.trim()
        )
    };

    std::fs::write(target_path, output)
}
