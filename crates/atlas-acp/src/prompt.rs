//! Prompt content — the widened turn seam (P0.2, `plans/atlas-acp-parity-loop.md`).
//!
//! Every layer from the Tauri command down to `session/prompt` now carries
//! `Vec<ContentBlock>` instead of a bare `String`. Before this, the seam was
//! `text: String` end-to-end and images had to bypass it through a
//! `stage_attachments` side-channel: a `DashMap<SessionId, Vec<ImageAttachment>>`
//! written by one Tauri call and drained by the next `send_prompt`. That coupling
//! was invisible in the type system and had a real failure mode — a staged set
//! that never got drained (send rejected, session torn down between the two
//! calls) silently rode the *next* turn instead. Carrying content with the turn
//! removes the staleness class entirely.
//!
//! This module holds the two conversions every layer needs, so neither is
//! reimplemented per call site:
//!
//! - [`compose`] / [`from_text`] — build the blocks on the way down.
//! - [`flatten_text`] — collapse them back to a string for the native (Cersei)
//!   agent, which has no multimodal input path.
//!
//! P2.1 adds `ResourceLink` / embedded `Resource` blocks for @-mentions;
//! [`flatten_text`] already handles both so the native path keeps working when
//! they arrive.

use agent_client_protocol::schema::v1::{
    ContentBlock, EmbeddedResourceResource, ImageContent, ResourceLink, TextContent,
};

use crate::registry::ImageAttachment;

/// A prompt that is nothing but text — the shape of almost every turn.
#[must_use]
pub fn from_text(text: impl Into<String>) -> Vec<ContentBlock> {
    vec![ContentBlock::Text(TextContent::new(text.into()))]
}

/// Build one turn's content from the user's text plus any image attachments the
/// composer sent with it.
///
/// The text block always comes first: Claude Code only resolves a slash command
/// (skills included) when it sits at byte 0 of the first text block, so leading
/// with an image would demote `/skill-name` to prose. Image blocks are *not*
/// capability-filtered here — that check belongs to the ACP registry, which is
/// the only layer that knows what the agent advertised at initialize.
#[must_use]
pub fn compose(text: impl Into<String>, images: Vec<ImageAttachment>) -> Vec<ContentBlock> {
    let mut content = from_text(text);
    content.extend(images.into_iter().map(|att| {
        ContentBlock::Image(ImageContent::new(att.data_base64, att.mime_type))
    }));
    content
}

/// One `@`-mention that points at a file or directory (P2.1).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLinkSpec {
    pub uri: String,
    pub name: String,
}

/// Append `ResourceLink` blocks for the turn's `@`-mentions.
///
/// ACP requires EVERY agent to support `ResourceLink`, so unlike images there
/// is no capability to gate on — this is the baseline way to hand an agent a
/// file. It replaces flattening the path into prose ("File at `/x/y`. Use your
/// filesystem tools to read it."), which the agent had to parse back out of a
/// sentence. Paired with P1.3, an agent can now resolve the link through
/// `fs/read_text_file` without touching the disk itself.
///
/// Links come AFTER the text block, since the prose is what the turn is about
/// and a slash command must still sit at byte 0 of the first block.
#[must_use]
pub fn with_resource_links(
    mut content: Vec<ContentBlock>,
    links: Vec<ResourceLinkSpec>,
) -> Vec<ContentBlock> {
    content.extend(
        links
            .into_iter()
            .map(|l| ContentBlock::ResourceLink(ResourceLink::new(l.name, l.uri))),
    );
    content
}

/// Strip content blocks the agent never said it could accept.
///
/// ACP requires every agent to support `Text` and `ResourceLink`; `Image` rides
/// only on `promptCapabilities.image`. Sending an unsupported block anyway
/// violates the spec, so those are dropped rather than raised — a pasted
/// screenshot must not fail the whole turn. The composer already degrades images
/// to path mentions when `prompt_image_supported` reads false, so this is the
/// backstop, not the primary gate.
#[must_use]
pub fn strip_unsupported(content: Vec<ContentBlock>, image_supported: bool) -> Vec<ContentBlock> {
    if image_supported {
        return content;
    }
    let before = content.len();
    let kept: Vec<ContentBlock> = content
        .into_iter()
        .filter(|b| !matches!(b, ContentBlock::Image(_)))
        .collect();
    if kept.len() != before {
        tracing::debug!(
            count = before - kept.len(),
            "dropping image blocks — agent did not advertise promptCapabilities.image"
        );
    }
    kept
}

