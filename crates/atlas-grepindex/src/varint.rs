//! LEB128 unsigned varints, the integer encoding of every index file.

pub fn put(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

/// Decodes one varint at `*pos`, advancing it; `None` on truncation or overflow.
pub fn get(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *buf.get(*pos)?;
        *pos += 1;
        if shift > 63 {
            return None;
        }
        v |= u64::from(byte & 0x7F) << shift;
        if byte < 0x80 {
            return Some(v);
        }
        shift += 7;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn round_trips(values in prop::collection::vec(any::<u64>(), 0..64)) {
            let mut buf = Vec::new();
            for &v in &values {
                put(&mut buf, v);
            }
            let mut pos = 0;
            for &v in &values {
                prop_assert_eq!(get(&buf, &mut pos), Some(v));
            }
            prop_assert_eq!(pos, buf.len());
        }
    }

    #[test]
    fn truncated_input_is_none() {
        let mut buf = Vec::new();
        put(&mut buf, 300);
        let mut pos = 0;
        assert_eq!(get(&buf[..1], &mut pos), None);
    }
}
