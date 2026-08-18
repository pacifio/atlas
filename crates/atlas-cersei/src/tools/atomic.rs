//! Atomic file writes (tool spec D4).
//!
//! Every tool that writes a file writes to a temporary file in the *same
//! directory* and renames over the target. Same directory matters: `rename` is
//! only atomic within a filesystem, and a temp directory is frequently on a
//! different one.
//!
//! What this buys: a crash, a kill, or a full disk part-way through a write can
//! no longer leave a half-written source file. Either the old contents are
//! there or the new ones are — never a truncated mixture. Direct writes to a
//! target path are prohibited in this crate.

use std::path::{Path, PathBuf};

/// Write `contents` to `path`, atomically.
///
/// Creates the parent directory if needed, preserves the target's existing
/// permissions when it has some, and removes the temporary file on any failure
/// so a failed write leaves nothing behind.
pub async fn write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    tokio::fs::create_dir_all(parent).await?;

    let tmp = temp_sibling(path);
    // Scope the write so the handle is closed (and flushed) before the rename.
    if let Err(e) = write_and_sync(&tmp, contents).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }

    // Carry the original file's mode over: a rename replaces the inode, so
    // without this an executable script silently loses its executable bit.
    #[cfg(unix)]
    if let Ok(meta) = tokio::fs::metadata(path).await {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode)).await;
    }

    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

async fn write_and_sync(tmp: &Path, contents: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(tmp).await?;
    file.write_all(contents).await?;
    // Without the flush to disk, the rename can be durable while the data is
    // not, which reintroduces the truncation this module exists to prevent.
    file.sync_all().await?;
    Ok(())
}

/// A hidden sibling of `path`, so the temp file shares its filesystem and does
/// not show up in a directory listing mid-write.
fn temp_sibling(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    parent.join(format!(".{name}.atlas-{}.tmp", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::TmpDir;

    #[tokio::test]
    async fn writes_contents() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.txt");
        write(&f, b"hello").await.unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "hello");
    }

    #[tokio::test]
    async fn creates_missing_parents() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("deep/nested/a.txt");
        write(&f, b"x").await.unwrap();
        assert!(f.exists());
    }

    #[tokio::test]
    async fn leaves_no_temp_files_behind() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.txt");
        write(&f, b"one").await.unwrap();
        write(&f, b"two").await.unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".atlas-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[tokio::test]
    async fn a_failed_write_leaves_the_original_intact() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.txt");
        std::fs::write(&f, "original").unwrap();
        // Renaming over a directory fails, which exercises the cleanup path
        // without needing to simulate a crash.
        let dir = tmp.path().join("d");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("keep"), "x").unwrap();
        assert!(write(&dir, b"clobber").await.is_err());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "original");
        assert!(dir.join("keep").exists(), "the directory was not replaced");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preserves_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TmpDir::new();
        let f = tmp.path().join("run.sh");
        std::fs::write(&f, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        write(&f, b"#!/bin/sh\necho hi\n").await.unwrap();
        let mode = std::fs::metadata(&f).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "a rename must not drop the exec bit");
    }

    #[tokio::test]
    async fn the_target_is_never_observed_partially_written() {
        // The rename is the only moment the target changes, so a reader either
        // sees the old bytes or the new ones — never a prefix of the new.
        let tmp = TmpDir::new();
        let f = tmp.path().join("big.txt");
        std::fs::write(&f, "old").unwrap();
        let big = "n".repeat(4 * 1024 * 1024);
        let reader = {
            let f = f.clone();
            tokio::spawn(async move {
                let mut seen = Vec::new();
                for _ in 0..200 {
                    if let Ok(s) = std::fs::read_to_string(&f) {
                        seen.push(s.len());
                    }
                    tokio::task::yield_now().await;
                }
                seen
            })
        };
        write(&f, big.as_bytes()).await.unwrap();
        let seen = reader.await.unwrap();
        for len in seen {
            assert!(
                len == 3 || len == big.len(),
                "observed a partial file of {len} bytes"
            );
        }
    }
}
