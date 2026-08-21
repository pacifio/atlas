//! Getting a registry agent's binary onto disk, and keeping the disk tidy.
//!
//! Ported from `zed-ref/crates/project/src/agent_server_store.rs:896-1115` (the
//! archive-kind rules, the versioned cache directory, the stale-directory GC)
//! and `zed-ref/crates/http_client/src/github_download.rs` (staged download,
//! checksum verification, extraction).
//!
//! Three properties are the point of this module, and each is a bug that
//! happened to someone:
//!
//! 1. **A version's install directory is named after the artifact, not just the
//!    version.** A registry correction that repoints the same version at a
//!    different asset must not resolve to the previous extraction.
//! 2. **Unverified bytes never become the install.** Everything downloads into
//!    a staging directory, is hashed on the way in, and is only renamed into
//!    place after the checksum matches. A mismatch leaves the previous install
//!    exactly as it was.
//! 3. **Installer formats are rejected, not guessed at.** `.dmg`/`.pkg`/`.msi`
//!    and archive formats we cannot extract fail loudly; treating them as raw
//!    binaries would produce an install that is broken in a confusing way.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context as _, Result};
use futures::StreamExt as _;
use percent_encoding::percent_decode_str;
use tokio::io::AsyncWriteExt as _;
use sha2::{Digest, Sha256};
use url::Url;

use crate::http::{get_body, HttpClient};

const GITHUB_API_URL: &str = "https://api.github.com";
const GITHUB_RELEASE_TIMEOUT: Duration = Duration::from_secs(15);

/// The archive formats we can extract. Zed's `AssetKind` also has `Gz`, which
/// is unreachable from this path: a bare `.gz` is in the rejected-suffix list
/// below, and `.tar.gz` matches before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Zip,
    TarGz,
    TarBz2,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RegistryArchiveKind {
    Archive(AssetKind),
    /// The archive URL points directly at an executable, per the ACP registry
    /// schema: "URL to download archive (.zip, .tar.gz, .tgz, .tar.bz2, .tbz2,
    /// or raw binary)".
    RawBinary { file_name: String },
}

/// Ported verbatim from `agent_server_store.rs:906-948`.
pub fn registry_archive_kind_for_url(archive_url: &str) -> Result<RegistryArchiveKind> {
    const UNSUPPORTED_SUFFIXES: &[&str] = &[
        // Installer formats explicitly rejected by the registry schema.
        ".dmg",
        ".pkg",
        ".deb",
        ".rpm",
        ".msi",
        ".appimage",
        // Archive formats we cannot extract; treating them as raw binaries
        // would produce a broken install.
        ".tar.xz",
        ".txz",
        ".tar",
        ".gz",
        ".bz2",
        ".xz",
        ".7z",
    ];

    let archive_path = Url::parse(archive_url)
        .ok()
        .map(|url| url.path().to_string())
        .unwrap_or_else(|| archive_url.to_string());
    let lowercase_path = archive_path.to_lowercase();

    if lowercase_path.ends_with(".zip") {
        Ok(RegistryArchiveKind::Archive(AssetKind::Zip))
    } else if lowercase_path.ends_with(".tar.gz") || lowercase_path.ends_with(".tgz") {
        Ok(RegistryArchiveKind::Archive(AssetKind::TarGz))
    } else if lowercase_path.ends_with(".tar.bz2") || lowercase_path.ends_with(".tbz2") {
        Ok(RegistryArchiveKind::Archive(AssetKind::TarBz2))
    } else if let Some(suffix) = UNSUPPORTED_SUFFIXES
        .iter()
        .find(|suffix| lowercase_path.ends_with(*suffix))
    {
        bail!("unsupported archive type {suffix} in URL: {archive_url}");
    } else {
        let file_name = raw_binary_file_name(&archive_path)
            .with_context(|| format!("determining binary file name from URL: {archive_url}"))?;
        Ok(RegistryArchiveKind::RawBinary { file_name })
    }
}

