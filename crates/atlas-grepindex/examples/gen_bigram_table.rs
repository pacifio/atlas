//! Generates `data/bigram_rank_v1.bin`, the bigram weight table `gram.rs` embeds.
//!
//! Usage: `cargo run -p atlas-grepindex --example gen_bigram_table --release -- <out.bin> <dir>...`
//!
//! Every non-ignored file under each `<dir>` that is at most 2 MiB and has no NUL byte in its
//! first 8 KiB is ASCII-lowercased (the index's fold) and its byte pairs counted. Only pairs
//! whose bytes are both < 128 are counted. The pairs are ranked by count descending, ties broken
//! by the pair key `a * 128 + b` ascending, so the output is a pure function of the counts. The
//! file is 128 * 128 little-endian `u16` ranks in key order (32 768 bytes): the rank of `(a, b)`
//! is at offset `2 * (a * 128 + b)`. Rank 0 is the most frequent pair.
//!
//! The table is versioned by content: `gram::weight_table_id()` is the FNV-1a hash of these
//! bytes and is stored in every index header, so regenerating the table invalidates (and
//! rebuilds) every existing index. Never edit the file by hand.

use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (out, dirs) = args
        .split_first()
        .expect("usage: gen_bigram_table <out.bin> <dir>...");
    assert!(
        !dirs.is_empty(),
        "usage: gen_bigram_table <out.bin> <dir>..."
    );
    let mut counts = vec![0u64; 128 * 128];
    let (mut files, mut bytes) = (0u64, 0u64);
    for dir in dirs {
        for entry in ignore::WalkBuilder::new(dir)
            .parents(false)
            .build()
            .flatten()
        {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(file) = std::fs::File::open(entry.path()) else {
                continue;
            };
            let mut data = Vec::new();
            if file
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut data)
                .is_err()
                || data.len() > 2 * 1024 * 1024
                || data[..data.len().min(8192)].contains(&0)
            {
                continue;
            }
            data.make_ascii_lowercase();
            for pair in data.windows(2) {
                if pair[0] < 128 && pair[1] < 128 {
                    counts[usize::from(pair[0]) * 128 + usize::from(pair[1])] += 1;
                }
            }
            files += 1;
            bytes += data.len() as u64;
        }
    }
    let mut order: Vec<usize> = (0..counts.len()).collect();
    order.sort_by(|&a, &b| counts[b].cmp(&counts[a]).then(a.cmp(&b)));
    let mut ranks = vec![0u16; counts.len()];
    for (rank, &key) in order.iter().enumerate() {
        ranks[key] = u16::try_from(rank).expect("16384 ranks fit in u16");
    }
    let mut table = Vec::with_capacity(ranks.len() * 2);
    for rank in ranks {
        table.extend_from_slice(&rank.to_le_bytes());
    }
    std::fs::write(out, &table).expect("write table");
    let top: Vec<String> = order[..10]
        .iter()
        .map(|&k| {
            format!(
                "{:?}",
                String::from_utf8_lossy(&[(k / 128) as u8, (k % 128) as u8])
            )
        })
        .collect();
    println!("{files} files, {bytes} bytes; top pairs: {}", top.join(" "));
}
