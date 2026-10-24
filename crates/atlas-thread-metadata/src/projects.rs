//! The projects attached to a session.
//!
//! A session runs in one project (its working directory, the row's folder
//! paths). An **attached project** is another folder the session may use
//! besides that one: a sibling project picked with `@workspace:`, a cloned
//! repository, or a folder the agent asked for and the user approved. Unlike a
//! mention, an attachment is a property of the session, not of one message: it
//! is remembered across turns and across a resume, and it widens what the
//! agent's sandbox lets it touch, at the access level the user chose.
//!
//! Stored as one JSON column on the row (`attached_projects`), so it rides
//! the same in-memory row, the same queued upsert and the same reopen as every
//! other field. The list is small (a handful of folders), and nothing queries
//! inside it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// What the agent may do in an attached project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProjectAccess {
    /// Readable, never writable. The default: attaching is not consent to
    /// edit.
    #[default]
    ReadOnly,
    /// Readable and writable: added to the sandbox's writable roots.
    ReadWrite,
}

impl ProjectAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::ReadWrite => "read_write",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "read_only" => Some(Self::ReadOnly),
            "read_write" => Some(Self::ReadWrite),
            _ => None,
        }
    }

    pub fn is_writable(self) -> bool {
        matches!(self, Self::ReadWrite)
    }
}

/// How a project came to be attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachSource {
    /// The user picked it in the composer (`@workspace:` or `@repo:`).
    Mention,
    /// The agent asked for it and the user approved.
    AgentRequest,
    /// The user cloned it from GitHub into the session.
    Clone,
}

impl AttachSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mention => "mention",
            Self::AgentRequest => "agent_request",
            Self::Clone => "clone",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "mention" => Some(Self::Mention),
            "agent_request" => Some(Self::AgentRequest),
            "clone" => Some(Self::Clone),
            _ => None,
        }
    }
}

/// One project attached to a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachedProject {
    /// The folder, absolute. Its identity within the session: one entry per
    /// path.
    pub path: PathBuf,
    /// What the UI calls it: the project's name, or the folder's.
    pub display_name: Arc<str>,
    pub access: ProjectAccess,
    pub attached_at: DateTime<Utc>,
    pub source: AttachSource,
}

impl AttachedProject {
    pub fn new(
        path: impl Into<PathBuf>,
        display_name: impl Into<Arc<str>>,
        access: ProjectAccess,
        source: AttachSource,
    ) -> Self {
        Self {
            path: path.into(),
            display_name: display_name.into(),
            access,
            attached_at: Utc::now(),
            source,
        }
    }
}

/// The column's text for a list: `None` (SQL `NULL`) when it is empty, so a
/// row with nothing attached reads exactly like one written before the column
/// existed.
pub(crate) fn encode(projects: &[AttachedProject]) -> Option<String> {
    if projects.is_empty() {
        return None;
    }
    serde_json::to_string(projects).ok()
}

/// The list a column holds. Unreadable text decodes to nothing rather than
/// failing the row: losing an attachment costs a re-attach, losing the row
/// costs the session's place in the sidebar.
pub(crate) fn decode(text: Option<String>) -> Vec<AttachedProject> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<AttachedProject>>(&text) {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!(error = %e, "unreadable attached_projects column; treating it as empty");
            Vec::new()
        }
    }
}

/// The entry for `path` in `projects`, if there is one.
pub(crate) fn position(projects: &[AttachedProject], path: &Path) -> Option<usize> {
    projects.iter().position(|p| p.path == path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_list_is_stored_as_null_and_null_reads_as_empty() {
        assert_eq!(encode(&[]), None);
        assert!(decode(None).is_empty());
        assert!(decode(Some(String::new())).is_empty());
    }

    #[test]
    fn a_list_round_trips_through_its_column() {
        let list = vec![
            AttachedProject::new(
                "/work/server",
                "server",
                ProjectAccess::ReadWrite,
                AttachSource::AgentRequest,
            ),
            AttachedProject::new(
                "/work/docs",
                "docs",
                ProjectAccess::ReadOnly,
                AttachSource::Mention,
            ),
        ];
        assert_eq!(decode(encode(&list)), list);
    }

    #[test]
    fn unreadable_text_decodes_to_nothing_rather_than_failing_the_row() {
        assert!(decode(Some("{not json".into())).is_empty());
    }

    #[test]
    fn the_wire_names_are_snake_case() {
        assert_eq!(
            serde_json::to_string(&ProjectAccess::ReadOnly).unwrap(),
            "\"read_only\""
        );
        assert_eq!(
            serde_json::to_string(&AttachSource::AgentRequest).unwrap(),
            "\"agent_request\""
        );
        assert_eq!(
            ProjectAccess::parse("read_write"),
            Some(ProjectAccess::ReadWrite)
        );
        assert_eq!(AttachSource::parse("clone"), Some(AttachSource::Clone));
        assert_eq!(ProjectAccess::parse("write"), None);
    }
}