/// The name to install a raw binary as. Percent-decoded, then checked — the
/// decode is exactly where `a%2F..%2Fevil` would otherwise become a traversal.
fn raw_binary_file_name(archive_path: &str) -> Result<String> {
    let last_segment = archive_path
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .context("URL has no file name")?;
    let file_name = percent_decode_str(last_segment)
        .decode_utf8()
        .context("file name is not valid UTF-8")?
        .into_owned();
    anyhow::ensure!(
        !file_name.is_empty()
            && file_name != "."
            && file_name != ".."
            && !file_name.contains(['/', '\\'])
            && !file_name.contains('\0'),
        "invalid binary file name: {file_name}"
    );
    Ok(file_name)
}

pub struct GithubReleaseArchive {
    pub repo_name_with_owner: String,
    pub tag: String,
    pub asset_name: String,
}

/// Ported from `agent_server_store.rs:978-1005`. Recognising a GitHub release
/// URL is what makes checksum recovery possible for registry entries that
/// published no `sha256`.
pub fn github_release_archive_from_url(archive_url: &str) -> Option<GithubReleaseArchive> {
    fn decode_path_segment(segment: &str) -> Option<String> {
        percent_decode_str(segment)
            .decode_utf8()
            .ok()
            .map(|segment| segment.into_owned())
    }

    let url = Url::parse(archive_url).ok()?;
    if url.scheme() != "https" || url.host_str()? != "github.com" {
        return None;
    }

    let segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.len() < 6 || segments[2] != "releases" || segments[3] != "download" {
        return None;
    }

    Some(GithubReleaseArchive {
        repo_name_with_owner: format!("{}/{}", segments[0], segments[1]),
        tag: decode_path_segment(segments[4])?,
        asset_name: segments[5..]
            .iter()
            .map(|segment| decode_path_segment(segment))
            .collect::<Option<Vec<_>>>()?
            .join("/"),
    })
}

#[derive(serde::Deserialize)]
struct GithubRelease {
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

#[derive(serde::Deserialize)]
struct GithubReleaseAsset {
    name: String,
    #[serde(default)]
    digest: Option<String>,
}

/// The checksum GitHub itself recorded for a release asset.
///
/// Best-effort by design (Zed's `agent_server_store.rs:1228-1256` swallows every
/// failure the same way): if the API is unreachable, rate-limited, or the asset
/// has no digest, the download proceeds unverified rather than failing. A
/// registry entry that published its own `sha256` never reaches here.
pub async fn github_release_digest(
    http: &dyn HttpClient,
    archive: &GithubReleaseArchive,
) -> Option<String> {
    let url = format!(
        "{GITHUB_API_URL}/repos/{}/releases/tags/{}",
        archive.repo_name_with_owner, archive.tag
    );
    let (status, body) = get_body(http, &url, GITHUB_RELEASE_TIMEOUT).await.ok()?;
    if status >= 400 {
        tracing::debug!(status, url, "github release lookup failed");
        return None;
    }
    let release: GithubRelease = serde_json::from_slice(&body).ok()?;
    let asset = release
        .assets
        .into_iter()
        .find(|asset| asset.name == archive.asset_name)?;
    let digest = asset.digest?;
    Some(
        digest
            .strip_prefix("sha256:")
            .map(str::to_owned)
            .unwrap_or(digest),
    )
}

/// Turn anything into something safe to use as a single path component.
///
/// Ported from `agent_server_store.rs:1006-1019`. Registry ids and versions
/// reach the filesystem here, and a version like `release/2.3.5` would
/// otherwise create a directory tree.
pub fn sanitize_path_component(input: &str) -> String {
    let sanitized = input
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => character,
            _ => '-',
        })
        .collect::<String>();

    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

