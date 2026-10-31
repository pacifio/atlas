//! A local copy of the OSV advisory database, per ecosystem.
//!
//! `refresh` downloads OSV's public bulk export for each ecosystem and keeps a
//! compact index on disk: only the fields matching needs, keyed by package
//! name. The download sends nothing about the user's project, and every lookup
//! afterwards is local, so the scanner never tells anyone which packages a
//! project uses.
//!
//! Size (measured 2026-10-31, see the comment on [`refresh`]) is why the zip
//! is discarded after indexing and only matching fields are kept.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::deps::lockfiles::{normalize_pypi, Ecosystem, Pkg};
use crate::deps::version::cmp_versions;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdvSeverity {
    Critical,
    High,
    Medium,
    Low,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advisory {
    pub id: String,
    pub aliases: Vec<String>,
    pub severity: AdvSeverity,
    /// OSV's `MAL-` entries: a package published to do harm.
    pub malicious: bool,
    pub summary: String,
}

#[derive(Debug)]
pub enum OsvError {
    Io(String),
    Zip(String),
    Parse(String),
    Http(String),
}

impl std::fmt::Display for OsvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(m) => write!(f, "advisory data I/O: {m}"),
            Self::Zip(m) => write!(f, "advisory archive: {m}"),
            Self::Parse(m) => write!(f, "advisory index: {m}"),
            Self::Http(m) => write!(f, "advisory download: {m}"),
        }
    }
}

impl std::error::Error for OsvError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EventKind {
    Introduced,
    Fixed,
    LastAffected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Event {
    kind: EventKind,
    version: String,
}

/// One advisory's entry for one package, as stored in the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexedAdvisory {
    id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    aliases: Vec<String>,
    severity: AdvSeverity,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    malicious: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    versions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    ranges: Vec<Vec<Event>>,
}

/// Package name → its advisories, for one ecosystem.
pub type Index = HashMap<String, Vec<IndexedAdvisory>>;

fn index_file(dir: &Path, eco: Ecosystem) -> PathBuf {
    dir.join(format!("{}.index.json", eco.osv_name()))
}

fn index_key(eco: Ecosystem, name: &str) -> String {
    match eco {
        Ecosystem::PyPI => normalize_pypi(name),
        _ => name.to_string(),
    }
}

/// Build an index from OSV's `all.zip` for `eco`. An entry that does not
/// parse is skipped; only an unreadable archive is an error.
pub fn build_index(eco: Ecosystem, zip_bytes: &[u8]) -> Result<Index, OsvError> {
    build_index_from(eco, std::io::Cursor::new(zip_bytes))
}

/// [`build_index`] over any seekable reader, so a downloaded archive is read
/// from disk rather than held in memory.
pub fn build_index_from<R: Read + std::io::Seek>(
    eco: Ecosystem,
    reader: R,
) -> Result<Index, OsvError> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| OsvError::Zip(e.to_string()))?;
    let mut index: Index = HashMap::new();
    let mut buf = String::new();
    for i in 0..archive.len() {
        let Ok(mut file) = archive.by_index(i) else {
            continue;
        };
        buf.clear();
        if file.read_to_string(&mut buf).is_err() {
            continue;
        }
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&buf) else {
            continue;
        };
        add_advisory(&mut index, eco, &doc);
    }
    Ok(index)
}