/// Collapse content blocks back into a single string.
///
/// Used by the native agent's backend, which takes text only. Text-bearing
/// blocks are joined with blank lines; binary blocks (image/audio, and the blob
/// form of an embedded resource) have no text projection and are dropped rather
/// than rendered as a placeholder — the frontend already degrades images to path
/// mentions for agents whose `prompt_image_supported()` reads false, so anything
/// binary reaching here is genuinely unrepresentable.
#[must_use]
pub fn flatten_text(content: &[ContentBlock]) -> String {
    let parts: Vec<&str> = content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(t) => Some(t.text.as_str()),
            // An @-mention the agent is expected to open itself (P2.1). The URI
            // is the only useful projection — it is what the user typed.
            ContentBlock::ResourceLink(link) => Some(link.uri.as_str()),
            // Embedded context: the text form carries the file contents inline.
            ContentBlock::Resource(res) => match &res.resource {
                EmbeddedResourceResource::TextResourceContents(t) => Some(t.text.as_str()),
                // Also `#[non_exhaustive]`; a blob has no text projection and
                // neither does anything a later schema adds.
                _ => None,
            },
            ContentBlock::Image(_) | ContentBlock::Audio(_) => None,
            // `ContentBlock` is `#[non_exhaustive]`; a block type added by a
            // future schema bump has no known text projection.
            _ => None,
        })
        .collect();
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(data: &str) -> ImageAttachment {
        ImageAttachment {
            data_base64: data.to_string(),
            mime_type: "image/png".to_string(),
        }
    }

    #[test]
    fn a_plain_turn_is_exactly_one_text_block() {
        let content = from_text("hello");
        assert_eq!(content.len(), 1);
        assert_eq!(flatten_text(&content), "hello");
    }

    #[test]
    fn compose_puts_text_first_so_slash_commands_still_resolve() {
        let content = compose("/review", vec![att("aaa"), att("bbb")]);
        assert_eq!(content.len(), 3);
        assert!(
            matches!(&content[0], ContentBlock::Text(t) if t.text == "/review"),
            "text must lead: Claude Code only resolves a slash command at byte 0"
        );
        assert!(matches!(content[1], ContentBlock::Image(_)));
        assert!(matches!(content[2], ContentBlock::Image(_)));
    }

    #[test]
    fn compose_without_images_matches_from_text() {
        assert_eq!(compose("hi", Vec::new()), from_text("hi"));
    }

    #[test]
    fn flatten_drops_blocks_with_no_text_projection() {
        let content = compose("look at this", vec![att("aaa")]);
        assert_eq!(
            flatten_text(&content),
            "look at this",
            "the native agent takes text only; the image has no projection"
        );
    }

    #[test]
    fn flatten_joins_multiple_text_blocks_with_a_blank_line() {
        let content = vec![
            ContentBlock::Text(TextContent::new("one".to_string())),
            ContentBlock::Text(TextContent::new("two".to_string())),
        ];
        assert_eq!(flatten_text(&content), "one\n\ntwo");
    }

    #[test]
    fn strip_removes_images_when_the_agent_lacks_the_capability() {
        let content = compose("look", vec![att("aaa"), att("bbb")]);
        let kept = strip_unsupported(content, false);
        assert_eq!(kept.len(), 1, "only the text block survives");
        assert!(matches!(&kept[0], ContentBlock::Text(t) if t.text == "look"));
    }

    #[test]
    fn strip_is_a_passthrough_when_the_agent_advertised_image() {
        let content = compose("look", vec![att("aaa")]);
        assert_eq!(strip_unsupported(content.clone(), true), content);
    }

    /// Text and ResourceLink are mandatory for every ACP agent — the filter must
    /// never touch them, whatever the image capability says.
    #[test]
    fn strip_never_drops_the_mandatory_block_types() {
        use agent_client_protocol::schema::v1::ResourceLink;
        let content = vec![
            ContentBlock::Text(TextContent::new("hi".to_string())),
            ContentBlock::ResourceLink(ResourceLink::new("a.rs", "file:///a.rs")),
        ];
        assert_eq!(strip_unsupported(content.clone(), false), content);
    }

    #[test]
    fn resource_links_ride_after_the_text_block() {
        let content = with_resource_links(
            from_text("explain this"),
            vec![ResourceLinkSpec {
                uri: "file:///repo/src/main.rs".into(),
                name: "main.rs".into(),
            }],
        );
        assert_eq!(content.len(), 2);
        assert!(
            matches!(&content[0], ContentBlock::Text(t) if t.text == "explain this"),
            "text still leads, or a slash command stops resolving"
        );
        let ContentBlock::ResourceLink(link) = &content[1] else {
            panic!("expected a resource link");
        };
        assert_eq!(link.uri, "file:///repo/src/main.rs");
        assert_eq!(link.name, "main.rs");
    }

    #[test]
    fn no_links_leaves_the_content_untouched() {
        assert_eq!(with_resource_links(from_text("hi"), Vec::new()), from_text("hi"));
    }

    /// Every agent MUST accept ResourceLink, so the capability filter must
    /// never strip one even for an agent that advertised nothing at all.
    #[test]
    fn resource_links_survive_an_agent_that_advertises_nothing() {
        let content = with_resource_links(
            from_text("hi"),
            vec![ResourceLinkSpec { uri: "file:///a".into(), name: "a".into() }],
        );
        assert_eq!(strip_unsupported(content.clone(), false), content);
    }

    /// P2.1 lands `ResourceLink` blocks for @-mentions; the native agent's
    /// backend must not silently lose them when it does.
    #[test]
    fn flatten_projects_a_resource_link_to_its_uri() {
        use agent_client_protocol::schema::v1::ResourceLink;
        let content = vec![
            ContentBlock::Text(TextContent::new("explain".to_string())),
            ContentBlock::ResourceLink(ResourceLink::new("src/main.rs", "file:///src/main.rs")),
        ];
        assert_eq!(flatten_text(&content), "explain\n\nfile:///src/main.rs");
    }
}
