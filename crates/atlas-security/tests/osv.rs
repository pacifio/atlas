use std::cmp::Ordering;
use std::io::Write;

use atlas_security::deps::lockfiles::{Ecosystem, Pkg};
use atlas_security::deps::osv::{build_index, write_index, AdvSeverity, AdvisoryDb, OsvError};
use atlas_security::deps::version::cmp_versions;

fn zip_of(entries: &[(&str, serde_json::Value)]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        for (name, json) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(json.to_string().as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }
    buf
}

fn npm(name: &str, version: &str) -> Pkg {
    Pkg {
        eco: Ecosystem::Npm,
        name: name.to_string(),
        version: version.to_string(),
    }
}

fn db_with(
    eco: Ecosystem,
    entries: &[(&str, serde_json::Value)],
) -> (tempfile::TempDir, AdvisoryDb) {
    let dir = tempfile::tempdir().unwrap();
    let index = build_index(eco, &zip_of(entries)).unwrap();
    write_index(dir.path(), eco, &index).unwrap();
    let db = AdvisoryDb::open(dir.path()).unwrap();
    (dir, db)
}

fn lodash_advisory() -> serde_json::Value {
    serde_json::json!({
        "id": "GHSA-35jh-r3h4-6jhm",
        "aliases": ["CVE-2021-23337"],
        "summary": "Command injection in lodash",
        "affected": [{
            "package": { "ecosystem": "npm", "name": "lodash" },
            "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "1.0.0" }, { "fixed": "4.17.21" }] }]
        }],
        "database_specific": { "severity": "HIGH" }
    })
}

#[test]
fn index_and_lookup_by_explicit_version() {
    let adv = serde_json::json!({
        "id": "GHSA-xxxx", "summary": "bad",
        "affected": [{ "package": { "ecosystem": "npm", "name": "left-pad" }, "versions": ["1.3.0"] }],
        "database_specific": { "severity": "CRITICAL" }
    });
    let (_d, db) = db_with(Ecosystem::Npm, &[("GHSA-xxxx.json", adv)]);
    let hits = db.lookup(&npm("left-pad", "1.3.0"));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "GHSA-xxxx");
    assert_eq!(hits[0].severity, AdvSeverity::Critical);
    assert!(db.lookup(&npm("left-pad", "1.3.1")).is_empty());
    assert!(db.has(Ecosystem::Npm));
    assert!(!db.has(Ecosystem::PyPI));
}

#[test]
fn range_introduced_fixed_matches_between() {
    let (_d, db) = db_with(Ecosystem::Npm, &[("a.json", lodash_advisory())]);
    assert_eq!(db.lookup(&npm("lodash", "4.17.20")).len(), 1);
    assert_eq!(db.lookup(&npm("lodash", "1.0.0")).len(), 1);
    assert!(db.lookup(&npm("lodash", "4.17.21")).is_empty());
    assert!(db.lookup(&npm("lodash", "0.9.0")).is_empty());
    assert_eq!(
        db.lookup(&npm("lodash", "4.17.20"))[0].severity,
        AdvSeverity::High
    );
}

#[test]
fn introduced_zero_and_last_affected() {
    let adv = serde_json::json!({
        "id": "RUSTSEC-2099-0001", "summary": "x",
        "affected": [{
            "package": { "ecosystem": "crates.io", "name": "foo" },
            "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "0" }, { "last_affected": "1.2.0" }] }]
        }]
    });
    let (_d, db) = db_with(Ecosystem::CratesIo, &[("r.json", adv)]);
    let foo = |v: &str| Pkg {
        eco: Ecosystem::CratesIo,
        name: "foo".into(),
        version: v.into(),
    };
    assert_eq!(db.lookup(&foo("0.1.0")).len(), 1);
    assert_eq!(db.lookup(&foo("1.2.0")).len(), 1);
    assert!(db.lookup(&foo("1.2.1")).is_empty());
    assert_eq!(db.lookup(&foo("1.0.0"))[0].severity, AdvSeverity::Unknown);
}

#[test]
fn withdrawn_and_other_ecosystem_entries_are_ignored() {
    let withdrawn = serde_json::json!({
        "id": "GHSA-gone", "withdrawn": "2024-01-01T00:00:00Z",
        "affected": [{ "package": { "ecosystem": "npm", "name": "lodash" }, "versions": ["4.17.20"] }]
    });
    let pypi_entry = serde_json::json!({
        "id": "PYSEC-1",
        "affected": [{ "package": { "ecosystem": "PyPI", "name": "lodash" }, "versions": ["4.17.20"] }]
    });
    let (_d, db) = db_with(
        Ecosystem::Npm,
        &[("w.json", withdrawn), ("p.json", pypi_entry)],
    );
    assert!(db.lookup(&npm("lodash", "4.17.20")).is_empty());
}

#[test]
fn pep440_prerelease_and_post_ordering() {
    let order = [
        "1.0.dev1",
        "1.0a1",
        "1.0b1",
        "1.0rc1",
        "1.0",
        "1.0.post1",
        "1.1",
    ];
    for w in order.windows(2) {
        assert_eq!(
            cmp_versions(Ecosystem::PyPI, w[0], w[1]),
            Some(Ordering::Less),
            "{} < {}",
            w[0],
            w[1]
        );
    }
    assert_eq!(
        cmp_versions(Ecosystem::PyPI, "1.0", "1.0.0"),
        Some(Ordering::Equal)
    );
    assert_eq!(
        cmp_versions(Ecosystem::PyPI, "1!0.1", "2.0"),
        Some(Ordering::Greater)
    );
}

