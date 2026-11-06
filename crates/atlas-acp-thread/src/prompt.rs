//! Prompt content — what one turn actually carries.
//!
//! Every layer from the Tauri command down to `session/prompt` carries
//! `Vec<ContentBlock>` rather than a bare `String`. Before this seam existed,
//! images had to bypass it through a staging side-channel drained by the *next*
//! send, so a staged set that never got drained silently rode a later turn.
//! Carrying content with the turn removes that class of bug entirely.
//!
//! Built against schema 1.5. It lives beside the thread because `ContentBlock` is the
//! thread's own vocabulary, and both the external stdio connection and the
//! native agent need these conversions:
//!
//! - [`compose`] / [`from_text`] / [`with_resource_links`] /
//!   [`with_pasted_texts`] — build the blocks on the way down.
//! - [`strip_unsupported`] — the capability backstop.
//! - [`flatten_text`] — collapse them back to a string for the native agent,
//!   which has no multimodal input path.

use agent_client_protocol::schema::v1::{
    ContentBlock, EmbeddedResource, EmbeddedResourceResource, ImageContent, ResourceLink,
    TextContent, TextResourceContents,
};

/// One image the composer attached to a turn: raw base64 `data` plus its MIME
/// type. Lives here rather than with the agent catalog because it is part of
/// the turn seam, and [`compose`] is the only thing that reads it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub mime_type: String,
    /// Raw base64 payload — no `data:` URI prefix.
    pub data_base64: String,
}

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
    content.extend(
        images
            .into_iter()
            .map(|att| ContentBlock::Image(ImageContent::new(att.data_base64, att.mime_type))),
    );
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

/// Text the user pasted that was too large to sit in the composer
/// (`isLargePaste`): it rode as a chip, and its whole text goes with the turn.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PastedText {
    /// The chip's id — the `@paste:<id>` token in the prose names it.
    pub id: String,
    pub text: String,
}

/// The URI an embedded paste carries. Not a file: there is nothing on disk
/// for the agent to open, which is why a paste never rides as a resource link.
#[must_use]
pub fn paste_uri(id: &str) -> String {
    format!("atlas://paste/{id}")
}

/// A paste as a plain text block: a header naming it, then the text in a
/// fence the text itself cannot close.
#[must_use]
pub fn paste_as_text(paste: &PastedText) -> String {
    let lines = paste.text.lines().count().max(1);
    let mut longest = 0;
    let mut run = 0;
    for c in paste.text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat((longest + 1).max(3));
    let noun = if lines == 1 { "line" } else { "lines" };
    format!(
        "Pasted text (@paste:{}, {lines} {noun}):\n{fence}\n{}\n{fence}",
        paste.id, paste.text
    )
}

/// Append the turn's large pastes, every one in full whatever the agent can
/// take.
///
/// ACP only guarantees `Text` and `ResourceLink`. An agent that advertised
/// `promptCapabilities.embeddedContext` gets each paste as an embedded text
/// resource, which it can tell apart from the user's prose; any other agent
/// gets it as a text block (`paste_as_text`). Never a resource link: the paste
/// is not a file the agent could read.
#[must_use]
pub fn with_pasted_texts(
    mut content: Vec<ContentBlock>,
    pastes: Vec<PastedText>,
    embedded_context: bool,
) -> Vec<ContentBlock> {
    content.extend(pastes.into_iter().map(|paste| {
        if embedded_context {
            ContentBlock::Resource(EmbeddedResource::new(
                EmbeddedResourceResource::TextResourceContents(
                    TextResourceContents::new(paste.text, paste_uri(&paste.id))
                        .mime_type("text/plain".to_string()),
                ),
            ))
        } else {
            ContentBlock::Text(TextContent::new(paste_as_text(&paste)))
        }
    }));
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
        assert_eq!(
            with_resource_links(from_text("hi"), Vec::new()),
            from_text("hi")
        );
    }

    /// Every agent MUST accept ResourceLink, so the capability filter must
    /// never strip one even for an agent that advertised nothing at all.
    #[test]
    fn resource_links_survive_an_agent_that_advertises_nothing() {
        let content = with_resource_links(
            from_text("hi"),
            vec![ResourceLinkSpec {
                uri: "file:///a".into(),
                name: "a".into(),
            }],
        );
        assert_eq!(strip_unsupported(content.clone(), false), content);
    }

    fn paste(text: &str) -> PastedText {
        PastedText {
            id: "p1".into(),
            text: text.into(),
        }
    }

    #[test]
    fn a_paste_is_an_embedded_resource_for_an_agent_that_takes_embedded_context() {
        let content = with_pasted_texts(from_text("see this"), vec![paste("a\nb")], true);
        assert_eq!(content.len(), 2);
        assert!(matches!(&content[0], ContentBlock::Text(t) if t.text == "see this"));
        let ContentBlock::Resource(res) = &content[1] else {
            panic!("expected an embedded resource");
        };
        let EmbeddedResourceResource::TextResourceContents(t) = &res.resource else {
            panic!("expected text contents");
        };
        assert_eq!(t.uri, "atlas://paste/p1");
        assert_eq!(t.mime_type.as_deref(), Some("text/plain"));
        assert_eq!(t.text, "a\nb");
    }

    #[test]
    fn a_paste_is_fenced_text_for_an_agent_without_embedded_context() {
        let content = with_pasted_texts(from_text("see this"), vec![paste("a\nb")], false);
        assert_eq!(content.len(), 2);
        let ContentBlock::Text(t) = &content[1] else {
            panic!("expected a text block");
        };
        assert_eq!(t.text, "Pasted text (@paste:p1, 2 lines):\n```\na\nb\n```");
        // Text and ResourceLink are the baseline; nothing here needs a capability.
        assert_eq!(strip_unsupported(content.clone(), false), content);
    }

    #[test]
    fn the_fence_outlasts_any_backticks_in_the_paste() {
        let text = paste_as_text(&paste("```rust\nfn main() {}\n```"));
        assert!(text.contains("\n````\n```rust"), "{text}");
        assert!(text.ends_with("```\n````"), "{text}");
    }

    #[test]
    fn neither_form_ever_drops_a_byte_of_the_paste() {
        let body = "x".repeat(10_000);
        for embedded in [true, false] {
            let content = with_pasted_texts(Vec::new(), vec![paste(&body)], embedded);
            assert!(flatten_text(&content).contains(&body));
        }
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
