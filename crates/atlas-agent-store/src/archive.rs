//! Getting a registry agent's binary onto disk, and keeping the disk tidy.
//!
//! It covers the archive-kind rules, the versioned cache directory, the
//! stale-directory GC, and the staged download with checksum verification and
//! extraction.
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
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt as _;
use url::Url;

use crate::http::{get_body, HttpClient};

const GITHUB_API_URL: &str = "https://api.github.com";
const GITHUB_RELEASE_TIMEOUT: Duration = Duration::from_secs(15);

/// The archive formats we can extract. There is no bare-gzip kind: a bare
/// `.gz` is in the rejected-suffix list
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
    RawBinary {
        file_name: String,
    },
}

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

/// Recognising a GitHub release
/// URL is what makes checksum recovery possible for registry entries that
/// published no `sha256`.
pub fn github_release_archive_from_url(archive_url: &str) -> Option<GithubReleaseArchive> {
    fn decode_path_segment(segment: &str) -> Option<String> {
        percent_decode_str(segment)
            .decode_utf8()
            .ok()
            .map(std::borrow::Cow::into_owned)
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
/// Best-effort by design: if the API is unreachable, rate-limited, or the asset
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
/// Registry ids and versions
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
/// The version goes in twice on
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

// Both prefixes must stay in sync with their creators —
// `versioned_archive_cache_dir` and `install_archive`'s staging directory — so
// the GC only ever removes directories that we created ourselves.
//
// The staging prefix is here rather than inlined at its one use because that
// is the whole bug it fixes: a staging directory is created by this crate, in
// the directory this GC scans, and was skipped by a filter whose stated
// purpose is to remove exactly what this crate created.
const VERSIONED_ARCHIVE_CACHE_DIR_PREFIX: &str = "v_";
const STAGING_DIR_PREFIX: &str = ".tmp-agent-download-";

/// Whether `name` is a directory this crate made, and may therefore collect.
fn is_ours(name: &str) -> bool {
    name.starts_with(VERSIONED_ARCHIVE_CACHE_DIR_PREFIX) || name.starts_with(STAGING_DIR_PREFIX)
}

/// Delete the install directories of versions we no longer run, and the
/// staging directories of downloads that never finished.
///
/// The mtime rule:
/// only directories *older* than the current one are removed, so a concurrent
/// extraction of a different version that finished after we looked survives.
///
/// Staging directories are collected under the same rule, and are here at all
/// because `TempDir`'s `Drop` covers every exit except the ones that matter —
/// SIGKILL, a force-quit, power loss. A download killed that way leaves however
/// much of the archive had arrived, under a dotted name the user will never
/// see, in the directory this function already walks.
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
        if entry_name == current_dir_name || !is_ours(&entry_name.to_string_lossy()) {
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

/// What an install is allowed to cost, before it is allowed to cost it.
///
/// The registry is third-party data (`lib.rs`, "Trust model"), so an entry can
/// name an asset that is enormous, or one that is small and expands to
/// something enormous. Neither is caught by the checksum — a hostile entry
/// publishes the digest of its own bad bytes and passes.
///
/// These are ceilings, not budgets: no real agent is near them, so tripping one
/// means the archive is wrong rather than merely large. Tuned so the largest
/// thing Atlas legitimately installs (the managed Node runtime, and the
/// hundred-megabyte vendor agents) clears them by more than an order of
/// magnitude.
///
/// Deliberately *not* a compression-ratio guard. A ratio test is the part of
/// this most likely to reject something real — an archive of mostly-zero
/// padding or plain text compresses far past any threshold worth setting — and
/// the absolute uncompressed ceiling already bounds the damage a bomb can do.
#[derive(Debug, Clone, Copy)]
pub struct InstallLimits {
    /// Bytes accepted off the wire before the download is abandoned.
    pub max_download_bytes: u64,
    /// Bytes an archive may expand to on disk.
    pub max_uncompressed_bytes: u64,
    /// Entries a zip may declare. Tar is a stream and cannot be counted
    /// without consuming it, so tar is bounded by bytes alone.
    pub max_entries: usize,
}

impl Default for InstallLimits {
    fn default() -> Self {
        Self {
            max_download_bytes: 2 * 1024 * 1024 * 1024,
            max_uncompressed_bytes: 4 * 1024 * 1024 * 1024,
            max_entries: 100_000,
        }
    }
}

/// Permission bits an extracted file is allowed to keep.
///
/// Strips setuid, setgid and sticky, and group/other write. Neither archive
/// crate does this for us: tar masks to `0o777` (so suid goes but `0o777`
/// stays), and zip applies `external_attributes >> 16` verbatim, suid included.
#[cfg(unix)]
const EXTRACTED_MODE_MASK: u32 = 0o755;

/// Download `url` into `destination_dir`, verifying `digest` if we have one.
///
/// The whole download lands in a staging directory beside the destination and
/// is renamed into place only once it has been verified and extracted, which is
/// what keeps a failed or mismatched download from replacing a working install
/// (`github_download.rs:43-129`).
///
/// The payload is always staged to a file, even when no checksum was
/// published: one code path is worth the temp file, and the verified path had
/// to stage anyway.
pub async fn install_archive(
    http: &dyn HttpClient,
    url: &str,
    digest: Option<&str>,
    destination_dir: &Path,
    kind: &RegistryArchiveKind,
) -> Result<()> {
    install_archive_with_limits(
        http,
        url,
        digest,
        destination_dir,
        kind,
        InstallLimits::default(),
    )
    .await
}

/// [`install_archive`], with the ceilings spelled out.
///
/// Exists so a test can drive the real install path against limits small enough
/// to reach. Production callers take [`InstallLimits::default`].
pub async fn install_archive_with_limits(
    http: &dyn HttpClient,
    url: &str,
    digest: Option<&str>,
    destination_dir: &Path,
    kind: &RegistryArchiveKind,
    limits: InstallLimits,
) -> Result<()> {
    let parent = destination_dir
        .parent()
        .context("destination path has no parent")?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("creating {parent:?}"))?;

    let staging = tempfile::Builder::new()
        .prefix(STAGING_DIR_PREFIX)
        .tempdir_in(parent)
        .with_context(|| format!("creating staging directory in {parent:?}"))?;

    let payload = staging.path().join("payload");
    let extracted = staging.path().join("extracted");
    tokio::fs::create_dir_all(&extracted).await?;

    let actual_digest = download_to_file(http, url, &payload, limits.max_download_bytes).await?;
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
            tokio::task::spawn_blocking(move || {
                extract(&payload, &destination, asset_kind, limits)
            })
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
///
/// Stops at `max_bytes`. The cap is on what actually arrives, not on
/// `Content-Length`: a header is a claim by the same server that sends the
/// body, so trusting it to decide whether to read the body is circular.
async fn download_to_file(
    http: &dyn HttpClient,
    url: &str,
    destination: &Path,
    max_bytes: u64,
) -> Result<String> {
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

    let mut received: u64 = 0;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.with_context(|| format!("reading {url}"))?;
        received = received.saturating_add(chunk.len() as u64);
        anyhow::ensure!(
            received <= max_bytes,
            "download of {url} passed {max_bytes} bytes and was abandoned",
        );
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .with_context(|| format!("writing {destination:?}"))?;
    }
    file.flush().await?;

    Ok(format!("{:x}", hasher.finalize()))
}

fn extract(
    payload: &Path,
    destination: &Path,
    kind: AssetKind,
    limits: InstallLimits,
) -> Result<()> {
    let file = std::fs::File::open(payload)?;
    match kind {
        AssetKind::Zip => {
            let mut archive = zip::ZipArchive::new(file)?;
            // A zip carries its own directory, so the cost is knowable before
            // a single byte is written. Tar cannot do this — see `unpack_tar`.
            check_zip_budget(&mut archive, limits)?;
            archive.extract(destination)?;
        }
        AssetKind::TarGz => {
            unpack_tar(flate2::read::GzDecoder::new(file), destination, limits)?;
        }
        AssetKind::TarBz2 => {
            unpack_tar(bzip2::read::BzDecoder::new(file), destination, limits)?;
        }
    }
    // Both extractors are done writing by here, so one pass fixes both formats
    // and does not depend on which bits either crate chose to honour.
    harden_extracted_tree(destination)?;
    Ok(())
}

/// Refuse a zip that expands past what we accept, before it costs any disk.
///
/// Measured, not read. The central directory carries an `uncompressed_size`
/// per entry, and it is tempting to sum those — but it is a claim by the
/// archive, and `ZipArchive::extract` never checks it against what the
/// decompressor actually produces (`zip-8.6.0/src/read.rs` bounds the *input*
/// by `compressed_size` and then `io::copy`s until the stream ends). Rewriting
/// four bytes of the central directory leaves the payload and its CRC intact
/// and walks straight through a ceiling that trusted that field. So this
/// decompresses each entry into a counter and believes the bytes.
///
/// That is a second decompression pass. At the size a real agent archive has
/// — around 100 MB against a 4 GiB ceiling — it is noise, and it buys keeping
/// `ZipArchive::extract` for the extraction itself, which is where the
/// zip-slip and symlink containment this crate inherits actually lives.
fn check_zip_budget<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    limits: InstallLimits,
) -> Result<()> {
    anyhow::ensure!(
        archive.len() <= limits.max_entries,
        "archive declares {} entries, past the {} this installer accepts",
        archive.len(),
        limits.max_entries,
    );

    let mut budget = ByteBudget {
        remaining: limits.max_uncompressed_bytes,
        overdrawn: false,
    };

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .with_context(|| format!("reading zip entry {index}"))?;
        let copied = std::io::copy(&mut entry, &mut budget);
        drop(entry);

        if let Err(error) = copied {
            // Tell a bomb apart from a corrupt stream: only the budget sets
            // `overdrawn`, so anything else is a genuine read failure and
            // deserves to say so.
            anyhow::ensure!(
                !budget.overdrawn,
                "archive expands to more than {} bytes, and was refused",
                limits.max_uncompressed_bytes,
            );
            return Err(anyhow::Error::new(error)
                .context(format!("reading zip entry {index} of {}", archive.len())));
        }
    }
    Ok(())
}