#[test]
fn semver_lenient_padding() {
    assert_eq!(
        cmp_versions(Ecosystem::Npm, "1.2", "1.2.0"),
        Some(Ordering::Equal)
    );
    assert_eq!(
        cmp_versions(Ecosystem::CratesIo, "v2", "1.9.9"),
        Some(Ordering::Greater)
    );
    assert_eq!(
        cmp_versions(Ecosystem::Npm, "1.0.0-beta.1", "1.0.0"),
        Some(Ordering::Less)
    );
}

#[test]
fn unparseable_version_is_not_a_match() {
    let (_d, db) = db_with(Ecosystem::Npm, &[("a.json", lodash_advisory())]);
    assert_eq!(cmp_versions(Ecosystem::Npm, "latest", "1.0.0"), None);
    assert!(db.lookup(&npm("lodash", "latest")).is_empty());
}

#[test]
fn malicious_package_flagged() {
    let adv = serde_json::json!({
        "id": "MAL-2026-1", "summary": "Malicious code in evil-pkg",
        "affected": [{ "package": { "ecosystem": "npm", "name": "evil-pkg" },
                       "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "0" }] }] }]
    });
    let (_d, db) = db_with(Ecosystem::Npm, &[("m.json", adv)]);
    let hits = db.lookup(&npm("evil-pkg", "1.0.0"));
    assert_eq!(hits.len(), 1);
    assert!(hits[0].malicious);
}

#[test]
fn pypi_lookup_uses_normalised_names() {
    let adv = serde_json::json!({
        "id": "PYSEC-2", "summary": "x",
        "affected": [{ "package": { "ecosystem": "PyPI", "name": "Django_REST.Framework" }, "versions": ["3.0.0"] }],
        "database_specific": { "severity": "MODERATE" }
    });
    let (_d, db) = db_with(Ecosystem::PyPI, &[("p.json", adv)]);
    let hit = db.lookup(&Pkg {
        eco: Ecosystem::PyPI,
        name: "django-rest-framework".into(),
        version: "3.0.0".into(),
    });
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].severity, AdvSeverity::Medium);
}

#[test]
fn missing_index_dir_opens_empty() {
    let dir = tempfile::tempdir().unwrap();
    let db = AdvisoryDb::open(&dir.path().join("does-not-exist")).unwrap();
    for eco in Ecosystem::ALL {
        assert!(!db.has(eco));
    }
    assert!(db.lookup(&npm("lodash", "4.17.20")).is_empty());
}

#[test]
fn corrupt_index_is_error_not_panic() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("npm.index.json"), b"{ nope").unwrap();
    assert!(matches!(
        AdvisoryDb::open(dir.path()),
        Err(OsvError::Parse(_))
    ));
}

#[test]
fn corrupt_zip_is_error_not_panic() {
    assert!(matches!(
        build_index(Ecosystem::Npm, b"not a zip"),
        Err(OsvError::Zip(_))
    ));
}

#[test]
fn a_bad_entry_inside_the_zip_is_skipped() {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        w.start_file("bad.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"{ broken").unwrap();
        w.start_file("good.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(lodash_advisory().to_string().as_bytes())
            .unwrap();
        w.finish().unwrap();
    }
    let index = build_index(Ecosystem::Npm, &buf).unwrap();
    let dir = tempfile::tempdir().unwrap();
    write_index(dir.path(), Ecosystem::Npm, &index).unwrap();
    let db = AdvisoryDb::open(dir.path()).unwrap();
    assert_eq!(db.lookup(&npm("lodash", "4.17.20")).len(), 1);
}

/// Measures building real indexes. Not run by default; point
/// `ATLAS_OSV_ZIPS` at a folder holding `crates.io.zip`, `npm.zip` and
/// `PyPI.zip` downloaded from OSV's bulk export.
#[test]
#[ignore]
fn measure_real_indexes() {
    let Ok(dir) = std::env::var("ATLAS_OSV_ZIPS") else {
        return;
    };
    let out = tempfile::tempdir().unwrap();
    for eco in Ecosystem::ALL {
        let zip = std::fs::read(std::path::Path::new(&dir).join(format!("{}.zip", eco.osv_name())))
            .unwrap();
        let t = std::time::Instant::now();
        let index = build_index(eco, &zip).unwrap();
        let built = t.elapsed();
        write_index(out.path(), eco, &index).unwrap();
        let size = std::fs::metadata(out.path().join(format!("{}.index.json", eco.osv_name())))
            .unwrap()
            .len();
        let t = std::time::Instant::now();
        let db = AdvisoryDb::open(out.path()).unwrap();
        let opened = t.elapsed();
        let advisories: usize = index.values().map(Vec::len).sum();
        println!(
            "{:<10} zip {:>6.1} MB  packages {:>7}  entries {:>7}  index {:>6.1} MB  build {:>5.1}s  open-all {:>5.2}s",
            eco.osv_name(), zip.len() as f64 / 1e6, index.len(), advisories, size as f64 / 1e6, built.as_secs_f64(), opened.as_secs_f64()
        );
        drop(db);
    }
}
