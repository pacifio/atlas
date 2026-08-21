//! Archive resolution: which URLs we accept, where an install lands, what gets
//! collected, and what happens when the bytes are wrong.
//!
//! The pure-function cases are ported from
//! `zed-ref/crates/project/src/agent_server_store.rs:2000-2130` and kept
//! case-for-case, including the path-traversal ones — those are the reason the
//! percent-decode is checked rather than trusted.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use atlas_agent_store::archive::*;
use sha2::{Digest as _, Sha256};

mod fake_http;
use fake_http::FakeHttp;

const ARCHIVE_URL: &str = "https://example.test/agent";

// --------------------------------------------------------------- archive kind

#[test]
fn detects_supported_archive_suffixes() {
    for (url, expected) in [
        ("https://example.com/agent.zip", AssetKind::Zip),
        ("https://example.com/agent.zip?download=1", AssetKind::Zip),
        ("https://example.com/agent.ZIP", AssetKind::Zip),
        ("https://example.com/agent.tar.gz", AssetKind::TarGz),
        (
            "https://example.com/agent.tar.gz?download=1#latest",
            AssetKind::TarGz,
        ),
        ("https://example.com/agent.tgz", AssetKind::TarGz),
        ("https://example.com/agent.tgz#download", AssetKind::TarGz),
        ("https://example.com/agent.tar.bz2", AssetKind::TarBz2),
        ("https://example.com/agent.tbz2", AssetKind::TarBz2),
    ] {
        assert_eq!(
            registry_archive_kind_for_url(url).unwrap(),
            RegistryArchiveKind::Archive(expected),
            "for {url}"
        );
    }
}

#[test]
fn detects_raw_binary_archive_urls() {
    for (url, file_name) in [
        (
            "https://x.ai/cli/grok-0.2.20-macos-aarch64",
            "grok-0.2.20-macos-aarch64",
        ),
        (
            "https://x.ai/cli/grok-0.2.20-windows-x86_64.exe",
            "grok-0.2.20-windows-x86_64.exe",
        ),
        (
            "https://example.com/agent-binary?download=1#latest",
            "agent-binary",
        ),
        ("https://example.com/agent%20binary", "agent binary"),
    ] {
        assert_eq!(
            registry_archive_kind_for_url(url).unwrap(),
            RegistryArchiveKind::RawBinary {
                file_name: file_name.to_string()
            },
            "for {url}"
        );
    }
}

/// Percent-decoding is where a traversal would sneak in: `a%2F..%2Fevil`
/// decodes to a path, not a file name.
#[test]
fn rejects_raw_binary_names_that_are_not_file_names() {
    for url in [
        "https://example.com/",
        "https://example.com/a%2F..%2Fevil",
        "https://example.com/%2E%2E",
    ] {
        assert!(
            registry_archive_kind_for_url(url).is_err(),
            "expected {url} to be rejected"
        );
    }
}

#[test]
fn rejects_installers_and_archives_we_cannot_extract() {
    let error = registry_archive_kind_for_url("https://example.com/agent.tar.xz")
        .err()
        .map(|error| error.to_string());
    assert_eq!(
        error,
        Some("unsupported archive type .tar.xz in URL: https://example.com/agent.tar.xz".to_string())
    );

    for installer_url in [
        "https://example.com/agent.dmg",
        "https://example.com/agent.pkg",
        "https://example.com/agent.deb",
        "https://example.com/agent.rpm",
        "https://example.com/agent.msi",
        "https://example.com/agent.AppImage",
    ] {
        assert!(
            registry_archive_kind_for_url(installer_url).is_err(),
            "expected {installer_url} to be rejected"
        );
    }
}

#[test]
fn parses_github_release_archive_urls() {
    let archive = github_release_archive_from_url(
        "https://github.com/owner/repo/releases/download/release%2F2.3.5/agent.tar.bz2?download=1",
    )
    .unwrap();

    assert_eq!(archive.repo_name_with_owner, "owner/repo");
    assert_eq!(archive.tag, "release/2.3.5");
    assert_eq!(archive.asset_name, "agent.tar.bz2");

    assert!(github_release_archive_from_url("https://example.com/agent.zip").is_none());
    assert!(github_release_archive_from_url("http://github.com/o/r/releases/download/v1/a").is_none());
}

// ------------------------------------------------------- versioned cache dirs

#[test]
fn versioned_archive_cache_dir_includes_artifact_identity() {
    let base = Path::new("/tmp/agents");
    let slash_version = versioned_archive_cache_dir(
        base,
        Some("release/2.3.5"),
        "https://example.com/agent.zip",
        None,
    );
    let colon_version = versioned_archive_cache_dir(
        base,
        Some("release:2.3.5"),
        "https://example.com/agent.zip",
        None,
    );

    let file_name = slash_version.file_name().and_then(|name| name.to_str()).unwrap();
    assert!(file_name.starts_with("v_release-2.3.5_"), "got {file_name}");
    // Two versions that sanitize to the same string still get separate dirs.
    assert_ne!(slash_version, colon_version);

    let lowercase = versioned_archive_cache_dir(
        base,
        Some("release/2.3.5"),
        "https://example.com/agent.zip",
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    );
    let uppercase = versioned_archive_cache_dir(
        base,
        Some("release/2.3.5"),
        "https://example.com/agent.zip",
        Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    );
    let changed = versioned_archive_cache_dir(
        base,
        Some("release/2.3.5"),
        "https://example.com/agent.zip",
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );

    // An unverified install and a verified one are different artifacts…
    assert_ne!(slash_version, lowercase);
    // …checksum case is not…
    assert_eq!(lowercase, uppercase);
    // …but a changed checksum is.
    assert_ne!(lowercase, changed);
}