/// A sink that counts down, and fails the write that would overdraw it.
struct ByteBudget {
    remaining: u64,
    overdrawn: bool,
}

impl std::io::Write for ByteBudget {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.remaining.checked_sub(buf.len() as u64) {
            Some(left) => {
                self.remaining = left;
                Ok(buf.len())
            }
            None => {
                self.overdrawn = true;
                Err(std::io::Error::other("expansion budget exhausted"))
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn unpack_tar(reader: impl std::io::Read, destination: &Path, limits: InstallLimits) -> Result<()> {
    // A tar is a stream with no index, so unlike zip nothing can be checked up
    // front — both bounds fire mid-extraction. Bytes are bounded by wrapping
    // the decoder; entries are counted as they go, because bytes alone do not
    // bound them: a tar of empty files costs about 4.7 wire-bytes per inode,
    // so the byte ceiling on its own still permits millions of them.
    let mut archive = tar::Archive::new(LimitedReader::new(reader, limits.max_uncompressed_bytes));
    // Mtime preservation is off: it is
    // irrelevant to a downloaded archive, and some filesystems error when asked
    // to apply it after extraction.
    archive.set_preserve_mtime(false);

    std::fs::create_dir_all(destination).with_context(|| format!("creating {destination:?}"))?;

    let mut seen = 0usize;
    for entry in archive.entries().context("reading the tar index")? {
        let mut entry = entry.context("reading a tar entry")?;

        seen += 1;
        anyhow::ensure!(
            seen <= limits.max_entries,
            "archive holds more than {} entries, and was refused",
            limits.max_entries,
        );

        // `unpack_in` rather than a write of our own: it is what performs
        // tar's path containment — the `..` rejection, the absolute-path
        // strip, and the symlink and hardlink checks against the destination.
        // That guarantee belongs to the `tar` crate, and doing the write here
        // would quietly move it onto us.
        entry
            .unpack_in(destination)
            .context("unpacking a tar entry")?;
    }
    Ok(())
}

/// Fails the read once more than `limit` bytes have come through.
struct LimitedReader<R> {
    inner: R,
    limit: u64,
    read_so_far: u64,
}

impl<R> LimitedReader<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            limit,
            read_so_far: 0,
        }
    }
}

