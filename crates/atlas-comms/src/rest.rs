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

/// One participant's recorded track. WebM, one file per participant.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RecordingTrack {
    pub id: String,
    pub filename: String,
    pub bytes: i64,
    /// A **60-second** link, minted per read against a live membership check —
    /// so it is fetched at click time and never stored.
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RecordingsResponse {
    pub state: crate::wire::CallRecordingState,
    #[serde(default)]
    pub tracks: Vec<RecordingTrack>,
}

/// A Prompt Draft's metadata (ATL-194) — never its content: the server
/// stores opaque Yjs bytes it cannot read (ADR-0011), and this client's
/// Drafts tab only lists and creates. `title` is write-once; there is no
/// rename or delete route, and no lifecycle broadcast — the list is
/// poll-refreshed, mirroring the web client.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PromptDraft {
    pub id: String,
    pub conv_id: String,
    pub title: String,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub sent_at: Option<i64>,
    #[serde(default)]
    pub sent_by: Option<String>,
    #[serde(default)]
    pub sent_message_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DraftList {
    #[serde(default)]
    pub drafts: Vec<PromptDraft>,
}

/// The answer to `GET /calls?conv_id=…&include=recent` (ATL-208): every live
/// call plus the last 10 ended ones, oldest-first by `seq`. This is how the
/// web client cold-syncs its call cards, and it is why the desktop does not
/// need the journal to reach that far back — the DO's `calls` table is never
/// pruned, only the visible ended set is capped.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CallList {
    #[serde(default)]
    pub calls: Vec<crate::wire::Call>,
}

impl RestClient {
    /// A conversation's prompt drafts, newest-updated first. Unpaginated by
    /// contract; a non-member's answer is the ordinary 404.
    pub async fn drafts(&self, org: &str, conv_id: &str) -> Result<DraftList> {
        self.json(
            reqwest::Method::GET,
            &format!("/conversations/{conv_id}/drafts"),
            org,
            None,
        )
        .await
    }

    /// Create a draft. Title ≤ 200 chars (`CHAT_DRAFT_TITLE_MAX`) — refused,
    /// not truncated, past that. Deliberately NOT announced by the server, so
    /// the caller prepends the 201 body and everyone else learns by poll.
    pub async fn create_draft(
        &self,
        org: &str,
        conv_id: &str,
        title: &str,
    ) -> Result<PromptDraft> {
        #[derive(Deserialize)]
        struct Wrapper {
            draft: PromptDraft,
        }
        let body = serde_json::json!({ "title": title });
        let w: Wrapper = self
            .json(
                reqwest::Method::POST,
                &format!("/conversations/{conv_id}/drafts"),
                org,
                Some(body),
            )
            .await?;
        Ok(w.draft)
    }

    /// A conversation's calls: all live ones plus the last 10 ended (ATL-208).
    ///
    /// This is the cold-sync path for call history. The journal still delivers
    /// `call.*` frames live and on resume, but a watermark already at the live
    /// edge replays nothing — so, like the web client, history is asked for
    /// over REST and the frames are only an overlay on top of it.
    pub async fn calls(&self, org: &str, conv_id: &str) -> Result<CallList> {
        self.json(
            reqwest::Method::GET,
            &format!("/calls?conv_id={}&include=recent", urlencode(conv_id)),
            org,
            None,
        )
        .await
    }

    /// A call's recorded tracks. Each carries a short-lived URL, so the answer
    /// is only good for about a minute — ask again rather than caching it.
    ///
    /// The server hands the URL back RELATIVE (`../../files/dl/{token}?org=…`,
    /// resolved against the recordings route itself), so it is made absolute
    /// here — nothing downstream should ever see a URL reqwest cannot GET.
    pub async fn call_recordings(&self, org: &str, call_id: &str) -> Result<RecordingsResponse> {
        let mut out: RecordingsResponse = self
            .json(
                reqwest::Method::GET,
                &format!("/calls/{call_id}/recordings"),
                org,
                None,
            )
            .await?;
        let route = reqwest::Url::parse(&format!("{}/calls/{call_id}/recordings", self.base))
            .map_err(|e| CommsError::Protocol(format!("bad recordings base: {e}")))?;
        for track in &mut out.tracks {
            if let Ok(abs) = route.join(&track.url) {
                track.url = abs.to_string();
            }
        }
        Ok(out)
    }

