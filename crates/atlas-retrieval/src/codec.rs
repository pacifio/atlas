//! How a cached embedding is keyed and stored. Keys are content-addressed
//! per model, so a vector can never describe text it was not computed
//! from, and switching back to an earlier model finds its vectors again.

/// `blake3(model_id ‖ 0 ‖ text)`.
pub fn cache_key(model_id: &str, text: &str) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(model_id.as_bytes());
    h.update(&[0]);
    h.update(text.as_bytes());
    *h.finalize().as_bytes()
}

/// Little-endian f16, two bytes per dimension.
pub fn to_f16(v: &[f32]) -> Vec<u8> {
    v.iter()
        .flat_map(|x| half::f16::from_f32(*x).to_le_bytes())
        .collect()
}

pub fn from_f16(b: &[u8]) -> Vec<f32> {
    b.as_chunks::<2>()
        .0
        .iter()
        .map(|c| half::f16::from_le_bytes(*c).to_f32())
        .collect()
}

/// A usearch key from a 32-byte hash: its first 8 bytes, non-negative.
pub fn vkey(hash: &[u8; 32]) -> i64 {
    (u64::from_le_bytes(hash[..8].try_into().expect("8 bytes")) & (i64::MAX as u64)) as i64
}

/// A file-name-safe, lower-case form of a model id.
pub fn slug(model_id: &str) -> String {
    model_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}
