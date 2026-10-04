//! Builds a base snapshot from the HEAD tree: list blobs with gix, extract gram keys in
//! parallel, sort `(key, doc)` pairs into runs on disk, merge the runs into the posting files,
//! then rename the finished directory into place.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use atlas_search::CancelToken;
use gix::ObjectId;
use rayon::prelude::*;

use crate::doc::{classify, Unindexable, MAX_INDEXED_BYTES};
use crate::error::{git_err, Error};
use crate::format::{write_docs_and_meta, DocRow, Meta, PostingsWriter, FLAG_FORCED};
use crate::gram::doc_keys;

/// Source bytes per extraction batch; one sorted run file per batch.
const BATCH_BYTES: u64 = 16 * 1024 * 1024;

/// A blob of the HEAD tree.
#[derive(Debug, Clone)]
pub struct TreeFile {
    pub path: String,
    pub oid: ObjectId,
    pub size: u64,
}

/// `(commit, tree)` of HEAD.
pub fn head(repo: &gix::Repository) -> Result<(ObjectId, ObjectId), Error> {
    let commit = repo.head_id().map_err(|_| Error::NoHead)?.detach();
    let tree = repo.head_tree_id().map_err(|_| Error::NoHead)?.detach();
    Ok((commit, tree))
}

/// Every regular or executable blob under `tree`, sorted by `/`-separated path. Symlinks,
/// submodules and non-UTF-8 paths are left out; the index does not know them, so `grep`
/// always searches them.
pub fn list_tree(repo: &gix::Repository, tree: ObjectId) -> Result<Vec<TreeFile>, Error> {
    let mut out = Vec::new();
    let mut stack = vec![(tree, String::new())];
    while let Some((oid, prefix)) = stack.pop() {
        let tree = repo.find_tree(oid).map_err(git_err)?;
        for entry in tree.iter() {
            let entry = entry.map_err(git_err)?;
            let Ok(name) = std::str::from_utf8(entry.inner.filename.as_ref()) else {
                continue;
            };
            let path = if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}/{name}")
            };
            let oid = entry.inner.oid.to_owned();
            if entry.inner.mode.is_tree() {
                stack.push((oid, path));
            } else if entry.inner.mode.is_blob() {
                let size = repo.find_header(oid).map_err(git_err)?.size();
                out.push(TreeFile { path, oid, size });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub fn oid20(oid: &ObjectId) -> [u8; 20] {
    let mut out = [0u8; 20];
    out.copy_from_slice(&oid.as_bytes()[..20]);
    out
}

/// Builds `<grep_dir>/<tree>/` and returns its path. Never leaves a partial directory there.
pub fn build_snapshot(
    root: &Path,
    files: &[TreeFile],
    commit: ObjectId,
    tree: ObjectId,
    grep_dir: &Path,
    cancel: &CancelToken,
) -> Result<PathBuf, Error> {
    fs::create_dir_all(grep_dir)?;
    let final_dir = grep_dir.join(tree.to_string());
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = grep_dir.join(format!(".tmp-{tree}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&tmp)?;
    if let Err(e) = build_into(root, files, commit, tree, &tmp, cancel) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    match fs::rename(&tmp, &final_dir) {
        Ok(()) => {}
        // Another Atlas process finished the same tree first; keep its copy.
        Err(_) if final_dir.join("meta.bin").exists() => {
            let _ = fs::remove_dir_all(&tmp);
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(e.into());
        }
    }
    #[cfg(unix)]
    File::open(grep_dir)?.sync_all()?;
    Ok(final_dir)
}

fn build_into(
    root: &Path,
    files: &[TreeFile],
    commit: ObjectId,
    tree: ObjectId,
    tmp: &Path,
    cancel: &CancelToken,
) -> Result<(), Error> {
    let too_large = FLAG_FORCED | Unindexable::TooLarge.flag();
    let mut docs: Vec<DocRow> = files
        .iter()
        .map(|f| DocRow {
            path: f.path.clone(),
            size: f.size,
            blob: oid20(&f.oid),
            flags: if f.size > MAX_INDEXED_BYTES {
                too_large
            } else {
                0
            },
        })
        .collect();
    let mut runs = Vec::new();
    let mut start = 0;
    while start < docs.len() {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let (mut end, mut bytes) = (start, 0u64);
        while end < docs.len() && (end == start || bytes + docs[end].size <= BATCH_BYTES) {
            if !docs[end].is_forced() {
                bytes += docs[end].size;
            }
            end += 1;
        }
        let extracted: Vec<(usize, Result<Vec<u32>, Unindexable>)> = (start..end)
            .into_par_iter()
            .filter(|&i| !docs[i].is_forced())
            // gix repositories are not `Sync` without gix's `parallel` feature, so each rayon
            // worker opens its own handle.
            .map_init(
                || gix::open(root),
                |repo, i| -> Result<_, Error> {
                    let repo = repo.as_ref().map_err(git_err)?;
                    let data = repo.find_blob(files[i].oid).map_err(git_err)?.take_data();
                    Ok((i, classify(&data).map(|()| doc_keys(&data))))
                },
            )
            .collect::<Result<_, Error>>()?;
        let mut pairs = Vec::new();
        for (i, outcome) in extracted {
            match outcome {
                Ok(keys) => pairs.extend(keys.into_iter().map(|k| (u64::from(k) << 32) | i as u64)),
                Err(why) => docs[i].flags |= FLAG_FORCED | why.flag(),
            }
        }
        if !pairs.is_empty() {
            pairs.par_sort_unstable();
            let path = tmp.join(format!("run-{}.bin", runs.len()));
            let mut w = BufWriter::new(File::create(&path)?);
            for p in &pairs {
                w.write_all(&p.to_le_bytes())?;
            }
            w.flush()?;
            runs.push(path);
        }
        start = end;
    }
    let mut writer = PostingsWriter::create(tmp)?;
    merge_runs(&runs, cancel, |key, ids| writer.add(key, ids))?;
    for run in &runs {
        fs::remove_file(run)?;
    }
    let (n_keys, n_blocks) = writer.finish()?;
    write_docs_and_meta(
        tmp,
        &docs,
        Meta::current(oid20(&commit), oid20(&tree)),
        n_keys,
        n_blocks,
    )
}

/// k-way merge of sorted `(key << 32 | doc)` run files; calls `sink` once per key with its
/// ascending doc ids.
fn merge_runs(
    runs: &[PathBuf],
    cancel: &CancelToken,
    mut sink: impl FnMut(u32, &[u32]) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut readers = runs
        .iter()
        .map(|p| File::open(p).map(|f| BufReader::with_capacity(1 << 16, f)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut heap = BinaryHeap::new();
    for (i, r) in readers.iter_mut().enumerate() {
        if let Some(v) = next_pair(r)? {
            heap.push(Reverse((v, i)));
        }
    }
    let (mut current, mut docs, mut seen) = (None, Vec::new(), 0u64);
    while let Some(Reverse((v, i))) = heap.pop() {
        let (key, doc) = ((v >> 32) as u32, v as u32);
        if current != Some(key) {
            if let Some(k) = current {
                sink(k, &docs)?;
            }
            docs.clear();
            current = Some(key);
        }
        docs.push(doc);
        if let Some(next) = next_pair(&mut readers[i])? {
            heap.push(Reverse((next, i)));
        }
        seen += 1;
        if seen.is_multiple_of(1 << 20) && cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
    }
    if let Some(k) = current {
        sink(k, &docs)?;
    }
    Ok(())
}

fn next_pair(r: &mut BufReader<File>) -> Result<Option<u64>, Error> {
    let mut b = [0u8; 8];
    match r.read_exact(&mut b) {
        Ok(()) => Ok(Some(u64::from_le_bytes(b))),
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Removes snapshots of other trees and abandoned temp dirs (older than an hour). Best effort.
pub fn remove_stale_snapshots(grep_dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(grep_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let old_tmp = name.starts_with(".tmp-")
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| m.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(3600));
        let other_tree =
            name != keep && name.len() == 40 && name.bytes().all(|b| b.is_ascii_hexdigit());
        if old_tmp || other_tree {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}
