//! Archive resolution: which URLs we accept, where an install lands, what gets
//! collected, and what happens when the bytes are wrong.
//!
//! The pure-function cases include the path-traversal ones — those are the
//! reason the percent-decode is checked rather than trusted.

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
        Some(
            "unsupported archive type .tar.xz in URL: https://example.com/agent.tar.xz".to_string()
        )
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
    assert!(
        github_release_archive_from_url("http://github.com/o/r/releases/download/v1/a").is_none()
    );
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

    let file_name = slash_version
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap();
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

/// A download killed by SIGKILL or a force-quit never runs `TempDir`'s `Drop`,
/// so its staging directory survives holding whatever had arrived. It is made
/// by this crate, in the directory this GC walks — it is ours to collect.
#[tokio::test]
async fn collects_orphaned_staging_directories() {
    let base = tempfile::tempdir().unwrap();
    let base_dir = base.path();

    let orphan = base_dir.join(".tmp-agent-download-crashed");
    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join("payload"), vec![0u8; 4096]).unwrap();
    std::fs::create_dir(base_dir.join("unrelated-dot-dir")).unwrap();

    std::thread::sleep(Duration::from_millis(1100));
    let current = base_dir.join("v_current");
    std::fs::create_dir(&current).unwrap();

    // An install still in flight is newer than the current directory, and the
    // mtime rule is what keeps us from deleting the download out from under it.
    std::thread::sleep(Duration::from_millis(1100));
    std::fs::create_dir(base_dir.join(".tmp-agent-download-inflight")).unwrap();

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
        vec![
            ".tmp-agent-download-inflight",
            "unrelated-dot-dir",
            "v_current"
        ]
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
    assert!(
        !destination.exists(),
        "a failed install must leave nothing behind"
    );
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

    assert!(
        error.to_string().contains("404"),
        "unexpected error: {error:#}"
    );
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

// ------------------------------------------------- extracted permission modes
//
// The bits an archive asks for are not the bits it gets. Both of these are
// properties of third-party crates as much as of ours — tar masks to `0o777`,
// zip applies `external_attributes >> 16` verbatim — so they are pinned here
// rather than assumed, and a dependency bump that changes either will fail.

#[cfg(unix)]
#[tokio::test]
async fn a_zip_entry_does_not_keep_its_setuid_bit() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.zip";
    let http = FakeHttp::new().with(url, 200, zip_with("bin/agent", b"#!/bin/sh\n", 0o4777));

    install_archive(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
    )
    .await
    .unwrap();

    let mode = std::fs::metadata(destination.join("bin/agent"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o7000, 0, "setuid/setgid/sticky survived: {mode:o}");
    assert_eq!(mode & 0o022, 0, "group/other write survived: {mode:o}");
    assert_ne!(
        mode & 0o100,
        0,
        "the binary is no longer executable: {mode:o}"
    );
}

/// tar already strips setuid, but not `0o777` — the world-writable half is the
/// part that is actually reachable, so it gets its own assertion.
#[cfg(unix)]
#[tokio::test]
async fn a_tar_entry_does_not_stay_world_writable() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.tar.gz";
    let http = FakeHttp::new().with(
        url,
        200,
        tar_gz_with_mode("bin/agent", b"#!/bin/sh\n", 0o4777),
    );

    install_archive(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
    )
    .await
    .unwrap();

    let mode = std::fs::metadata(destination.join("bin/agent"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o7000, 0, "setuid/setgid/sticky survived: {mode:o}");
    assert_eq!(mode & 0o022, 0, "group/other write survived: {mode:o}");
    assert_ne!(
        mode & 0o100,
        0,
        "the binary is no longer executable: {mode:o}"
    );
}

// ------------------------------------------------------------- install limits
//
// A checksum does not bound size: a hostile entry publishes the digest of its
// own bad bytes and passes. These drive the real install path against limits
// small enough to reach.

