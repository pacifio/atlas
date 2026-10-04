//! On-disk snapshot, format v1. One directory per base tree:
//! `<root>/.atlas/code-index/grep/<tree-oid>/`.
//!
//! ```text
//! meta.bin      magic "ATLGREP\0" | format u32 | weight_table_id u64 | fold_id u32 | max_len u32
//!               | base_commit [20] | base_tree [20] | n_docs u32 | n_keys u64 | n_blocks u32
//!               | created_at_ms i64 | fnv1a64(all previous bytes) u64          (all LE, 100 bytes)
//! docs.bin      n_docs x 32 B { path_off u32, size u32, blob_oid [20], flags u32 }  doc id = row
//! paths.bin     front-coded sorted paths: uvarint shared | uvarint suffix_len | suffix;
//!               shared = 0 on every 16th record. path_off points at a doc's record.
//! grams.tbl     records | directory (n_blocks x 16 B) | footer
//!               record    = uvarint key_delta | uvarint (df << 1 | inline)
//!                           | inline ? uvarint doc : uvarint list_bytes
//!               key_delta is from the previous key in the block (0 for the block's first key);
//!               a non-inline list starts where the block's previous list ended, beginning at
//!               the block's post_off. Blocks hold at most 256 keys.
//!               directory = { first_key u32, rec_off u32, post_off u64 }
//!               footer    = rec_len u64 | n_blocks u32 | magic "AGT1"
//! postings.bin  concatenated lists of uvarint doc-id deltas (first delta is from 0)
//! forced.bin    ascending u32 LE doc ids that must always be verified
//! ```
//!
//! Only the directory, docs and paths are resident; records and lists are read with positioned
//! reads (never memory-mapped).

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

use crate::error::Error;
use crate::gram::{weight_table_id, FOLD_ID, MAX_GRAM_LEN};
use crate::varint;

pub const FORMAT_VERSION: u32 = 1;
pub const BLOCK_KEYS: usize = 256;
/// `docs.bin` flag: always a candidate (see [`crate::doc::Unindexable`] for the reason bits).
pub const FLAG_FORCED: u32 = 1;
const META_MAGIC: &[u8; 8] = b"ATLGREP\0";
const META_LEN: usize = 100;
const TBL_MAGIC: &[u8; 4] = b"AGT1";
const DOC_ROW: usize = 32;
const PATH_RESTART: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Meta {
    pub format_version: u32,
    pub weight_table_id: u64,
    pub fold_id: u32,
    pub max_len: u32,
    pub base_commit: [u8; 20],
    pub base_tree: [u8; 20],
    pub n_docs: u32,
    pub n_keys: u64,
    pub n_blocks: u32,
    pub created_at_ms: i64,
}

impl Meta {
    /// Header for a snapshot built by this binary's gram scheme.
    pub fn current(base_commit: [u8; 20], base_tree: [u8; 20]) -> Meta {
        Meta {
            format_version: FORMAT_VERSION,
            weight_table_id: weight_table_id(),
            fold_id: FOLD_ID,
            max_len: MAX_GRAM_LEN as u32,
            base_commit,
            base_tree,
            n_docs: 0,
            n_keys: 0,
            n_blocks: 0,
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX)),
        }
    }

    /// False when the snapshot was built with another gram scheme and must be rebuilt.
    pub fn is_current_scheme(&self) -> bool {
        self.format_version == FORMAT_VERSION
            && self.weight_table_id == weight_table_id()
            && self.fold_id == FOLD_ID
            && self.max_len == MAX_GRAM_LEN as u32
    }

    fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(META_LEN);
        b.extend_from_slice(META_MAGIC);
        b.extend_from_slice(&self.format_version.to_le_bytes());
        b.extend_from_slice(&self.weight_table_id.to_le_bytes());
        b.extend_from_slice(&self.fold_id.to_le_bytes());
        b.extend_from_slice(&self.max_len.to_le_bytes());
        b.extend_from_slice(&self.base_commit);
        b.extend_from_slice(&self.base_tree);
        b.extend_from_slice(&self.n_docs.to_le_bytes());
        b.extend_from_slice(&self.n_keys.to_le_bytes());
        b.extend_from_slice(&self.n_blocks.to_le_bytes());
        b.extend_from_slice(&self.created_at_ms.to_le_bytes());
        let sum = crate::gram::fnv1a64(&b);
        b.extend_from_slice(&sum.to_le_bytes());
        debug_assert_eq!(b.len(), META_LEN);
        b
    }

    fn decode(b: &[u8]) -> Result<Meta, Error> {
        if b.len() != META_LEN || &b[..8] != META_MAGIC {
            return Err(Error::Corrupt("meta.bin header"));
        }
        if crate::gram::fnv1a64(&b[..META_LEN - 8]) != u64_at(b, META_LEN - 8) {
            return Err(Error::Corrupt("meta.bin checksum"));
        }
        let mut base_commit = [0u8; 20];
        base_commit.copy_from_slice(&b[28..48]);
        let mut base_tree = [0u8; 20];
        base_tree.copy_from_slice(&b[48..68]);
        Ok(Meta {
            format_version: u32_at(b, 8),
            weight_table_id: u64_at(b, 12),
            fold_id: u32_at(b, 20),
            max_len: u32_at(b, 24),
            base_commit,
            base_tree,
            n_docs: u32_at(b, 68),
            n_keys: u64_at(b, 72),
            n_blocks: u32_at(b, 80),
            created_at_ms: u64_at(b, 84) as i64,
        })
    }
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(a)
}

