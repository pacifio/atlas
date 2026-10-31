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
    let mut buf = Vec::new();
    for i in 0..archive.len() {
        let Ok(mut file) = archive.by_index(i) else {
            continue;
        };
        buf.clear();
        if file.read_to_end(&mut buf).is_err() {
            continue;
        }
        // Typed, so the large fields (details, references, credits) are
        // skipped by the parser instead of built and thrown away.
        let Ok(doc) = serde_json::from_slice::<OsvRecord>(&buf) else {
            continue;
        };
        add_advisory(&mut index, eco, doc);
    }
    Ok(index)
}

/// The fields of an OSV record that matching needs.
#[derive(Deserialize)]
struct OsvRecord {
    id: String,
    #[serde(default)]
    withdrawn: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    affected: Vec<OsvAffected>,
    #[serde(default)]
    database_specific: Option<OsvSeverity>,
    /// CVSS vectors, for records that name no severity of their own
    /// (most RUSTSEC entries).
    #[serde(default)]
    severity: Vec<OsvCvss>,
}

#[derive(Deserialize)]
struct OsvCvss {
    #[serde(rename = "type")]
    kind: String,
    score: String,
}

#[derive(Deserialize)]
struct OsvAffected {
    package: Option<OsvPackage>,
    #[serde(default)]
    versions: Vec<String>,
    #[serde(default)]
    ranges: Vec<OsvRange>,
    #[serde(default)]
    database_specific: Option<OsvSeverity>,
}

#[derive(Deserialize)]
struct OsvPackage {
    ecosystem: String,
    name: String,
}

#[derive(Deserialize)]
struct OsvRange {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    events: Vec<OsvEvent>,
}

#[derive(Deserialize)]
struct OsvEvent {
    introduced: Option<String>,
    fixed: Option<String>,
    last_affected: Option<String>,
}

#[derive(Deserialize)]
struct OsvSeverity {
    severity: Option<String>,
    /// RUSTSEC's notices (`unmaintained`, `unsound`, `notice`): not a
    /// vulnerability in the version a project uses.
    #[serde(default)]
    informational: Option<serde::de::IgnoredAny>,
}

fn add_advisory(index: &mut Index, eco: Ecosystem, doc: OsvRecord) {
    if doc.withdrawn.is_some() {
        return;
    }
    let malicious = doc.id.starts_with("MAL-");
    let cvss_severity = doc
        .severity
        .iter()
        .filter(|s| s.kind == "CVSS_V3")
        .find_map(|s| cvss3_base_score(&s.score))
        .map(severity_from_score);
    let top_informational = doc
        .database_specific
        .as_ref()
        .is_some_and(|d| d.informational.is_some());
    let top_severity = doc.database_specific.and_then(|d| d.severity);
    if top_informational {
        return;
    }
    for entry in doc.affected {
        // `PyPI` exactly; OSV also has qualified forms like `Debian:12`.
        let Some(package) = entry.package.filter(|p| p.ecosystem == eco.osv_name()) else {
            continue;
        };
        if entry
            .database_specific
            .as_ref()
            .is_some_and(|d| d.informational.is_some())
        {
            continue;
        }
        let named = entry
            .database_specific
            .and_then(|d| d.severity)
            .or_else(|| top_severity.clone());
        let ranges: Vec<Vec<Event>> = entry
            .ranges
            .into_iter()
            .filter(|r| matches!(r.kind.as_str(), "SEMVER" | "ECOSYSTEM"))
            .map(|r| r.events.into_iter().filter_map(event).collect::<Vec<_>>())
            .filter(|events| !events.is_empty())
            .collect();
        index
            .entry(index_key(eco, &package.name))
            .or_default()
            .push(IndexedAdvisory {
                id: doc.id.clone(),
                // A malicious package needs no cross-references.
                aliases: if malicious {
                    Vec::new()
                } else {
                    doc.aliases.clone()
                },
                severity: match parse_severity(named.as_deref()) {
                    AdvSeverity::Unknown => cvss_severity.unwrap_or(AdvSeverity::Unknown),
                    known => known,
                },
                malicious,
                versions: entry.versions,
                ranges,
            });
    }
}

fn event(e: OsvEvent) -> Option<Event> {
    if let Some(v) = e.introduced {
        Some(Event {
            kind: EventKind::Introduced,
            version: v,
        })
    } else if let Some(v) = e.fixed {
        Some(Event {
            kind: EventKind::Fixed,
            version: v,
        })
    } else {
        e.last_affected.map(|v| Event {
            kind: EventKind::LastAffected,
            version: v,
        })
    }
}

