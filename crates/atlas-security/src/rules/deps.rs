//! Dependency findings: what a lockfile change added, checked against the
//! local advisory index. Version comparison is code, never a model.

use crate::deps::lockfiles::{dep_changes, parse_lockfile, DepChange, Ecosystem};
use crate::deps::osv::{AdvSeverity, Advisory, AdvisoryDb};
use crate::diff::{FileStatus, LineKind};
use crate::finding::{on_line, Class, Finding, Hit, Level, Source};
use crate::map::MappedFile;
use crate::repo::Repo;

/// Findings for one lockfile, and the ecosystems it needed advisory data for
/// but the database does not have.
pub struct DepScan {
    pub findings: Vec<Finding>,
    pub missing_data: Vec<Ecosystem>,
}

pub fn scan_dependencies(
    sha: &str,
    file: &MappedFile,
    repo: &dyn Repo,
    db: &AdvisoryDb,
) -> Result<DepScan, String> {
    let path = file.change.path.as_str();
    let before_path = match &file.change.status {
        FileStatus::Renamed { from } => from.as_str(),
        _ => path,
    };
    let parent = repo.parent(sha).map_err(|e| e.to_string())?;
    let before = match &parent {
        Some(p) if file.change.status != FileStatus::Added => repo
            .file_at(p, before_path)
            .map_err(|e| e.to_string())?
            .and_then(|b| parse_lockfile(before_path, &b))
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let after_bytes = repo
        .file_at(sha, path)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{path} not found at the commit"))?;
    let after =
        parse_lockfile(path, &after_bytes).ok_or_else(|| format!("{path} did not parse"))?;

    let mut out = DepScan {
        findings: Vec::new(),
        missing_data: Vec::new(),
    };
    for change in dep_changes(&before, &after) {
        if !db.has(change.pkg.eco) {
            if !out.missing_data.contains(&change.pkg.eco) {
                out.missing_data.push(change.pkg.eco);
            }
            continue;
        }
        for advisory in db.lookup(&change.pkg) {
            out.findings.push(finding(sha, file, &change, &advisory));
        }
    }
    Ok(out)
}

fn finding(sha: &str, file: &MappedFile, change: &DepChange, adv: &Advisory) -> Finding {
    let (class, level, blocking) = if adv.malicious {
        (Class::MaliciousDependency, Level::Critical, true)
    } else {
        match adv.severity {
            AdvSeverity::Critical => (Class::VulnerableDependency, Level::Critical, true),
            AdvSeverity::High => (Class::VulnerableDependency, Level::High, true),
            AdvSeverity::Medium => (Class::VulnerableDependency, Level::Medium, false),
            AdvSeverity::Low => (Class::VulnerableDependency, Level::Low, false),
            // No severity published: worth a look, never a block.
            AdvSeverity::Unknown => (Class::VulnerableDependency, Level::High, false),
        }
    };
    let rule_id = format!("dep.{}", adv.id);
    let pkg = &change.pkg;
    let key = format!("{}:{}@{}", pkg.eco.osv_name(), pkg.name, pkg.version);
    on_line(
        Hit {
            class,
            level,
            blocking,
            source: Source::Dependency,
            rule_id: &rule_id,
        },
        sha,
        &file.change.path,
        (version_line(file, &pkg.name, &pkg.version), &key),
    )
}

/// The added line that set this package's version: one mentioning the
/// version within three lines of a line naming the package. Falls back to
/// any added line with the version, then to the file's first added line.
fn version_line(file: &MappedFile, name: &str, version: &str) -> u32 {
    let mut first_with_version = None;
    for hunk in &file.change.hunks {
        let mut last_name_at: Option<usize> = None;
        for (i, line) in hunk.lines.iter().enumerate() {
            if line.text.contains(name) {
                last_name_at = Some(i);
            }
            if line.kind != LineKind::Added || !line.text.contains(version) {
                continue;
            }
            let n = line.new_no.unwrap_or(0);
            if last_name_at.is_some_and(|at| i - at <= 3) {
                return n;
            }
            first_with_version.get_or_insert(n);
        }
    }
    first_with_version
        .or_else(|| file.change.added_lines().next().map(|(n, _)| n))
        .unwrap_or(1)
}
