//! What the UI reads: a checkpoint's findings, a session's badge, and the
//! "Before you ship" roll-up of a branch.
//!
//! Everything here is derived from stored scan results and the "Not useful"
//! labels; nothing is re-scanned. A finding marked not useful stays listed
//! (dimmed, so the mark can be taken back) but no longer counts toward any
//! level, badge or block.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::finding::{fingerprint, Class, Finding, Level, Source};
use crate::scan::{NotScanned, ScanResult};
use crate::tags::{is_floor, path_tags, Tag};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingView {
    pub fingerprint: String,
    pub level: Level,
    pub blocking: bool,
    pub class: Class,
    pub rule_id: String,
    /// The fixed, plain reason for the class.
    pub reason: String,
    pub path: String,
    pub line: u32,
    pub end_line: u32,
    pub sha: String,
    pub test_code: bool,
    pub not_useful: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSecurity {
    pub checkpoint_id: String,
    pub commit_sha: String,
    /// `done`, `partial` or `failed`.
    pub status: String,
    /// The highest level among findings still counted; `none` when clean.
    pub level: Level,
    pub blocking: bool,
    pub findings: Vec<FindingView>,
    /// Changed paths in a sensitive area. Not findings.
    pub floors: Vec<String>,
    pub not_scanned: Vec<NotScanned>,
    /// Credential files the agent read earlier in the session.
    pub sensitive_reads: Vec<String>,
    pub scanned_at: DateTime<Utc>,
    pub scan_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSecurity {
    pub session_id: String,
    pub level: Level,
    pub blocking: bool,
    /// Findings still counted, across the session's checkpoints.
    pub findings: usize,
    /// Checkpoints with a stored scan.
    pub scanned: usize,
}

fn view_of(f: &Finding, not_useful: &HashSet<String>) -> FindingView {
    let at = f.refs.first();
    FindingView {
        fingerprint: f.fingerprint.clone(),
        level: f.level,
        blocking: f.blocking,
        class: f.class,
        rule_id: f.rule_id.clone(),
        reason: f.reason.clone(),
        path: at.map(|r| r.path.clone()).unwrap_or_default(),
        line: at.map(|r| r.start).unwrap_or(0),
        end_line: at.map(|r| r.end).unwrap_or(0),
        sha: at.map(|r| r.sha.clone()).unwrap_or_default(),
        test_code: f.test_code,
        not_useful: not_useful.contains(&f.fingerprint),
    }
}

/// One checkpoint's scan, as the Checkpoint card shows it.
pub fn checkpoint_view(
    checkpoint_id: &str,
    commit_sha: &str,
    scanned_at: DateTime<Utc>,
    result: &ScanResult,
    not_useful: &HashSet<String>,
) -> CheckpointSecurity {
    let findings: Vec<FindingView> = result
        .findings
        .iter()
        .map(|f| view_of(f, not_useful))
        .collect();
    let counted = findings.iter().filter(|f| !f.not_useful);
    let level = counted
        .clone()
        .map(|f| f.level)
        .max()
        .unwrap_or(Level::None);
    let blocking = counted.clone().any(|f| f.blocking);
    CheckpointSecurity {
        checkpoint_id: checkpoint_id.to_string(),
        commit_sha: commit_sha.to_string(),
        status: result.status.as_str().to_string(),
        level,
        blocking,
        findings,
        floors: result.floors.clone(),
        not_scanned: result.not_scanned.clone(),
        sensitive_reads: result.sensitive_reads.clone(),
        scanned_at,
        scan_ms: result.timings_ms.values().sum(),
    }
}

/// The badge on a session's Timeline row; `None` when nothing was scanned.
pub fn session_summary(session_id: &str, views: &[CheckpointSecurity]) -> Option<SessionSecurity> {
    if views.is_empty() {
        return None;
    }
    Some(SessionSecurity {
        session_id: session_id.to_string(),
        level: views.iter().map(|v| v.level).max().unwrap_or(Level::None),
        blocking: views.iter().any(|v| v.blocking),
        findings: views
            .iter()
            .map(|v| v.findings.iter().filter(|f| !f.not_useful).count())
            .sum(),
        scanned: views.len(),
    })
}

// ── Before you ship ─────────────────────────────────────────────────────────

/// One scanned checkpoint on the branch, oldest first.
pub struct ShipScan {
    pub commit_sha: String,
    pub result: ScanResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipFixed {
    pub path: String,
    pub line: u32,
    pub rule_id: String,
    pub reason: String,
    /// The later checkpoint that changed the file, when one did.
    pub fixed_in: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipArea {
    pub path: String,
    /// What makes it sensitive, in a word: `dependencies`, `CI`, …
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipOverview {
    pub branch: String,
    pub checkpoints: usize,
    pub level: Level,
    pub blocking: bool,
    pub open: Vec<FindingView>,
    pub fixed: Vec<ShipFixed>,
    pub sensitive: Vec<ShipArea>,
    pub not_scanned: Vec<NotScanned>,
}

fn area_kind(path: &str) -> Option<&'static str> {
    path_tags(path)
        .into_iter()
        .find(|t| is_floor(*t))
        .map(|t| match t {
            Tag::Lockfile => "dependencies",
            Tag::CiWorkflow => "CI",
            Tag::Capability => "permissions",
            Tag::CspConfig => "app config",
            Tag::AgentConfig => "agent config",
            Tag::TelemetrySink => "telemetry",
            Tag::AuthCode => "auth",
            _ => "sensitive",
        })
}

/// Whether the file as it is now still has the line a finding was raised on.
/// Fingerprints hash the line (secrets hash the redacted line), so this never
/// needs the original text.
fn still_present(f: &Finding, head: &str) -> bool {
    let path = f.refs.first().map(|r| r.path.as_str()).unwrap_or_default();
    head.lines().any(|line| {
        let text = if f.class == Class::Secret {
            atlas_redact::redact(line).text
        } else {
            line.to_string()
        };
        fingerprint(f.class, &f.rule_id, path, &text) == f.fingerprint
    })
}

/// Roll a branch's scanned checkpoints into one view before it ships.
/// `head_file` reads a path at the branch's head; `None` means it no longer
/// exists there.
pub fn ship_overview(
    branch: &str,
    scans: &[ShipScan],
    head_file: &dyn Fn(&str) -> Option<String>,
    not_useful: &HashSet<String>,
) -> ShipOverview {
    let mut open: Vec<FindingView> = Vec::new();
    let mut fixed: Vec<ShipFixed> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut heads: HashMap<String, Option<String>> = HashMap::new();

    for (i, scan) in scans.iter().enumerate() {
        for f in &scan.result.findings {
            if not_useful.contains(&f.fingerprint) || !seen.insert(f.fingerprint.clone()) {
                continue;
            }
            let path = f.refs.first().map(|r| r.path.clone()).unwrap_or_default();
            // A dependency finding names a package, not a line: it stays open
            // until a rescan says otherwise.
            let present = f.source == Source::Dependency
                || heads
                    .entry(path.clone())
                    .or_insert_with(|| head_file(&path))
                    .as_deref()
                    .is_some_and(|text| still_present(f, text));
            if present {
                open.push(view_of(f, not_useful));
            } else {
                let fixed_in = scans[i + 1..]
                    .iter()
                    .find(|later| later.result.order.contains(&path))
                    .map(|later| later.commit_sha.clone());
                fixed.push(ShipFixed {
                    path,
                    line: f.refs.first().map(|r| r.start).unwrap_or(0),
                    rule_id: f.rule_id.clone(),
                    reason: f.reason.clone(),
                    fixed_in,
                });
            }
        }
    }
    open.sort_by(|a, b| b.level.cmp(&a.level).then(a.path.cmp(&b.path)));

    let mut sensitive: Vec<ShipArea> = Vec::new();
    let mut not_scanned: Vec<NotScanned> = Vec::new();
    for scan in scans {
        for path in &scan.result.floors {
            if sensitive.iter().all(|a| &a.path != path) {
                if let Some(kind) = area_kind(path) {
                    sensitive.push(ShipArea {
                        path: path.clone(),
                        kind: kind.to_string(),
                    });
                }
            }
        }
        for n in &scan.result.not_scanned {
            match not_scanned.iter_mut().find(|m| m.path == n.path) {
                Some(m) => *m = n.clone(),
                None => not_scanned.push(n.clone()),
            }
        }
    }

    ShipOverview {
        branch: branch.to_string(),
        checkpoints: scans.len(),
        level: open.iter().map(|f| f.level).max().unwrap_or(Level::None),
        blocking: open.iter().any(|f| f.blocking),
        open,
        fixed,
        sensitive,
        not_scanned,
    }
}
