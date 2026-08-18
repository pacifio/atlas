//! `ImageView` — hand the model a picture (tool spec D10).
//!
//! There was no image tool at all, so a user could not show the agent a
//! screenshot of a broken layout; they could only describe it.
//!
//! Two design points worth stating:
//!
//! * **Gated on the model, not on the call.** The tool is absent from the
//!   registry when the selected model cannot accept images, so the failure
//!   happens at model selection rather than three turns into a debugging
//!   session. See [`super::tiers`].
//! * **Validation is by container header, not by full decode.** A full decode
//!   would additionally catch a *corrupt* image, which the provider rejects
//!   anyway — and it would cost an image-decoding crate and its dependency
//!   tree for a validity check. Header validation rejects the case that
//!   actually happens: a model passing a `.rs` file, or a `.png` that is really
//!   HTML.
//!
//! Errors are returned to the model, never propagated as a turn failure: a
//! wrong path is something the model can correct on the next call.

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{abs_path, coerce, errors};

/// Providers cap image payloads well below this; refusing early gives the model
/// a message it can act on rather than a provider error it cannot.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

const DESCRIPTION: &str = "Loads an image file and shows it to you. Use it when the user \
attaches or points at a screenshot, a mockup, a diagram, or a rendered page.\n\n\
- file_path is absolute or relative to the project root.\n\
- Supported: PNG, JPEG, GIF, WebP. Up to 5 MB.\n\
- Anything that is not really an image is rejected with an explanation.";

#[derive(Deserialize)]
struct Input {
    file_path: String,
}

/// The MIME type for `bytes`, determined from its container header.
///
/// Extensions are not consulted: a `.png` that is really HTML must be caught,
/// and a correct image with a wrong extension should still work.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.starts_with(PNG) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Standard base64, hand-rolled: the alternative is a dependency for forty
/// lines, and this is the only place in the crate that needs it.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub struct ImageViewTool;

#[async_trait]
impl Tool for ImageViewTool {
    fn name(&self) -> &str {
        "ImageView"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::FileSystem
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Path to the image (absolute, or relative to the project root)" }
            },
            "required": ["file_path"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "ImageView",
                    &e.to_string(),
                    r#"{"file_path": "screenshots/broken.png"}"#,
                ))
            }
        };

        let path = abs_path(&ctx.working_dir, &input.file_path);
        let display = path.to_string_lossy().into_owned();

        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(e) => return ToolResult::error(format!("Could not open {display}: {e}")),
        };
        if meta.is_dir() {
            return ToolResult::error(format!("{display} is a directory, not an image."));
        }
        if meta.len() > MAX_IMAGE_BYTES {
            return ToolResult::error(format!(
                "{display} is {} bytes, over the {MAX_IMAGE_BYTES}-byte limit. Resize or crop it \
                 first.",
                meta.len()
            ));
        }

        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) => return ToolResult::error(format!("Could not read {display}: {e}")),
        };
        let Some(media_type) = sniff(&bytes) else {
            return ToolResult::error(format!(
                "{display} is not a PNG, JPEG, GIF, or WebP image — its contents do not match any \
                 of those formats. If you meant to read it as text, use Read."
            ));
        };

        // Logged by size only. The bytes themselves must never reach a log.
        tracing::debug!(
            target: "atlas::tool_call",
            tool = "ImageView",
            bytes = bytes.len(),
            media_type,
            "image loaded"
        );

        ToolResult::success(format!(
            "{display} ({media_type}, {} bytes) is shown above.",
            bytes.len()
        ))
        .with_metadata(serde_json::json!({
            "image": { "media_type": media_type, "data": base64(&bytes) }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};
    use serde_json::json;

    /// The smallest valid PNG: an 1×1 transparent pixel.
    fn tiny_png() -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        v.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
        v.extend_from_slice(&[0x1F, 0x15, 0xC4, 0x89]);
        v
    }

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        ImageViewTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn an_image_is_returned_as_image_content() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("shot.png"), tiny_png()).unwrap();
        let r = run(tmp.path(), json!({"file_path": "shot.png"})).await;
        assert!(!r.is_error, "{}", r.content);
        let meta = r.metadata.expect("image payload");
        assert_eq!(meta["image"]["media_type"], "image/png");
        assert!(!meta["image"]["data"].as_str().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_non_image_is_rejected_with_a_correctable_message() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "fn main() {}").unwrap();
        let r = run(tmp.path(), json!({"file_path": "a.rs"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("not a PNG"), "{}", r.content);
        assert!(r.content.contains("use Read"), "{}", r.content);
    }

    #[tokio::test]
    async fn an_extension_lie_is_caught() {
        // A `.png` that is really HTML — the case an extension check misses.
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("fake.png"), "<html>gotcha</html>").unwrap();
        let r = run(tmp.path(), json!({"file_path": "fake.png"})).await;
        assert!(r.is_error, "{}", r.content);
    }

    #[tokio::test]
    async fn a_missing_file_is_an_error_the_model_can_fix() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), json!({"file_path": "nope.png"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("Could not open"));
    }

    #[tokio::test]
    async fn an_oversized_image_is_refused_before_the_provider_sees_it() {
        let tmp = TmpDir::new();
        let mut big = tiny_png();
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        std::fs::write(tmp.path().join("big.png"), big).unwrap();
        let r = run(tmp.path(), json!({"file_path": "big.png"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("limit"), "{}", r.content);
    }

    #[test]
    fn sniffs_the_four_supported_formats() {
        assert_eq!(sniff(&tiny_png()), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a....."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF____WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"not an image"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn base64_matches_the_standard_encoding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // Bytes above 0x7F must not be mangled.
        assert_eq!(base64(&[0xFF, 0xFE, 0xFD]), "//79");
    }
}