/// One base document. `path` is `/`-separated and relative to the work-tree root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocRow {
    pub path: String,
    pub size: u64,
    pub blob: [u8; 20],
    pub flags: u32,
}

impl DocRow {
    pub fn is_forced(&self) -> bool {
        self.flags & FLAG_FORCED != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirEntry {
    first_key: u32,
    rec_off: u32,
    post_off: u64,
}

/// Streams posting lists, in strictly ascending key order, into `grams.tbl` + `postings.bin`.
pub struct PostingsWriter {
    tbl: BufWriter<File>,
    post: BufWriter<File>,
    dir: Vec<DirEntry>,
    rec_off: u64,
    post_off: u64,
    prev_key: u32,
    n_keys: u64,
    rec: Vec<u8>,
    list: Vec<u8>,
}

impl PostingsWriter {
    pub fn create(dir: &Path) -> Result<PostingsWriter, Error> {
        Ok(PostingsWriter {
            tbl: BufWriter::new(File::create(dir.join("grams.tbl"))?),
            post: BufWriter::new(File::create(dir.join("postings.bin"))?),
            dir: Vec::new(),
            rec_off: 0,
            post_off: 0,
            prev_key: 0,
            n_keys: 0,
            rec: Vec::new(),
            list: Vec::new(),
        })
    }

    /// `docs` must be non-empty and strictly ascending; `key` above every key added before.
    pub fn add(&mut self, key: u32, docs: &[u32]) -> Result<(), Error> {
        debug_assert!(!docs.is_empty());
        debug_assert!(self.n_keys == 0 || key > self.prev_key);
        self.rec.clear();
        let delta = if self.n_keys.is_multiple_of(BLOCK_KEYS as u64) {
            let rec_off = u32::try_from(self.rec_off).map_err(|_| Error::TooLarge)?;
            self.dir.push(DirEntry {
                first_key: key,
                rec_off,
                post_off: self.post_off,
            });
            0
        } else {
            key - self.prev_key
        };
        varint::put(&mut self.rec, u64::from(delta));
        let df = docs.len() as u64;
        if docs.len() == 1 {
            varint::put(&mut self.rec, (df << 1) | 1);
            varint::put(&mut self.rec, u64::from(docs[0]));
        } else {
            self.list.clear();
            let mut prev = 0u32;
            for &d in docs {
                varint::put(&mut self.list, u64::from(d - prev));
                prev = d;
            }
            varint::put(&mut self.rec, df << 1);
            varint::put(&mut self.rec, self.list.len() as u64);
            self.post.write_all(&self.list)?;
            self.post_off += self.list.len() as u64;
        }
        self.tbl.write_all(&self.rec)?;
        self.rec_off += self.rec.len() as u64;
        self.prev_key = key;
        self.n_keys += 1;
        Ok(())
    }

    /// Appends the directory and footer, flushes and fsyncs. Returns `(n_keys, n_blocks)`.
    pub fn finish(mut self) -> Result<(u64, u32), Error> {
        for d in &self.dir {
            self.tbl.write_all(&d.first_key.to_le_bytes())?;
            self.tbl.write_all(&d.rec_off.to_le_bytes())?;
            self.tbl.write_all(&d.post_off.to_le_bytes())?;
        }
        let n_blocks = u32::try_from(self.dir.len()).map_err(|_| Error::TooLarge)?;
        self.tbl.write_all(&self.rec_off.to_le_bytes())?;
        self.tbl.write_all(&n_blocks.to_le_bytes())?;
        self.tbl.write_all(TBL_MAGIC)?;
        let tbl = self
            .tbl
            .into_inner()
            .map_err(io::IntoInnerError::into_error)?;
        tbl.sync_all()?;
        let post = self
            .post
            .into_inner()
            .map_err(io::IntoInnerError::into_error)?;
        post.sync_all()?;
        Ok((self.n_keys, n_blocks))
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut f = File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

/// Writes `docs.bin`, `paths.bin`, `forced.bin` and finally `meta.bin`. `docs` must be sorted
/// by path; `meta`'s counts are filled in here.
pub fn write_docs_and_meta(
    dir: &Path,
    docs: &[DocRow],
    mut meta: Meta,
    n_keys: u64,
    n_blocks: u32,
) -> Result<(), Error> {
    let mut paths = Vec::new();
    let mut rows = Vec::with_capacity(docs.len() * DOC_ROW);
    let mut forced = Vec::new();
    let mut prev: &[u8] = &[];
    for (i, d) in docs.iter().enumerate() {
        let path_off = u32::try_from(paths.len()).map_err(|_| Error::TooLarge)?;
        let cur = d.path.as_bytes();
        let shared = if i.is_multiple_of(PATH_RESTART) {
            0
        } else {
            prev.iter().zip(cur).take_while(|(a, b)| a == b).count()
        };
        varint::put(&mut paths, shared as u64);
        varint::put(&mut paths, (cur.len() - shared) as u64);
        paths.extend_from_slice(&cur[shared..]);
        prev = cur;
        rows.extend_from_slice(&path_off.to_le_bytes());
        rows.extend_from_slice(&u32::try_from(d.size).unwrap_or(u32::MAX).to_le_bytes());
        rows.extend_from_slice(&d.blob);
        rows.extend_from_slice(&d.flags.to_le_bytes());
        if d.is_forced() {
            forced.extend_from_slice(&(i as u32).to_le_bytes());
        }
    }
    write_synced(&dir.join("paths.bin"), &paths)?;
    write_synced(&dir.join("docs.bin"), &rows)?;
    write_synced(&dir.join("forced.bin"), &forced)?;
    meta.n_docs = u32::try_from(docs.len()).map_err(|_| Error::TooLarge)?;
    meta.n_keys = n_keys;
    meta.n_blocks = n_blocks;
    write_synced(&dir.join("meta.bin"), &meta.encode())
}

/// Where a key's documents live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Posting {
    Inline(u32),
    List { df: u32, off: u64, len: u32 },
}

impl Posting {
    pub fn df(&self) -> u32 {
        match self {
            Posting::Inline(_) => 1,
            Posting::List { df, .. } => *df,
        }
    }
}

/// A loaded snapshot.
#[derive(Debug)]
pub struct BaseIndex {
    meta: Meta,
    docs: Vec<DocRow>,
    forced: Vec<u32>,
    directory: Vec<DirEntry>,
    rec_len: u64,
    tbl: File,
    post: File,
}

impl BaseIndex {
    pub fn open(dir: &Path) -> Result<BaseIndex, Error> {
        let meta = Meta::decode(&std::fs::read(dir.join("meta.bin"))?)?;
        let n = meta.n_docs as usize;
        let rows = std::fs::read(dir.join("docs.bin"))?;
        if rows.len() != n * DOC_ROW {
            return Err(Error::Corrupt("docs.bin length"));
        }
        let paths = std::fs::read(dir.join("paths.bin"))?;
        let mut docs = Vec::with_capacity(n);
        let (mut pos, mut prev) = (0usize, Vec::<u8>::new());
        for i in 0..n {
            let row = &rows[i * DOC_ROW..(i + 1) * DOC_ROW];
            if u32_at(row, 0) as usize != pos {
                return Err(Error::Corrupt("docs.bin path offset"));
            }
            let shared = varint::get(&paths, &mut pos).ok_or(Error::Corrupt("paths.bin"))? as usize;
            let len = varint::get(&paths, &mut pos).ok_or(Error::Corrupt("paths.bin"))? as usize;
            let suffix = paths
                .get(pos..pos + len)
                .ok_or(Error::Corrupt("paths.bin"))?;
            pos += len;
            let mut cur = prev
                .get(..shared)
                .ok_or(Error::Corrupt("paths.bin"))?
                .to_vec();
            cur.extend_from_slice(suffix);
            let mut blob = [0u8; 20];
            blob.copy_from_slice(&row[8..28]);
            docs.push(DocRow {
                path: String::from_utf8(cur.clone())
                    .map_err(|_| Error::Corrupt("paths.bin utf-8"))?,
                size: u64::from(u32_at(row, 4)),
                blob,
                flags: u32_at(row, 28),
            });
            prev = cur;
        }
        let forced_bytes = std::fs::read(dir.join("forced.bin"))?;
        let forced: Vec<u32> = forced_bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| u32::from_le_bytes(*c))
            .collect();
        if forced_bytes.len() % 4 != 0 || forced.iter().any(|&d| d as usize >= n) {
            return Err(Error::Corrupt("forced.bin"));
        }
        let tbl = File::open(dir.join("grams.tbl"))?;
        let tbl_len = tbl.metadata()?.len();
        if tbl_len < 16 {
            return Err(Error::Corrupt("grams.tbl footer"));
        }
        let mut footer = [0u8; 16];
        read_at(&tbl, &mut footer, tbl_len - 16)?;
        let rec_len = u64_at(&footer, 0);
        let n_blocks = u32_at(&footer, 8);
        if &footer[12..] != TBL_MAGIC
            || n_blocks != meta.n_blocks
            || rec_len + u64::from(n_blocks) * 16 + 16 != tbl_len
        {
            return Err(Error::Corrupt("grams.tbl footer"));
        }
        let mut raw = vec![0u8; n_blocks as usize * 16];
        read_at(&tbl, &mut raw, rec_len)?;
        let directory = raw
            .as_chunks::<16>()
            .0
            .iter()
            .map(|c| DirEntry {
                first_key: u32_at(c, 0),
                rec_off: u32_at(c, 4),
                post_off: u64_at(c, 8),
            })
            .collect();
        let post = File::open(dir.join("postings.bin"))?;
        Ok(BaseIndex {
            meta,
            docs,
            forced,
            directory,
            rec_len,
            tbl,
            post,
        })
    }

    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    pub fn n_docs(&self) -> u32 {
        self.docs.len() as u32
    }

    pub fn doc(&self, id: u32) -> &DocRow {
        &self.docs[id as usize]
    }

    /// Doc id of a `/`-separated work-tree-relative path.
    pub fn doc_id(&self, path: &str) -> Option<u32> {
        self.docs
            .binary_search_by(|d| d.path.as_str().cmp(path))
            .ok()
            .map(|i| i as u32)
    }

    pub fn forced(&self) -> &[u32] {
        &self.forced
    }

    pub fn lookup(&self, key: u32) -> Result<Option<Posting>, Error> {
        let i = self.directory.partition_point(|d| d.first_key <= key);
        if i == 0 {
            return Ok(None);
        }
        let block = self.directory[i - 1];
        let end = self
            .directory
            .get(i)
            .map_or(self.rec_len, |next| u64::from(next.rec_off));
        let mut buf = vec![0u8; (end - u64::from(block.rec_off)) as usize];
        read_at(&self.tbl, &mut buf, u64::from(block.rec_off))?;
        let (mut pos, mut k, mut post_off) = (0usize, block.first_key, block.post_off);
        while pos < buf.len() {
            let delta = u32::try_from(record_int(&buf, &mut pos)?).map_err(|_| CORRUPT_RECORD)?;
            k = k.checked_add(delta).ok_or(CORRUPT_RECORD)?;
            let tag = record_int(&buf, &mut pos)?;
            let posting = if tag & 1 == 1 {
                Posting::Inline(record_int(&buf, &mut pos)? as u32)
            } else {
                let len = record_int(&buf, &mut pos)?;
                let p = Posting::List {
                    df: (tag >> 1) as u32,
                    off: post_off,
                    len: len as u32,
                };
                post_off += len;
                p
            };
            if k == key {
                return Ok(Some(posting));
            }
            if k > key {
                return Ok(None);
            }
        }
        Ok(None)
    }

    /// Ascending doc ids of a posting.
    pub fn docs_of(&self, posting: Posting) -> Result<Vec<u32>, Error> {
        match posting {
            Posting::Inline(doc) => Ok(vec![doc]),
            Posting::List { df, off, len } => {
                let mut buf = vec![0u8; len as usize];
                read_at(&self.post, &mut buf, off)?;
                let mut out = Vec::with_capacity(df as usize);
                let (mut pos, mut doc) = (0usize, 0u64);
                while pos < buf.len() {
                    doc += varint::get(&buf, &mut pos).ok_or(Error::Corrupt("postings.bin"))?;
                    out.push(doc as u32);
                }
                Ok(out)
            }
        }
    }
}

const CORRUPT_RECORD: Error = Error::Corrupt("grams.tbl record");

fn record_int(buf: &[u8], pos: &mut usize) -> Result<u64, Error> {
    varint::get(buf, pos).ok_or(CORRUPT_RECORD)
}

fn read_at(file: &File, buf: &mut [u8], off: u64) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(buf, off)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = file.seek_read(&mut buf[done..], off + done as u64)?;
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            done += n;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::BTreeMap;

    fn write_snapshot(dir: &Path, docs: &[DocRow], lists: &BTreeMap<u32, Vec<u32>>) {
        let mut w = PostingsWriter::create(dir).unwrap();
        for (&k, v) in lists {
            w.add(k, v).unwrap();
        }
        let (n_keys, n_blocks) = w.finish().unwrap();
        write_docs_and_meta(dir, docs, Meta::current([1; 20], [2; 20]), n_keys, n_blocks).unwrap();
    }

    fn docs(n: u32) -> Vec<DocRow> {
        (0..n)
            .map(|i| DocRow {
                path: format!("src/dir{}/file{i:05}.rs", i % 3),
                size: u64::from(i) * 10,
                blob: [i as u8; 20],
                flags: if i.is_multiple_of(7) { FLAG_FORCED } else { 0 },
            })
            .collect::<Vec<_>>()
    }

    #[test]
    fn meta_round_trips_and_rejects_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let mut d = docs(40);
        d.sort_by(|a, b| a.path.cmp(&b.path));
        write_snapshot(dir.path(), &d, &BTreeMap::from([(5, vec![1, 2])]));
        let idx = BaseIndex::open(dir.path()).unwrap();
        assert_eq!(idx.meta().n_docs, 40);
        assert_eq!(idx.meta().base_tree, [2; 20]);
        assert!(idx.meta().is_current_scheme());
        let mut raw = std::fs::read(dir.path().join("meta.bin")).unwrap();
        raw[30] ^= 1;
        std::fs::write(dir.path().join("meta.bin"), raw).unwrap();
        assert!(matches!(
            BaseIndex::open(dir.path()),
            Err(Error::Corrupt(_))
        ));
    }