/// `<base>/v_<version>_<hash(version)[..16]>_<hash(url+sha)[..16]>`.
///
/// Ported from `agent_server_store.rs:1023-1049`. The version goes in twice on
/// purpose: sanitized so a human can read the directory, hashed so two versions
/// that sanitize to the same string still get separate directories. The archive
/// hash covers the URL *and* the expected checksum, which is what makes a
/// registry correction land in a fresh directory instead of reusing the old
/// extraction.
pub fn versioned_archive_cache_dir(
    base_dir: &Path,
    version: Option<&str>,
    archive_url: &str,
    sha256: Option<&str>,
) -> PathBuf {
    let version = version.unwrap_or_default();
    let sanitized_version = sanitize_path_component(version);

    let mut version_hasher = Sha256::new();
    version_hasher.update(version.as_bytes());
    let version_hash = format!("{:x}", version_hasher.finalize());

    let mut archive_hasher = Sha256::new();
    archive_hasher.update(archive_url.as_bytes());
    if let Some(sha256) = sha256 {
        archive_hasher.update(b"\0sha256:");
        archive_hasher.update(sha256.to_ascii_lowercase().as_bytes());
    }
    let archive_hash = format!("{:x}", archive_hasher.finalize());

    base_dir.join(format!(
        "v_{sanitized_version}_{}_{}",
        &version_hash[..16],
        &archive_hash[..16],
    ))
}

// The `v_` prefix here must stay in sync with `versioned_archive_cache_dir`,
// so we only ever remove directories that we created ourselves.
const VERSIONED_ARCHIVE_CACHE_DIR_PREFIX: &str = "v_";

/// Delete the install directories of versions we no longer run.
///
/// Ported from `agent_server_store.rs:1055-1115`, including the mtime rule:
/// only directories *older* than the current one are removed, so a concurrent
/// extraction of a different version that finished after we looked survives.
pub async fn remove_stale_versioned_archive_cache_dirs(
    base_dir: &Path,
    current_version_dir: &Path,
) -> Result<()> {
    let Some(current_dir_name) = current_version_dir.file_name() else {
        return Ok(());
    };

    let current_mtime = modified_at(current_version_dir)
        .await
        .with_context(|| format!("reading metadata for {current_version_dir:?}"))?;

    let mut entries = tokio::fs::read_dir(base_dir)
        .await
        .with_context(|| format!("reading archive cache directory {base_dir:?}"))?;

    while let Some(entry) = entries
        .next_entry()
        .await
        .with_context(|| format!("reading entry in {base_dir:?}"))?
    {
        let entry_name = entry.file_name();
        if entry_name == current_dir_name
            || !entry_name
                .to_string_lossy()
                .starts_with(VERSIONED_ARCHIVE_CACHE_DIR_PREFIX)
        {
            continue;
        }

        let path = entry.path();
        let Ok(metadata) = tokio::fs::metadata(&path).await else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let Ok(entry_mtime) = metadata.modified() else {
            continue;
        };
        // Only remove directories that predate the current version's directory.
        // This avoids racing with a concurrent extraction of a different version
        // that finished after we cached the current version's mtime.
        if current_mtime <= entry_mtime {
            continue;
        }

        tokio::fs::remove_dir_all(&path)
            .await
            .with_context(|| format!("removing stale archive cache directory {path:?}"))?;
    }

    Ok(())
}

async fn modified_at(path: &Path) -> Result<SystemTime> {
    Ok(tokio::fs::metadata(path).await?.modified()?)
}