#[tokio::test]
async fn refuses_a_download_past_the_byte_limit() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let http = FakeHttp::new().with(ARCHIVE_URL, 200, vec![0u8; 4096]);

    let error = install_archive_with_limits(
        &*http,
        ARCHIVE_URL,
        None,
        &destination,
        &registry_archive_kind_for_url(ARCHIVE_URL).unwrap(),
        InstallLimits {
            max_download_bytes: 1024,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap_err();

    assert!(
        error.to_string().contains("1024"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists(), "a refused download still installed");
}

/// The cap has to count across chunks, not per chunk. A real server streams,
/// and a per-chunk bound is defeated by the oldest trick there is: send the
/// same total in smaller pieces.
#[tokio::test]
async fn a_download_cap_counts_across_chunks() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let http = FakeHttp::new()
        .with(ARCHIVE_URL, 200, vec![0u8; 4096])
        .chunked(64);

    let error = install_archive_with_limits(
        &*http,
        ARCHIVE_URL,
        None,
        &destination,
        &registry_archive_kind_for_url(ARCHIVE_URL).unwrap(),
        InstallLimits {
            max_download_bytes: 1024,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap_err();

    assert!(
        error.to_string().contains("1024"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists());
}

#[tokio::test]
async fn refuses_a_zip_that_declares_too_many_entries() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.zip";

    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for index in 0..8 {
        writer
            .start_file(
                format!("file{index}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"x").unwrap();
    }
    let body = writer.finish().unwrap().into_inner();

    let http = FakeHttp::new().with(url, 200, body);
    let error = install_archive_with_limits(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
        InstallLimits {
            max_entries: 4,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap_err();

    assert!(
        format!("{error:#}").contains("entries"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists(), "a refused zip still installed");
}

/// The zip guard reads the central directory, so it fires before anything is
/// written — unlike the tar one, which can only fire mid-stream.
#[tokio::test]
async fn refuses_a_zip_that_expands_past_the_byte_limit() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.zip";
    let http = FakeHttp::new().with(url, 200, zip_with("bin/agent", &vec![0u8; 8192], 0o755));

    let error = install_archive_with_limits(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
        InstallLimits {
            max_uncompressed_bytes: 1024,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap_err();

    assert!(
        format!("{error:#}").contains("expands"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists(), "a refused zip still installed");
}

#[tokio::test]
async fn refuses_a_tar_that_expands_past_the_byte_limit() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.tar.gz";
    // Compresses to almost nothing, so only an uncompressed bound catches it.
    let http = FakeHttp::new().with(url, 200, tar_gz_with("bin/agent", &vec![0u8; 64 * 1024]));

    let error = install_archive_with_limits(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
        InstallLimits {
            max_uncompressed_bytes: 1024,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap_err();

    assert!(
        format!("{error:#}").contains("expands"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists(), "a refused tar still installed");
}

/// The bound is "more than", not "as much as". Pinned because an off-by-one
/// here rejects a legitimate archive that happens to sit exactly on the limit.
#[tokio::test]
async fn an_archive_at_exactly_the_byte_limit_still_installs() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.tar.gz";
    let body = tar_gz_with("bin/agent", b"#!/bin/sh\n");
    let exact = body.len() as u64;

    let http = FakeHttp::new().with(url, 200, body);
    install_archive_with_limits(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
        InstallLimits {
            max_download_bytes: exact,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(
        std::fs::read(destination.join("bin/agent")).unwrap(),
        b"#!/bin/sh\n"
    );
}

/// A zip's central directory is a claim, not a measurement. Editing four bytes
/// makes an archive understate what it expands to, and the CRC still matches
/// because the bytes themselves are untouched — so a ceiling that reads the
/// declared size bounds nothing at all.
#[tokio::test]
async fn refuses_a_zip_that_understates_its_own_size() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.zip";
    let payload = vec![0u8; 4 * 1024 * 1024];
    let http = FakeHttp::new().with(url, 200, zip_understating_its_size("bin/agent", &payload));

    let error = install_archive_with_limits(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
        InstallLimits {
            max_uncompressed_bytes: 1024,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap_err();

    // Either our ceiling ("expands …") or, since zip 9, the reader itself
    // ("larger than its declared uncompressed size") refuses it.
    let message = format!("{error:#}");
    assert!(
        message.contains("expands") || message.contains("larger than its declared"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists(), "a zip bomb installed anyway");
}

/// [`zip_with`], with the central directory's `uncompressed_size` rewritten to
/// 1. Everything else — the compressed bytes, the CRC — stays valid.
fn zip_understating_its_size(path: &str, contents: &[u8]) -> Vec<u8> {
    let mut raw = zip_with(path, contents, 0o755);
    let at = raw
        .windows(4)
        .position(|window| window == b"PK\x01\x02")
        .expect("a central directory record");
    raw[at + 24..at + 28].copy_from_slice(&1u32.to_le_bytes());
    raw
}

/// Empty tar entries cost about five bytes each on the wire, so a byte ceiling
/// alone still permits millions of inodes from a small download. The count is
/// its own bound.
#[tokio::test]
async fn refuses_a_tar_with_too_many_entries() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.tar.gz";

    let mut tar = tar::Builder::new(Vec::new());
    for index in 0..32 {
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, format!("file{index}"), &b""[..])
            .unwrap();
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&tar.into_inner().unwrap()).unwrap();

    let http = FakeHttp::new().with(url, 200, encoder.finish().unwrap());
    let error = install_archive_with_limits(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
        InstallLimits {
            max_entries: 8,
            ..InstallLimits::default()
        },
    )
    .await
    .unwrap_err();

    assert!(
        format!("{error:#}").contains("entries"),
        "unexpected error: {error:#}"
    );
    assert!(!destination.exists(), "a refused tar still installed");
}

/// The containment tar gives us is a property of the `tar` crate, not of this
/// code, and switching from `unpack` to a counted `unpack_in` loop is exactly
/// the kind of change that could drop it silently.
#[tokio::test]
async fn a_tar_entry_cannot_escape_the_destination() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("v_1.0.0");
    let url = "https://example.test/agent.tar.gz";

    let outside = dir.path().join("escaped");
    let http = FakeHttp::new().with(url, 200, tar_gz_escaping_to("../escaped"));

    // Whether tar errors or silently strips the `..` is its business; what
    // this pins is that nothing lands outside the destination either way.
    let _ = install_archive_with_limits(
        &*http,
        url,
        None,
        &destination,
        &registry_archive_kind_for_url(url).unwrap(),
        InstallLimits::default(),
    )
    .await;

    assert!(!outside.exists(), "a tar entry escaped the destination");
}

/// A tar whose entry name escapes the destination.
///
/// `tar::Builder` refuses to *write* a `..` path, which is why this patches the
/// header directly: the fixture has to be something a hostile publisher could
/// produce, not something the safe API allows.
fn tar_gz_escaping_to(name: &str) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(0);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "placeholder", &b""[..])
        .unwrap();
    let mut raw = tar.into_inner().unwrap();

    // ustar header: name at 0..100, checksum at 148..156.
    raw[0..100].fill(0);
    raw[0..name.len()].copy_from_slice(name.as_bytes());

    // The checksum is computed with its own field read as spaces.
    raw[148..156].fill(b' ');
    let sum: u32 = raw[0..512].iter().map(|byte| u32::from(*byte)).sum();
    let encoded = format!("{sum:06o}\0 ");
    raw[148..156].copy_from_slice(encoded.as_bytes());

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&raw).unwrap();
    encoder.finish().unwrap()
}

fn zip_with(path: &str, contents: &[u8], mode: u32) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file(
            path,
            zip::write::SimpleFileOptions::default().unix_permissions(mode),
        )
        .unwrap();
    writer.write_all(contents).unwrap();
    writer.finish().unwrap().into_inner()
}

// Unix only, like the permission test that uses it: elsewhere there is no
// mode bit to assert on after the extract.
#[cfg(unix)]
fn tar_gz_with_mode(path: &str, contents: &[u8], mode: u32) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(contents.len() as u64);
    header.set_mode(mode);
    header.set_cksum();
    tar.append_data(&mut header, path, contents).unwrap();
    let tar = tar.into_inner().unwrap();

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&tar).unwrap();
    encoder.finish().unwrap()
}
