//! The REST half of the API.
//!
//! Every call goes through Rust because only Rust holds the Bearer — there is
//! no renderer-side fetch to the chat host, ever. Every route names its
//! Organisation explicitly with `?org=`, rather than having one inferred from
//! the token, so a person who belongs to several is always explicit about which
//! they are acting in.
//!
//! A token is minted per call. It lives ten minutes and nothing here holds one
//! for longer than a request, so expiry never arises.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{CommsError, Result};
use crate::wire::{Attachment, Conversation, Message, Pin, ReactionRow, ReadState};
use crate::TokenSource;

pub struct RestClient {
    http: reqwest::Client,
    base: String,
    tokens: Arc<dyn TokenSource>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConversationList {
    #[serde(default)]
    pub conversations: Vec<Conversation>,
    #[serde(default)]
    pub discoverable: Vec<Conversation>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessagePage {
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub has_more: bool,
    /// Rows for the messages on this page. Present because a reloading client
    /// cold-syncs: without folding these in, every reaction chip vanishes on
    /// refresh.
    #[serde(default)]
    pub reactions: Vec<ReactionRow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PinList {
    #[serde(default)]
    pub pins: Vec<Pin>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReadList {
    #[serde(default)]
    pub reads: Vec<ReadState>,
}

/// Where to send the parts. There is no per-part URL and no signature — each
/// part is `PUT` to the worker with the caller's ordinary bearer.
#[derive(Debug, Clone, Deserialize)]
pub struct UploadIntent {
    pub file_id: String,
    /// Every part but the last must be **exactly** this many bytes.
    pub part_bytes: u64,
    /// How many parts the declared size works out to.
    pub parts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadedPart {
    pub part_number: u32,
    pub etag: String,
}

/// A DM create answers `200` for one that already existed and `201` for a new
/// one. That status is the only way to tell "I opened your DM" from "I made
/// one", so it is carried rather than discarded.
#[derive(Debug, Clone)]
pub struct DmResult {
    pub conversation: Conversation,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ConversationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_ref_ids: Option<Vec<String>>,
}

impl RestClient {
    pub fn new(base: String, tokens: Arc<dyn TokenSource>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base,
            tokens,
        }
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        org: &str,
        body: Option<serde_json::Value>,
    ) -> Result<reqwest::Response> {
        let token = self.tokens.mint().await?;
        let sep = if path.contains('?') { '&' } else { '?' };
        let url = format!("{}{path}{sep}org={org}", self.base);
        let mut req = self
            .http
            .request(method, url)
            .bearer_auth(token)
            .timeout(std::time::Duration::from_secs(20));
        if let Some(json) = body {
            req = req.json(&json);
        }
        let res = req.send().await?;
        Ok(res)
    }

    /// Turn a non-2xx into the shared error vocabulary.
    ///
    /// `404` is deliberately not disambiguated: a private channel, a DM, a
    /// conversation we were removed from and an id that was never real all
    /// answer identically, and a client that tried to tell them apart would be
    /// reconstructing exactly the enumeration the server refuses to allow.
    async fn check(res: reqwest::Response) -> Result<reqwest::Response> {
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CommsError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(CommsError::NotFound);
        }
        // Structured refusals carry the detail the UI has to render —
        // `group_dm_frozen`'s `fork_hint`, `quota_exceeded`'s byte counts.
        #[derive(Deserialize)]
        struct Envelope {
            error: Inner,
        }
        #[derive(Deserialize)]
        struct Inner {
            code: String,
            #[serde(default)]
            message: String,
            #[serde(default)]
            detail: Option<serde_json::Value>,
        }
        match res.json::<Envelope>().await {
            Ok(env) => Err(CommsError::Refused {
                code: env.error.code,
                message: env.error.message,
                detail: env.error.detail,
            }),
            Err(_) => Err(CommsError::Transport(format!("HTTP {status}"))),
        }
    }

    async fn json<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        org: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T> {
        let res = Self::check(self.request(method, path, org, body).await?).await?;
        Ok(res.json::<T>().await?)
    }

    pub async fn conversations(&self, org: &str) -> Result<ConversationList> {
        self.json(reqwest::Method::GET, "/conversations", org, None)
            .await
    }

    pub async fn reads(&self, org: &str) -> Result<ReadList> {
        self.json(reqwest::Method::GET, "/reads", org, None).await
    }

    /// Pages backwards. Within a page messages are **oldest-first**, so a
    /// caller appends rather than reverses.
    pub async fn messages(
        &self,
        org: &str,
        conv_id: &str,
        before: Option<i64>,
        limit: u32,
    ) -> Result<MessagePage> {
        let mut path = format!("/conversations/{conv_id}/messages?limit={limit}");
        if let Some(before) = before {
            path.push_str(&format!("&before={before}"));
        }
        self.json(reqwest::Method::GET, &path, org, None).await
    }

    /// Newest-first — the opposite of history paging, deliberately.
    pub async fn search(
        &self,
        org: &str,
        q: &str,
        conv_id: Option<&str>,
        before: Option<i64>,
    ) -> Result<MessagePage> {
        let mut path = format!("/search?q={}", urlencode(q));
        if let Some(c) = conv_id {
            path.push_str(&format!("&conv_id={c}"));
        }
        if let Some(b) = before {
            path.push_str(&format!("&before={b}"));
        }
        self.json(reqwest::Method::GET, &path, org, None).await
    }

    pub async fn pins(&self, org: &str, conv_id: &str) -> Result<PinList> {
        self.json(
            reqwest::Method::GET,
            &format!("/conversations/{conv_id}/pins"),
            org,
            None,
        )
        .await
    }

    pub async fn create_channel(
        &self,
        org: &str,
        name: &str,
        visibility: Option<&str>,
        workspace_ref_ids: Vec<String>,
    ) -> Result<Conversation> {
        let mut body = serde_json::json!({ "kind": "channel", "name": name });
        if let Some(v) = visibility {
            body["visibility"] = serde_json::json!(v);
        }
        if !workspace_ref_ids.is_empty() {
            body["workspace_ref_ids"] = serde_json::json!(workspace_ref_ids);
        }
        #[derive(Deserialize)]
        struct Wrapper {
            conversation: Conversation,
        }
        let w: Wrapper = self
            .json(reqwest::Method::POST, "/conversations", org, Some(body))
            .await?;
        Ok(w.conversation)
    }

    pub async fn create_dm(&self, org: &str, user_id: &str) -> Result<DmResult> {
        let body = serde_json::json!({ "kind": "dm", "user_id": user_id });
        let res = Self::check(
            self.request(reqwest::Method::POST, "/conversations", org, Some(body))
                .await?,
        )
        .await?;
        let created = res.status() == reqwest::StatusCode::CREATED;
        #[derive(Deserialize)]
        struct Wrapper {
            conversation: Conversation,
        }
        let w: Wrapper = res.json().await?;
        Ok(DmResult {
            conversation: w.conversation,
            created,
        })
    }

    /// Not idempotent, and that is the feature: membership is frozen, so
    /// "add somebody" is a *new* group with no history.
    pub async fn create_group_dm(&self, org: &str, member_ids: Vec<String>) -> Result<Conversation> {
        let body = serde_json::json!({ "kind": "group_dm", "member_ids": member_ids });
        #[derive(Deserialize)]
        struct Wrapper {
            conversation: Conversation,
        }
        let w: Wrapper = self
            .json(reqwest::Method::POST, "/conversations", org, Some(body))
            .await?;
        Ok(w.conversation)
    }

    /// Self-serve, `public_org` only. A private channel answers `404`, so no
    /// join affordance should be offered for one.
    pub async fn join(&self, org: &str, conv_id: &str) -> Result<Conversation> {
        #[derive(Deserialize)]
        struct Wrapper {
            conversation: Conversation,
        }
        let w: Wrapper = self
            .json(
                reqwest::Method::POST,
                &format!("/conversations/{conv_id}/join"),
                org,
                Some(serde_json::json!({})),
            )
            .await?;
        Ok(w.conversation)
    }

    /// Any member may invite, and the invitee then sees the **full history**.
    pub async fn invite(&self, org: &str, conv_id: &str, user_id: &str) -> Result<()> {
        Self::check(
            self.request(
                reqwest::Method::POST,
                &format!("/conversations/{conv_id}/members"),
                org,
                Some(serde_json::json!({ "user_id": user_id })),
            )
            .await?,
        )
        .await?;
        Ok(())
    }

    /// Channels only. A DM or group DM answers `409 group_dm_frozen`.
    pub async fn leave(&self, org: &str, conv_id: &str, user_id: &str) -> Result<()> {
        Self::check(
            self.request(
                reqwest::Method::DELETE,
                &format!("/conversations/{conv_id}/members/{user_id}"),
                org,
                None,
            )
            .await?,
        )
        .await?;
        Ok(())
    }

    pub async fn patch_conversation(
        &self,
        org: &str,
        conv_id: &str,
        patch: ConversationPatch,
    ) -> Result<Conversation> {
        #[derive(Deserialize)]
        struct Wrapper {
            conversation: Conversation,
        }
        let w: Wrapper = self
            .json(
                reqwest::Method::PATCH,
                &format!("/conversations/{conv_id}"),
                org,
                Some(serde_json::to_value(patch)?),
            )
            .await?;
        Ok(w.conversation)
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "+".to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

impl RestClient {
    /// Reserve an upload and learn how to cut the file into parts.
    ///
    /// **Quota is refused here, before a single byte moves** — a `413
    /// quota_exceeded` carries `stored_bytes` / `staged_bytes` / `quota_bytes` /
    /// `requested_bytes` in its detail, and `staged_bytes` is the one that
    /// surprises people (uploads that were never claimed by a message still
    /// occupy the allowance until the 24h sweep).
    pub async fn create_upload(
        &self,
        org: &str,
        conv_id: &str,
        filename: &str,
        content_type: &str,
        size: u64,
    ) -> Result<UploadIntent> {
        let body = serde_json::json!({
            "conv_id": conv_id,
            "filename": filename,
            "content_type": content_type,
            "size": size,
        });
        self.json(reqwest::Method::POST, "/files/uploads", org, Some(body))
            .await
    }

    /// Upload one part.
    ///
    /// `content-length` is mandatory: R2 refuses a stream of unknown length, so
    /// the worker rejects a chunked part outright. `reqwest` sets it from a
    /// `Vec<u8>` body, which is why the part is passed by value rather than as
    /// a stream.
    pub async fn upload_part(
        &self,
        org: &str,
        file_id: &str,
        part_number: u32,
        bytes: Vec<u8>,
    ) -> Result<UploadedPart> {
        let token = self.tokens.mint().await?;
        let url = format!(
            "{}/files/uploads/{file_id}/parts/{part_number}?org={org}",
            self.base
        );
        let res = self
            .http
            .put(url)
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_LENGTH, bytes.len())
            .body(bytes)
            // A 32 MiB part on a poor connection is not a 20-second request.
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await?;
        Ok(Self::check(res).await?.json().await?)
    }

    /// Assemble the parts. The server measures the result and refuses an object
    /// larger than the size declared at the intent.
    pub async fn complete_upload(
        &self,
        org: &str,
        file_id: &str,
        parts: Vec<UploadedPart>,
    ) -> Result<Attachment> {
        #[derive(Deserialize)]
        struct Wrapper {
            file: Attachment,
        }
        let body = serde_json::json!({ "parts": parts });
        let w: Wrapper = self
            .json(
                reqwest::Method::POST,
                &format!("/files/uploads/{file_id}/complete"),
                org,
                Some(body),
            )
            .await?;
        Ok(w.file)
    }

    /// Abandon a staged upload. Best-effort: the server sweeps unclaimed
    /// uploads after 24h anyway, so a failure here costs nothing but quota.
    pub async fn abort_upload(&self, org: &str, file_id: &str) -> Result<()> {
        Self::check(
            self.request(
                reqwest::Method::DELETE,
                &format!("/files/uploads/{file_id}"),
                org,
                None,
            )
            .await?,
        )
        .await?;
        Ok(())
    }

    /// Download an attachment's bytes.
    ///
    /// `GET /files/{id}` answers a `302` whose target is a ticket with a
    /// sixty-second life. reqwest follows it in-flight; nothing here ever
    /// stores the redirect target, which is the whole rule about it.
    pub async fn download_file(&self, org: &str, file_id: &str) -> Result<Vec<u8>> {
        let res = Self::check(
            self.request(reqwest::Method::GET, &format!("/files/{file_id}"), org, None)
                .await?,
        )
        .await?;
        Ok(res.bytes().await?.to_vec())
    }
}