/// Download `url` into `destination_dir`, verifying `digest` if we have one.
///
/// The whole download lands in a staging directory beside the destination and
/// is renamed into place only once it has been verified and extracted, which is
/// what keeps a failed or mismatched download from replacing a working install
/// (`github_download.rs:43-129`).
///
/// Divergence from Zed: the payload is always staged to a file, even when no
/// checksum was published. Zed streams straight into the extractor in that
/// case; one code path is worth the temp file, and the verified path had to
/// stage anyway.
pub async fn install_archive(
    http: &dyn HttpClient,
    url: &str,
    digest: Option<&str>,
    destination_dir: &Path,
    kind: &RegistryArchiveKind,
) -> Result<()> {
    let parent = destination_dir
        .parent()
        .context("destination path has no parent")?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("creating {parent:?}"))?;

    let staging = tempfile::Builder::new()
        .prefix(".tmp-agent-download-")
        .tempdir_in(parent)
        .with_context(|| format!("creating staging directory in {parent:?}"))?;

    let payload = staging.path().join("payload");
    let extracted = staging.path().join("extracted");
    tokio::fs::create_dir_all(&extracted).await?;

    let actual_digest = download_to_file(http, url, &payload).await?;
    if let Some(expected) = digest {
        anyhow::ensure!(
            actual_digest.eq_ignore_ascii_case(expected),
            "{url} asset got SHA-256 mismatch. Expected: {expected}, Got: {actual_digest}",
        );
    }

    match kind {
        RegistryArchiveKind::Archive(asset_kind) => {
            let (payload, destination, asset_kind) =
                (payload.clone(), extracted.clone(), *asset_kind);
            tokio::task::spawn_blocking(move || extract(&payload, &destination, asset_kind))
                .await
                .context("extraction task panicked")?
                .with_context(|| format!("extracting {url} into {extracted:?}"))?;
        }
        RegistryArchiveKind::RawBinary { file_name } => {
            let binary_path = extracted.join(file_name);
            tokio::fs::rename(&payload, &binary_path)
                .await
                .with_context(|| format!("installing raw binary at {binary_path:?}"))?;
            make_executable(&binary_path).await?;
        }
    }

    // `remove_dir_all` first: a rename onto an existing directory fails, and a
    // destination that exists here is a previous attempt, not a live install —
    // a live one would have short-circuited before the download.
    let _ = tokio::fs::remove_dir_all(destination_dir).await;
    tokio::fs::rename(&extracted, destination_dir)
        .await
        .with_context(|| format!("renaming {extracted:?} to {destination_dir:?}"))?;

    Ok(())
}

/// Stream a URL to a file, returning the hex SHA-256 of what was written.
async fn download_to_file(http: &dyn HttpClient, url: &str, destination: &Path) -> Result<String> {
    let response = http
        .get(url)
        .await
        .with_context(|| format!("downloading {url}"))?;
    anyhow::ensure!(
        response.status < 400,
        "download of {url} failed with status {}",
        response.status
    );

    let mut body = response.body;
    let mut file = tokio::fs::File::create(destination)
        .await
        .with_context(|| format!("creating {destination:?}"))?;
    let mut hasher = Sha256::new();

    while let Some(chunk) = body.next().await {
        let chunk = chunk.with_context(|| format!("reading {url}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .with_context(|| format!("writing {destination:?}"))?;
    }
    file.flush().await?;

    Ok(format!("{:x}", hasher.finalize()))
}

fn extract(payload: &Path, destination: &Path, kind: AssetKind) -> Result<()> {
    let file = std::fs::File::open(payload)?;
    match kind {
        AssetKind::Zip => {
            zip::ZipArchive::new(file)?.extract(destination)?;
        }
        AssetKind::TarGz => {
            unpack_tar(flate2::read::GzDecoder::new(file), destination)?;
        }
        AssetKind::TarBz2 => {
            unpack_tar(bzip2::read::BzDecoder::new(file), destination)?;
        }
    }
    Ok(())
}

fn unpack_tar(reader: impl std::io::Read, destination: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    // Zed turns mtime preservation off (`github_download.rs:288-292`): it is
    // irrelevant to a downloaded archive, and some filesystems error when asked
    // to apply it after extraction.
    archive.set_preserve_mtime(false);
    archive.unpack(destination)?;
    Ok(())
}

async fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .await
            .with_context(|| format!("marking {path:?} as executable"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
