use crate::codec::{cache_key, from_f16, slug, to_f16, vkey};
use crate::rrf::Fusion;
use crate::vectors::{Opened, VectorFile};

#[test]
fn cache_keys_separate_models_and_texts() {
    assert_ne!(cache_key("a", "x"), cache_key("b", "x"));
    assert_ne!(cache_key("a", "x"), cache_key("a", "y"));
    // The 0 separator: ("ab","c") and ("a","bc") differ.
    assert_ne!(cache_key("ab", "c"), cache_key("a", "bc"));
}

#[test]
fn f16_roundtrip_is_close_and_vkey_is_non_negative() {
    let v = vec![0.5f32, -0.25, 0.125, 1.0];
    let back = from_f16(&to_f16(&v));
    assert!(v.iter().zip(&back).all(|(a, b)| (a - b).abs() < 1e-3));
    assert!(vkey(&[0xFF; 32]) >= 0);
    assert_eq!(slug("nomic-ai/CodeRankEmbed"), "nomic-ai-coderankembed");
}

#[test]
fn a_vector_file_saves_atomically_and_reloads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v.usearch");
    let (f, opened) = VectorFile::open(path.clone(), 3).unwrap();
    assert_eq!(opened, Opened::Fresh);
    f.add(7, &[1.0, 0.0, 0.0]).unwrap();
    f.add(9, &[0.0, 1.0, 0.0]).unwrap();
    f.save().unwrap();
    assert!(!dir.path().join("v.usearch.tmp").exists());
    let (g, opened) = VectorFile::open(path, 3).unwrap();
    assert_eq!(opened, Opened::Loaded);
    assert!(g.contains(7) && g.contains(9));
    assert_eq!(g.search(&[1.0, 0.0, 0.0], 1)[0].0, 7);
}

/// usearch's own path API fails under non-ASCII folders on Windows; the file
/// I/O is Rust's, so any folder name works.
#[test]
fn a_vector_file_round_trips_under_a_non_ascii_folder() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Zoë проект").join("v.usearch");
    let (f, _) = VectorFile::open(path.clone(), 3).unwrap();
    f.add(7, &[1.0, 0.0, 0.0]).unwrap();
    f.save().unwrap();
    let (g, opened) = VectorFile::open(path, 3).unwrap();
    assert_eq!(opened, Opened::Loaded);
    assert!(g.contains(7));
}

#[test]
fn a_corrupt_or_wrong_dimension_file_opens_empty_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v.usearch");
    std::fs::write(&path, b"garbage").unwrap();
    let (f, opened) = VectorFile::open(path.clone(), 3).unwrap();
    assert_eq!(opened, Opened::Reset);
    assert_eq!(f.len(), 0);
    f.add(1, &[1.0, 0.0, 0.0]).unwrap();
    f.save().unwrap();
    let (_, opened) = VectorFile::open(path, 4).unwrap();
    assert_eq!(opened, Opened::Reset, "another dimension is not this file");
}

#[test]
fn fusion_adds_legs_priors_boost_only_present_ids_and_ties_break_by_id() {
    let mut f = Fusion::new();
    f.leg("bm25", 1.0, ["b", "a"]);
    f.leg("dense", 1.0, ["a", "c"]);
    f.prior("recent", 0.5, ["z", "c"]); // z is not a candidate: ignored
    let out = f.finish();
    let ids: Vec<&str> = out.iter().map(|h| h.id).collect();
    assert_eq!(ids[0], "a", "two legs beat one");
    assert!(!ids.contains(&"z"));
    assert_eq!(out[0].legs, vec![("bm25", 2), ("dense", 1)]);
    let mut tie = Fusion::new();
    tie.leg("x", 1.0, ["q"]);
    tie.leg("y", 1.0, ["p"]);
    assert_eq!(
        tie.finish().iter().map(|h| h.id).collect::<Vec<_>>(),
        vec!["p", "q"]
    );
}