impl<R: std::io::Read> std::io::Read for LimitedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.read_so_far = self.read_so_far.saturating_add(read as u64);
        // Strictly greater: an archive whose size is exactly the limit is
        // within it, and must not be failed on its last byte.
        if self.read_so_far > self.limit {
            return Err(std::io::Error::other(format!(
                "archive expands to more than {} bytes, and was refused",
                self.limit
            )));
        }
        Ok(read)
    }
}

/// Mask every extracted file down to [`EXTRACTED_MODE_MASK`].
///
/// Runs after extraction rather than per entry because that is the one place
/// both formats have finished writing, so the result does not depend on which
/// bits `tar` and `zip` each decided to honour — a property that has changed
/// under them before and is pinned by tests rather than assumed.
///
/// Symlinks are skipped, not masked: `set_permissions` follows the link, so
/// chmod-ing one would change whatever it points at, which for an archive that
/// ships a link to somewhere outside the tree is exactly the write we are
/// trying to prevent.
#[cfg(unix)]
fn harden_extracted_tree(root: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        // Widen the directory to traversable before reading it. An archive may
        // ship a directory with no owner-execute bit, which would otherwise
        // make its own contents unreachable to this walk.
        let mode = std::fs::metadata(&dir)
            .with_context(|| format!("reading mode of {dir:?}"))?
            .permissions()
            .mode();
        std::fs::set_permissions(
            &dir,
            std::fs::Permissions::from_mode((mode & EXTRACTED_MODE_MASK) | 0o700),
        )
        .with_context(|| format!("hardening {dir:?}"))?;

        for entry in std::fs::read_dir(&dir).with_context(|| format!("reading {dir:?}"))? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            let mode = entry.metadata()?.permissions().mode();
            std::fs::set_permissions(
                &path,
                std::fs::Permissions::from_mode(mode & EXTRACTED_MODE_MASK),
            )
            .with_context(|| format!("hardening {path:?}"))?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_extracted_tree(_root: &Path) -> Result<()> {
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