    #[test]
    fn docs_and_paths_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut d = docs(100);
        d.sort_by(|a, b| a.path.cmp(&b.path));
        write_snapshot(dir.path(), &d, &BTreeMap::new());
        let idx = BaseIndex::open(dir.path()).unwrap();
        for (i, row) in d.iter().enumerate() {
            assert_eq!(idx.doc(i as u32), row);
            assert_eq!(idx.doc_id(&row.path), Some(i as u32));
        }
        assert_eq!(idx.doc_id("src/nope.rs"), None);
        let forced: Vec<u32> = d
            .iter()
            .enumerate()
            .filter(|(_, r)| r.is_forced())
            .map(|(i, _)| i as u32)
            .collect();
        assert_eq!(idx.forced(), &forced[..]);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]

        #[test]
        fn postings_round_trip(lists in prop::collection::btree_map(
            any::<u32>(),
            prop::collection::btree_set(0u32..5000, 1..40),
            0..1500,
        ), probes in prop::collection::vec(any::<u32>(), 50)) {
            let dir = tempfile::tempdir().unwrap();
            let lists: BTreeMap<u32, Vec<u32>> =
                lists.into_iter().map(|(k, s)| (k, s.into_iter().collect())).collect();
            let mut d = docs(5000);
            d.sort_by(|a, b| a.path.cmp(&b.path));
            write_snapshot(dir.path(), &d, &lists);
            let idx = BaseIndex::open(dir.path()).unwrap();
            for (&k, v) in &lists {
                let p = idx.lookup(k).unwrap().expect("present key");
                prop_assert_eq!(p.df() as usize, v.len());
                prop_assert_eq!(&idx.docs_of(p).unwrap(), v);
            }
            for k in probes {
                prop_assert_eq!(idx.lookup(k).unwrap().is_some(), lists.contains_key(&k));
            }
        }
    }
}