/// The CVSS v3.x base score of a vector, per the FIRST specification; `None`
/// for anything that is not a complete v3 vector.
pub fn cvss3_base_score(vector: &str) -> Option<f64> {
    let body = vector
        .strip_prefix("CVSS:3.0/")
        .or_else(|| vector.strip_prefix("CVSS:3.1/"))?;
    let mut m = HashMap::new();
    for part in body.split('/') {
        let (k, v) = part.split_once(':')?;
        m.insert(k, v);
    }
    let changed = match *m.get("S")? {
        "U" => false,
        "C" => true,
        _ => return None,
    };
    let av = match *m.get("AV")? {
        "N" => 0.85,
        "A" => 0.62,
        "L" => 0.55,
        "P" => 0.2,
        _ => return None,
    };
    let ac = match *m.get("AC")? {
        "L" => 0.77,
        "H" => 0.44,
        _ => return None,
    };
    let pr = match (*m.get("PR")?, changed) {
        ("N", _) => 0.85,
        ("L", false) => 0.62,
        ("L", true) => 0.68,
        ("H", false) => 0.27,
        ("H", true) => 0.5,
        _ => return None,
    };
    let ui = match *m.get("UI")? {
        "N" => 0.85,
        "R" => 0.62,
        _ => return None,
    };
    let cia = |k: &str| -> Option<f64> {
        match *m.get(k)? {
            "H" => Some(0.56),
            "L" => Some(0.22),
            "N" => Some(0.0),
            _ => None,
        }
    };
    let iss = 1.0 - (1.0 - cia("C")?) * (1.0 - cia("I")?) * (1.0 - cia("A")?);
    let impact = if changed {
        7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powi(15)
    } else {
        6.42 * iss
    };
    if impact <= 0.0 {
        return Some(0.0);
    }
    let exploitability = 8.22 * av * ac * pr * ui;
    let raw = if changed {
        (1.08 * (impact + exploitability)).min(10.0)
    } else {
        (impact + exploitability).min(10.0)
    };
    // The specification's Roundup: the smallest one-decimal number >= raw.
    let int_input = (raw * 100_000.0).round() as i64;
    Some(if int_input % 10_000 == 0 {
        int_input as f64 / 100_000.0
    } else {
        ((int_input / 10_000) + 1) as f64 / 10.0
    })
}

fn severity_from_score(score: f64) -> AdvSeverity {
    match score {
        s if s >= 9.0 => AdvSeverity::Critical,
        s if s >= 7.0 => AdvSeverity::High,
        s if s >= 4.0 => AdvSeverity::Medium,
        s if s > 0.0 => AdvSeverity::Low,
        _ => AdvSeverity::Unknown,
    }
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
    let file = std::fs::File::create(&tmp).map_err(|e| OsvError::Io(e.to_string()))?;
    let mut writer = std::io::BufWriter::new(file);
    serde_json::to_writer(&mut writer, index).map_err(|e| OsvError::Parse(e.to_string()))?;
    std::io::Write::flush(&mut writer).map_err(|e| OsvError::Io(e.to_string()))?;
    drop(writer);
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
        Self::open_only(dir, &Ecosystem::ALL)
    }

    /// [`open`](Self::open) for just these ecosystems. The npm index alone
    /// holds over 300 MB once parsed, so a scan loads only what its
    /// lockfiles need.
    pub fn open_only(dir: &Path, ecosystems: &[Ecosystem]) -> Result<Self, OsvError> {
        let mut indexes = HashMap::new();
        for &eco in ecosystems {
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
/// Measured 2026-10-31 (release build, Apple M-series, the test binary alone):
///
/// | ecosystem | zip | packages | index on disk | build |
/// |---|---|---|---|---|
/// | crates.io | 3.8 MB | 1,681 | 0.7 MB | 0.1 s |
/// | npm | 219.7 MB | 225,919 | 32.4 MB | 1.6 s |
/// | PyPI | 37.6 MB | 13,583 | 18.9 MB | 0.3 s |
///
/// Building all three peaks at about 340 MB resident; opening all three, at
/// about 330 MB, nearly all of it npm. So the download streams to a
/// temporary file beside the index and is indexed from disk, then deleted;
/// records are parsed into typed structs that skip OSV's large text fields;
/// and callers open only the ecosystems a scan needs
/// ([`AdvisoryDb::open_only`]) and drop the database afterwards.
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