#[test]
fn sanitizes_path_components() {
    assert_eq!(sanitize_path_component("release/2.3.5"), "release-2.3.5");
    assert_eq!(sanitize_path_component("../../etc"), "..-..-etc");
    assert_eq!(sanitize_path_component(""), "unknown");
}

/// Older version directories go; the current one, a newer sibling, a non-`v_`
/// directory and a `v_`-prefixed *file* all stay.
#[tokio::test]
async fn removes_only_stale_version_directories() {
    let base = tempfile::tempdir().unwrap();
    let base_dir = base.path();

    std::fs::create_dir(base_dir.join("v_old_1")).unwrap();
    std::fs::create_dir(base_dir.join("v_old_2")).unwrap();
    std::fs::create_dir(base_dir.join("other")).unwrap();
    std::fs::write(base_dir.join("v_not_a_dir"), b"keep me").unwrap();

    // The GC compares mtimes, so the fixture needs them to actually differ.
    // A second is the coarsest granularity any filesystem we run on reports.
    std::thread::sleep(Duration::from_millis(1100));
    let current = base_dir.join("v_current");
    std::fs::create_dir(&current).unwrap();

    // A sibling that finished extracting *after* we looked at the current dir
    // must survive — that is the race the mtime rule exists for.
    std::thread::sleep(Duration::from_millis(1100));
    std::fs::create_dir(base_dir.join("v_newer")).unwrap();

    remove_stale_versioned_archive_cache_dirs(base_dir, &current)
        .await
        .unwrap();

    let mut remaining = std::fs::read_dir(base_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    remaining.sort();

    assert_eq!(
        remaining,
        vec!["other", "v_current", "v_newer", "v_not_a_dir"]
    );
}

// -------------------------------------------------------------- installation

#[tokio::test]
async fn installs_a_raw_binary_and_marks_it_executable() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let contents = b"verified agent";
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, contents.to_vec());
    let digest = format!("{:x}", Sha256::digest(contents));

    install_archive(
        &*http,
        ARCHIVE_URL,
        Some(&digest),
        &destination,
        &registry_archive_kind_for_url(ARCHIVE_URL).unwrap(),
    )
    .await
    .unwrap();

    let binary = destination.join("agent");
    assert_eq!(std::fs::read(&binary).unwrap(), contents);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert!(std::fs::metadata(&binary).unwrap().permissions().mode() & 0o111 != 0);
    }
}

/// A published checksum is a gate, not a hint: unverified bytes must never
/// reach the install directory.
#[tokio::test]
async fn refuses_to_install_bytes_that_do_not_match_the_checksum() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, b"unexpected agent".to_vec());
    let expected = "0000000000000000000000000000000000000000000000000000000000000000";

    let error = install_archive(
        &*http,
        ARCHIVE_URL,
        Some(expected),
        &destination,
        &registry_archive_kind_for_url(ARCHIVE_URL).unwrap(),
    )
    .await
    .unwrap_err();

    assert!(
        error.to_string().contains("SHA-256 mismatch"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists(), "a failed install must leave nothing behind");
}

#[tokio::test]
async fn a_failed_install_leaves_a_previous_one_alone() {
    let dir = tempfile::tempdir().unwrap();
    let previous = dir.path().join("v_previous");
    std::fs::create_dir(&previous).unwrap();
    std::fs::write(previous.join("agent"), b"working agent").unwrap();

    let http = FakeHttp::new().with(ARCHIVE_URL, 200, b"unexpected agent".to_vec());
    install_archive(
        &*http,
        ARCHIVE_URL,
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
        &dir.path().join("v_next"),
        &registry_archive_kind_for_url(ARCHIVE_URL).unwrap(),
    )
    .await
    .unwrap_err();

    assert_eq!(
        std::fs::read(previous.join("agent")).unwrap(),
        b"working agent"
    );
}

#[tokio::test]
async fn installs_a_tar_gz_archive() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.tar.gz";
    let http = FakeHttp::new().with(url, 200, tar_gz_with("bin/agent", b"#!/bin/sh\n"));

    install_archive(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(
        std::fs::read(destination.join("bin/agent")).unwrap(),
        b"#!/bin/sh\n"
    );
}

#[tokio::test]
async fn a_404_is_an_error_not_an_install() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let http = FakeHttp::new();

    let error = install_archive(
        &*http,
        ARCHIVE_URL,
        None,
        &destination,
        &registry_archive_kind_for_url(ARCHIVE_URL).unwrap(),
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("404"), "unexpected error: {error:#}");
    assert!(!destination.exists());
}

fn tar_gz_with(path: &str, contents: &[u8]) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(contents.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    tar.append_data(&mut header, path, contents).unwrap();
    let tar = tar.into_inner().unwrap();

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&tar).unwrap();
    encoder.finish().unwrap()
}