fn add_advisory(index: &mut Index, eco: Ecosystem, doc: &serde_json::Value) {
    if doc.get("withdrawn").is_some() {
        return;
    }
    let Some(id) = doc.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    let strings = |key: &str| -> Vec<String> {
        doc.get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let top_severity = doc
        .get("database_specific")
        .and_then(|d| d.get("severity"))
        .and_then(|s| s.as_str());
    let summary = doc
        .get("summary")
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    let Some(affected) = doc.get("affected").and_then(|a| a.as_array()) else {
        return;
    };
    for entry in affected {
        let package = entry.get("package");
        let entry_eco = package
            .and_then(|p| p.get("ecosystem"))
            .and_then(|e| e.as_str());
        // `PyPI` exactly; OSV also has qualified forms like `Debian:12`.
        if entry_eco != Some(eco.osv_name()) {
            continue;
        }
        let Some(name) = package.and_then(|p| p.get("name")).and_then(|n| n.as_str()) else {
            continue;
        };
        let severity_str = entry
            .get("database_specific")
            .and_then(|d| d.get("severity"))
            .and_then(|s| s.as_str())
            .or(top_severity);
        let versions = entry
            .get("versions")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let ranges = entry
            .get("ranges")
            .and_then(|r| r.as_array())
            .map(|ranges| {
                ranges
                    .iter()
                    .filter(|r| {
                        matches!(
                            r.get("type").and_then(|t| t.as_str()),
                            Some("SEMVER" | "ECOSYSTEM")
                        )
                    })
                    .map(|r| parse_events(r.get("events")))
                    .filter(|events: &Vec<Event>| !events.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        index
            .entry(index_key(eco, name))
            .or_default()
            .push(IndexedAdvisory {
                id: id.to_string(),
                aliases: strings("aliases"),
                severity: parse_severity(severity_str),
                malicious: id.starts_with("MAL-"),
                summary: summary.clone(),
                versions,
                ranges,
            });
    }
}

fn parse_events(events: Option<&serde_json::Value>) -> Vec<Event> {
    let Some(list) = events.and_then(|e| e.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|e| {
            let (kind, key) = if e.get("introduced").is_some() {
                (EventKind::Introduced, "introduced")
            } else if e.get("fixed").is_some() {
                (EventKind::Fixed, "fixed")
            } else if e.get("last_affected").is_some() {
                (EventKind::LastAffected, "last_affected")
            } else {
                return None;
            };
            Some(Event {
                kind,
                version: e.get(key)?.as_str()?.to_string(),
            })
        })
        .collect()
}

fn parse_severity(raw: Option<&str>) -> AdvSeverity {
    match raw.map(str::to_ascii_uppercase).as_deref() {
        Some("CRITICAL") => AdvSeverity::Critical,
        Some("HIGH") => AdvSeverity::High,
        Some("MODERATE" | "MEDIUM") => AdvSeverity::Medium,
        Some("LOW") => AdvSeverity::Low,
        _ => AdvSeverity::Unknown,
    }
}

/// Write one ecosystem's index atomically: temp file, then rename.
pub fn write_index(dir: &Path, eco: Ecosystem, index: &Index) -> Result<(), OsvError> {
    std::fs::create_dir_all(dir).map_err(|e| OsvError::Io(e.to_string()))?;
    let path = index_file(dir, eco);
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(index).map_err(|e| OsvError::Parse(e.to_string()))?;
    std::fs::write(&tmp, bytes).map_err(|e| OsvError::Io(e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| OsvError::Io(e.to_string()))
}

/// The local advisory data, for whichever ecosystems have an index.
#[derive(Debug, Default)]
pub struct AdvisoryDb {
    indexes: HashMap<Ecosystem, Index>,
}

impl AdvisoryDb {
    /// Load every index present under `dir`. A missing directory is an empty
    /// database; an index that does not parse is an error.
    pub fn open(dir: &Path) -> Result<Self, OsvError> {
        let mut indexes = HashMap::new();
        for eco in Ecosystem::ALL {
            let path = index_file(dir, eco);
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(OsvError::Io(e.to_string())),
            };
            let index: Index =
                serde_json::from_slice(&bytes).map_err(|e| OsvError::Parse(e.to_string()))?;
            indexes.insert(eco, index);
        }
        Ok(Self { indexes })
    }

    pub fn has(&self, eco: Ecosystem) -> bool {
        self.indexes.contains_key(&eco)
    }

    /// Advisories that affect exactly this package version.
    pub fn lookup(&self, pkg: &Pkg) -> Vec<Advisory> {
        let Some(entries) = self
            .indexes
            .get(&pkg.eco)
            .and_then(|i| i.get(&index_key(pkg.eco, &pkg.name)))
        else {
            return Vec::new();
        };
        entries
            .iter()
            .filter(|a| affects(a, pkg.eco, &pkg.version))
            .map(|a| Advisory {
                id: a.id.clone(),
                aliases: a.aliases.clone(),
                severity: a.severity,
                malicious: a.malicious,
                summary: a.summary.clone(),
            })
            .collect()
    }
}

fn affects(adv: &IndexedAdvisory, eco: Ecosystem, version: &str) -> bool {
    if adv.versions.iter().any(|v| v == version) {
        return true;
    }
    adv.ranges
        .iter()
        .any(|events| in_range(events, eco, version))
}

/// OSV range semantics: affected from each `introduced` until the next
/// `fixed` (exclusive) or `last_affected` (inclusive). `introduced: 0` is the
/// beginning of time. An unparseable comparison is never a match.
fn in_range(events: &[Event], eco: Ecosystem, version: &str) -> bool {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let mut introduced: Option<&str> = None;
    let at_or_after = |floor: &str| -> Option<bool> {
        if floor == "0" {
            return Some(true);
        }
        Some(matches!(
            cmp_versions(eco, version, floor)?,
            Greater | Equal
        ))
    };
    for e in events {
        match e.kind {
            EventKind::Introduced => introduced = Some(&e.version),
            EventKind::Fixed | EventKind::LastAffected => {
                let Some(start) = introduced.take() else {
                    continue;
                };
                let Some(true) = at_or_after(start) else {
                    continue;
                };
                let Some(ord) = cmp_versions(eco, version, &e.version) else {
                    continue;
                };
                let inside = match e.kind {
                    EventKind::Fixed => ord == Less,
                    _ => matches!(ord, Less | Equal),
                };
                if inside {
                    return true;
                }
            }
        }
    }
    // An open range: introduced with no end.
    introduced.is_some_and(|start| at_or_after(start) == Some(true))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RefreshOutcome {
    pub refreshed: Vec<Ecosystem>,
    pub fresh: Vec<Ecosystem>,
    pub failed: Vec<(Ecosystem, String)>,
}

/// Download and index each ecosystem whose index is missing or older than
/// `max_age`. A failure for one ecosystem leaves its previous index in place.
///
/// Measured 2026-10-31 (release build, Apple M-series):
///
/// | ecosystem | zip | packages | index on disk | build |
/// |---|---|---|---|---|
/// | crates.io | 3.8 MB | 1,681 | 1.0 MB | 0.1 s |
/// | npm | 219.7 MB | 225,919 | 47.2 MB | 1.5 s |
/// | PyPI | 37.6 MB | 13,583 | 20.7 MB | 0.3 s |
///
/// Holding the npm zip in memory while indexing peaked near 1 GB, so the
/// download streams to a temporary file beside the index and is indexed
/// from disk, then deleted. Callers should open [`AdvisoryDb`] only for a
/// scan that changes a lockfile, and drop it afterwards.
pub async fn refresh(dir: &Path, client: &reqwest::Client, max_age: Duration) -> RefreshOutcome {
    let mut outcome = RefreshOutcome::default();
    for eco in Ecosystem::ALL {
        let path = index_file(dir, eco);
        let age = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok());
        if age.is_some_and(|a| a < max_age) {
            outcome.fresh.push(eco);
            continue;
        }
        match fetch_and_index(dir, client, eco).await {
            Ok(()) => outcome.refreshed.push(eco),
            Err(e) => outcome.failed.push((eco, e.to_string())),
        }
    }
    outcome
}

async fn fetch_and_index(
    dir: &Path,
    client: &reqwest::Client,
    eco: Ecosystem,
) -> Result<(), OsvError> {
    use std::io::Write;
    let url = format!(
        "https://osv-vulnerabilities.storage.googleapis.com/{}/all.zip",
        eco.osv_name()
    );
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| OsvError::Http(e.to_string()))?;
    if !response.status().is_success() {
        return Err(OsvError::Http(format!("HTTP {}", response.status())));
    }
    std::fs::create_dir_all(dir).map_err(|e| OsvError::Io(e.to_string()))?;
    let part = dir.join(format!("{}.zip.part", eco.osv_name()));
    let result = async {
        let mut file = std::fs::File::create(&part).map_err(|e| OsvError::Io(e.to_string()))?;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| OsvError::Http(e.to_string()))?
        {
            file.write_all(&chunk)
                .map_err(|e| OsvError::Io(e.to_string()))?;
        }
        file.flush().map_err(|e| OsvError::Io(e.to_string()))?;
        drop(file);
        let reader = std::fs::File::open(&part).map_err(|e| OsvError::Io(e.to_string()))?;
        let index = build_index_from(eco, std::io::BufReader::new(reader))?;
        write_index(dir, eco, &index)
    }
    .await;
    let _ = std::fs::remove_file(&part);
    result
}
