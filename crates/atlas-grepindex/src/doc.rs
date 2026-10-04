//! Which files the index can hold. Anything else is *forced*: always handed to the real matcher.

/// Larger files are not indexed (ripgrep still searches them; they are forced).
pub const MAX_INDEXED_BYTES: u64 = 2 * 1024 * 1024;
/// A line longer than this marks a minified or generated file (csearch's limit).
pub const MAX_LINE_BYTES: usize = 2000;
/// ripgrep's binary sniff window.
const BINARY_PROBE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unindexable {
    /// NUL byte in the first 8 KiB.
    Binary,
    /// UTF-16 byte-order mark: ripgrep transcodes these, so byte grams would not match.
    Utf16,
    TooLarge,
    LongLine,
}

impl Unindexable {
    /// Bit stored in `docs.bin` flags (alongside `format::FLAG_FORCED`).
    pub fn flag(self) -> u32 {
        match self {
            Unindexable::Binary => 1 << 1,
            Unindexable::Utf16 => 1 << 2,
            Unindexable::TooLarge => 1 << 3,
            Unindexable::LongLine => 1 << 4,
        }
    }
}

pub fn classify(bytes: &[u8]) -> Result<(), Unindexable> {
    if bytes.len() as u64 > MAX_INDEXED_BYTES {
        return Err(Unindexable::TooLarge);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(Unindexable::Utf16);
    }
    if bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0) {
        return Err(Unindexable::Binary);
    }
    if bytes
        .split(|&b| b == b'\n')
        .any(|line| line.len() > MAX_LINE_BYTES)
    {
        return Err(Unindexable::LongLine);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_each_rule() {
        assert_eq!(classify(b"fn main() {}\n"), Ok(()));
        assert_eq!(classify(b"ab\0cd"), Err(Unindexable::Binary));
        assert_eq!(classify(&[0xFF, 0xFE, b'a', 0]), Err(Unindexable::Utf16));
        assert_eq!(classify(&vec![b'a'; 2001]), Err(Unindexable::LongLine));
        assert_eq!(classify(&vec![b'a'; 2000]), Ok(()));
        let big = vec![b'\n'; MAX_INDEXED_BYTES as usize + 1];
        assert_eq!(classify(&big), Err(Unindexable::TooLarge));
    }

    #[test]
    fn nul_after_the_probe_window_is_indexable() {
        let mut bytes = vec![b'\n'; 9000];
        bytes.push(0);
        assert_eq!(classify(&bytes), Ok(()));
    }
}
