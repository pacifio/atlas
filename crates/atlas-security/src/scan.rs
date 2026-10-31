//! One Checkpoint's scan, end to end: diff, risk map, then the local layers.
//!
//! Nothing here touches the network. A scan never fails for a missing layer:
//! a layer that could not run says so in [`LayerStatus`], and a file that was
//! not scanned is listed with its reason. Only an unreadable commit is a
//! failed scan.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::deps::lockfiles::is_supported;
use crate::deps::osv::AdvisoryDb;
use crate::diff::parse_unified;
use crate::finding::{Finding, Level};
use crate::map::{build, Limits, SkipReason};
use crate::provenance::Provenance;
use crate::repo::{Repo, RepoError};
use crate::rules::deps::scan_dependencies;
use crate::rules::secrets::scan_secrets;
use crate::rules::sinks::scan_sinks;
use crate::tags::{is_lockfile, Tag};

/// Bump on any change to a rule, threshold or question.
pub const SCANNER_VERSION: &str = "local-1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "reason")]
pub enum LayerState {
    Ran,
    NotRun(String),
    Partial(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerStatus {
    pub map: LayerState,
    pub secrets: LayerState,
    pub sinks: LayerState,
    pub deps: LayerState,
    pub clef: LayerState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status", content = "reason")]
pub enum ScanStatus {
    Done,
    Partial,
    Failed(String),
}

impl ScanStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScanStatus::Done => "done",
            ScanStatus::Partial => "partial",
            ScanStatus::Failed(_) => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotScanned {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanResult {
    pub scanner_version: String,
    pub status: ScanStatus,
    pub level: Level,
    pub blocking: bool,
    pub findings: Vec<Finding>,
    /// Every changed path, in risk order.
    pub order: Vec<String>,
    /// Changed paths in a sensitive area. Not findings.
    pub floors: Vec<String>,
    pub not_scanned: Vec<NotScanned>,
    pub layers: LayerStatus,
    pub timings_ms: BTreeMap<String, u64>,
}

pub struct ScanInput<'a> {
    pub sha: &'a str,
    pub repo: &'a dyn Repo,
    pub provenance: &'a Provenance,
    /// `None` when no advisory data is available; the dependency layer then
    /// reports itself not run.
    pub advisories: Option<&'a AdvisoryDb>,
    pub limits: Limits,
    pub deadline: Instant,
}

fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn not_enabled() -> LayerState {
    LayerState::NotRun("not enabled".to_string())
}

fn failed(reason: String) -> ScanResult {
    ScanResult {
        scanner_version: SCANNER_VERSION.to_string(),
        status: ScanStatus::Failed(reason),
        level: Level::None,
        blocking: false,
        findings: Vec::new(),
        order: Vec::new(),
        floors: Vec::new(),
        not_scanned: Vec::new(),
        layers: LayerStatus {
            map: LayerState::NotRun("commit unreadable".to_string()),
            secrets: LayerState::NotRun("commit unreadable".to_string()),
            sinks: LayerState::NotRun("commit unreadable".to_string()),
            deps: LayerState::NotRun("commit unreadable".to_string()),
            clef: not_enabled(),
        },
        timings_ms: BTreeMap::new(),
    }
}

pub fn scan_checkpoint(input: ScanInput<'_>) -> ScanResult {
    let mut timings = BTreeMap::new();
    let t = Instant::now();
    let diff = match input.repo.commit_diff(input.sha) {
        Ok(d) => d,
        Err(RepoError::MissingCommit(_)) => return failed("commit not found".to_string()),
        Err(RepoError::Git(e)) => return failed(format!("git: {e}")),
    };
    let mut map = build(parse_unified(&diff), &input.limits);
    timings.insert("map".to_string(), ms(t));

    // Lockfiles this version cannot read are listed, not silently passed.
    for file in &mut map.files {
        if file.skip.is_none() && is_lockfile(&file.change.path) && !is_supported(&file.change.path)
        {
            file.skip = Some(SkipReason::UnsupportedLockfile);
        }
    }

    let mut findings: Vec<Finding> = Vec::new();
    let mut out_of_time = false;
    let mut deps_needed = false;
    let mut deps_missing: Vec<String> = Vec::new();
    let mut deps_errors: Vec<String> = Vec::new();
    let (mut t_secrets, mut t_sinks, mut t_deps) = (0u64, 0u64, 0u64);

    for file in &mut map.files {
        if file.skip.is_some() {
            continue;
        }
        if Instant::now() >= input.deadline {
            file.skip = Some(SkipReason::TimeBudget);
            out_of_time = true;
            continue;
        }
        let t = Instant::now();
        findings.extend(scan_secrets(input.sha, file, input.provenance));
        t_secrets += ms(t);
        let t = Instant::now();
        findings.extend(scan_sinks(input.sha, file));
        t_sinks += ms(t);
        if file.tags.contains(&Tag::Lockfile) {
            deps_needed = true;
            if let Some(db) = input.advisories {
                let t = Instant::now();
                match scan_dependencies(input.sha, file, input.repo, db) {
                    Ok(scan) => {
                        findings.extend(scan.findings);
                        for eco in scan.missing_data {
                            let name = eco.osv_name().to_string();
                            if !deps_missing.contains(&name) {
                                deps_missing.push(name);
                            }
                        }
                    }
                    Err(e) => deps_errors.push(e),
                }
                t_deps += ms(t);
            }
        }
    }
    timings.insert("secrets".to_string(), t_secrets);
    timings.insert("sinks".to_string(), t_sinks);
    timings.insert("deps".to_string(), t_deps);

    let findings = dedupe(findings);
    let level = findings
        .iter()
        .map(|f| f.level)
        .max()
        .unwrap_or(Level::None);
    let blocking = findings.iter().any(|f| f.blocking);
    let budget = |ran: LayerState| {
        if out_of_time {
            LayerState::Partial("time budget".to_string())
        } else {
            ran
        }
    };
    let deps = if deps_needed && input.advisories.is_none() {
        LayerState::NotRun("advisory data not available".to_string())
    } else if !deps_errors.is_empty() {
        LayerState::Partial(deps_errors.join("; "))
    } else if !deps_missing.is_empty() {
        LayerState::Partial(format!("no advisory data for {}", deps_missing.join(", ")))
    } else {
        budget(LayerState::Ran)
    };

    ScanResult {
        scanner_version: SCANNER_VERSION.to_string(),
        status: if out_of_time {
            ScanStatus::Partial
        } else {
            ScanStatus::Done
        },
        level,
        blocking,
        findings,
        order: map.files.iter().map(|f| f.change.path.clone()).collect(),
        floors: map
            .files
            .iter()
            .filter(|f| f.floor)
            .map(|f| f.change.path.clone())
            .collect(),
        not_scanned: map
            .files
            .iter()
            .filter_map(|f| {
                f.skip.map(|reason| NotScanned {
                    path: f.change.path.clone(),
                    reason,
                })
            })
            .collect(),
        layers: LayerStatus {
            map: LayerState::Ran,
            secrets: budget(LayerState::Ran),
            sinks: budget(LayerState::Ran),
            deps,
            clef: not_enabled(),
        },
        timings_ms: timings,
    }
}

/// One finding per fingerprint: the highest level wins, blocking if any copy
/// blocks, and every place it was seen is kept as a reference.
fn dedupe(findings: Vec<Finding>) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for f in findings {
        match at.get(&f.fingerprint) {
            Some(&i) => {
                let kept = &mut out[i];
                kept.level = kept.level.max(f.level);
                kept.blocking |= f.blocking;
                for r in f.refs {
                    if !kept.refs.contains(&r) {
                        kept.refs.push(r);
                    }
                }
            }
            None => {
                at.insert(f.fingerprint.clone(), out.len());
                out.push(f);
            }
        }
    }
    out
}