    /// Download a recording from its short-lived URL.
    ///
    /// The URL already carries its own credential (that is what the 60-second
    /// mint is), so this deliberately does NOT attach a bearer.
    pub async fn download_recording(&self, url: &str) -> Result<Vec<u8>> {
        self.download_recording_with(url, &mut |_, _| {}).await
    }

    /// `download_recording`, reporting `(got, total)` after every chunk.
    pub async fn download_recording_with(
        &self,
        url: &str,
        on_chunk: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<Vec<u8>> {
        let res = self
            .http
            .get(url)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await?;
        Self::drain(Self::check(res).await?, on_chunk).await
    }

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
        self.download_file_with(org, file_id, &mut |_, _| {}).await
    }

    /// `download_file`, reporting `(got, total)` after every chunk. `total`
    /// is `0` when the server declared no content-length.
    pub async fn download_file_with(
        &self,
        org: &str,
        file_id: &str,
        on_chunk: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<Vec<u8>> {
        let res = Self::check(
            self.request(reqwest::Method::GET, &format!("/files/{file_id}"), org, None)
                .await?,
        )
        .await?;
        Self::drain(res, on_chunk).await
    }

    /// Pull a response body chunk-by-chunk so a caller can watch it arrive —
    /// `.bytes()` would answer only once, at the end, which is exactly when a
    /// progress ring stops being useful.
    async fn drain(
        res: reqwest::Response,
        on_chunk: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<Vec<u8>> {
        use futures_util::StreamExt;
        let total = res.content_length().unwrap_or(0);
        let mut out: Vec<u8> = Vec::with_capacity(total.min(64 * 1024 * 1024) as usize);
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            out.extend_from_slice(&chunk);
            on_chunk(out.len() as u64, total);
        }
        Ok(out)
    }
}

/// Spaces REST — the summary pre-flight and the media triangle
/// (reserve → PUT → ticketed download). Everything else about a Space is
/// socket-only by contract.
impl RestClient {
    /// `GET /spaces?org&conv`. Lazily creates the Space (and its default
    /// "Canvas" page) server-side; refusals arrive as ordinary 401/403/404,
    /// which is the whole reason to call this before dialing the socket — a
    /// failed WS handshake cannot say why.
    pub async fn space_summary(
        &self,
        org: &str,
        conv_id: &str,
    ) -> Result<crate::spaces::SpaceSummary> {
        self.json(
            reqwest::Method::GET,
            &format!("/spaces?conv={conv_id}"),
            org,
            None,
        )
        .await
    }

    /// Reserve a media object. `stored: true` in the answer is dedup — the
    /// bytes are already there and no upload should follow.
    pub async fn space_media_reserve(
        &self,
        org: &str,
        conv_id: &str,
        content_hash: &str,
        mime: &str,
        size: u64,
    ) -> Result<crate::spaces::SpaceMediaReserved> {
        let body = serde_json::json!({
            "content_hash": content_hash,
            "mime": mime,
            "size": size,
        });
        self.json(
            reqwest::Method::POST,
            &format!("/spaces/media?conv={conv_id}"),
            org,
            Some(body),
        )
        .await
    }

    /// Deliver reserved bytes. One streamed PUT, never multipart — R2 can only
    /// verify a whole-object SHA-256 on a single write, and the server holds
    /// us to `Content-Length == reserved size` exactly.
    pub async fn space_media_put(
        &self,
        org: &str,
        conv_id: &str,
        content_hash: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let token = self.tokens.mint().await?;
        let url = format!(
            "{}/spaces/media/{content_hash}?conv={conv_id}&org={org}",
            self.base
        );
        let res = self
            .http
            .put(url)
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_TYPE, mime)
            .timeout(std::time::Duration::from_secs(300))
            .body(bytes)
            .send()
            .await?;
        Self::check(res).await?;
        Ok(())
    }

    /// Fetch a media object's bytes: `GET /spaces/media/{hash}` answers a 302
    /// into the ticketed `/spaces/dl/{token}` (60s life), which reqwest
    /// follows same-host. Cached by the caller under the immutable hash.
    pub async fn space_media_download(
        &self,
        org: &str,
        conv_id: &str,
        content_hash: &str,
    ) -> Result<Vec<u8>> {
        let res = Self::check(
            self.request(
                reqwest::Method::GET,
                &format!("/spaces/media/{content_hash}?conv={conv_id}"),
                org,
                None,
            )
            .await?,
        )
        .await?;
        Self::drain(res, &mut |_, _| {}).await
    }
}
