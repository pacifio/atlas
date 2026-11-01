//! The room lifecycle over REST (§6.2, §6.5, §6.10), with the bearer from the
//! artifacts crate's [`TokenSource`].
//!
//! A room is the **account's** (the token's `sub`), so no door names an
//! Organisation: there is no `?org=` anywhere. The Organisation and Workspace
//! are the room's optional, set-once *scope* — what decides whom the owner may
//! invite — and ride in the body.
//!
//! - `POST /rc/rooms` — `201 { room, hostSecret }` once; a repeat for the
//!   same `(owner, sessionId)` while the room is open is `200` with
//!   `hostSecret: null`, which means "close this room and create another"
//!   (the secret is never re-issued: that would hand it to anyone holding the
//!   owner's token).
//! - `PATCH /rc/rooms/{id}` — tier, title, accept-requests, scope (set-once).
//! - `POST /rc/rooms/{id}/close` — `204`, idempotent.
//!
//! `401` re-mints once per call; `403 rc_refused { gate }` surfaces the gate;
//! `409 limit_reached` carries the server's own sentence; `409 rc_no_scope` /
//! `rc_scope_set` are the scope's two refusals; `429` honours `Retry-After`
//! delta-seconds.

use std::sync::Arc;
use std::time::Duration;

use atlas_artifacts::TokenSource;
use serde::{Deserialize, Serialize};

use crate::wire::{Capability, EndReason, Tier};

/// What can go wrong at a door.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum RestError {
    #[error("not signed in: {0}")]
    Unauthorized(String),
    /// `403 rc_refused { gate }`: the platform flag or the Organisation's
    /// grant is off. `message` is the server's, written for a person.
    #[error("{message}")]
    Refused { gate: String, message: String },
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    /// `409 limit_reached`: the server names the figure.
    #[error("{0}")]
    LimitReached(String),
    /// `409 rc_closed`.
    #[error("this room has ended")]
    Closed,
    /// `409 rc_no_scope`: an invite or a link policy needed the room to be
    /// scoped to an Organisation, and it is a solo room.
    #[error("this room is not shared with an organisation yet")]
    NoScope,
    /// `409 rc_scope_set`: the scope is set once and was already set.
    #[error("this room is already shared with an organisation")]
    ScopeSet,
    #[error("{0}")]
    BadRequest(String),
    #[error("rate limited; try again in {retry_after}s")]
    RateLimited { retry_after: u64 },
    #[error("could not reach Atlas: {0}")]
    Transport(String),
    #[error("unexpected answer: {0}")]
    Protocol(String),
}

/// A room's scope: the Organisation whose members the owner may invite, and
/// the Workspace (the server's project) that narrows them. Nullable on the
/// room and set once; a room without one is a solo room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub org_id: String,
    pub workspace_id: Option<String>,
}

/// `POST /rc/rooms` — strict on the server: exactly these keys.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoomRequest {
    /// Sent when the desktop's active Organisation is a cloud one the token
    /// names; `null` opens a solo room. Required-nullable on the server.
    pub scope: Option<Scope>,
    pub session_id: String,
    pub client_id: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_tier: Option<Tier>,
    pub capabilities: Vec<Capability>,
}

/// One room, as every door shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    /// `None` for a solo room.
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub session_id: String,
    pub agent: String,
    pub model: Option<String>,
    pub title: Option<String>,
    pub owner_user_id: String,
    pub member_tier: Tier,
    pub capabilities: Vec<Capability>,
    pub status: RoomStatus,
    pub driver_epoch: Option<u64>,
    pub host_online: Option<bool>,
    pub created_at: u64,
    pub ended_at: Option<u64>,
    pub end_reason: Option<EndReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomStatus {
    Open,
    Ended,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomResponseWire {
    room: Room,
    host_secret: Option<String>,
}

/// A room the desktop can host: the row, and the secret only the `201` had.
#[derive(Clone)]
pub struct CreatedRoom {
    pub room: Room,
    /// `None` on the idempotent `200` — this desktop no longer has the
    /// secret, so it must close the room and create another.
    pub host_secret: Option<String>,
}

impl std::fmt::Debug for CreatedRoom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedRoom")
            .field("room", &self.room)
            .field(
                "host_secret",
                &self.host_secret.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// `PATCH /rc/rooms/{id}` — at least one field.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoomRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_tier: Option<Tier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accept_requests: Option<bool>,
    /// Set-once: `409 rc_scope_set` when the room already has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<ErrorInner>,
    gate: Option<String>,
}

#[derive(Deserialize)]
struct ErrorInner {
    code: Option<String>,
    message: Option<String>,
}

/// The RC doors on the ingest service.
pub struct RcClient {
    http: reqwest::Client,
    base: String,
    tokens: Arc<dyn TokenSource>,
}

impl RcClient {
    /// Against the ingest base (`ATLAS_INGEST_URL`, else production).
    pub fn new(tokens: Arc<dyn TokenSource>) -> Result<Self, RestError> {
        Self::at(&atlas_artifacts::ingest_base(), tokens)
    }

    /// Against an explicit base — what the tests answer on loopback.
    pub fn at(base: &str, tokens: Arc<dyn TokenSource>) -> Result<Self, RestError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| RestError::Transport(format!("building http client: {e}")))?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            tokens,
        })
    }

    /// Open (or find) the room for one session.
    pub async fn create_room(&self, body: &CreateRoomRequest) -> Result<CreatedRoom, RestError> {
        let url = self.url(&["rc", "rooms"])?;
        let response = self
            .send(
                |http, token| http.post(url.clone()).bearer_auth(token).json(body),
                "create room",
            )
            .await?;
        let wire: CreateRoomResponseWire = response
            .json()
            .await
            .map_err(|e| RestError::Protocol(format!("create room: {e}")))?;
        Ok(CreatedRoom {
            room: wire.room,
            host_secret: wire.host_secret,
        })
    }

    /// Change a room's settings (owner only).
    pub async fn update_room(
        &self,
        room_id: &str,
        body: &UpdateRoomRequest,
    ) -> Result<(), RestError> {
        let url = self.url(&["rc", "rooms", room_id])?;
        self.send(
            |http, token| http.patch(url.clone()).bearer_auth(token).json(body),
            "update room",
        )
        .await
        .map(|_| ())
    }

    /// End a room. Idempotent: an ended room answers `204` again.
    pub async fn close_room(&self, room_id: &str) -> Result<(), RestError> {
        let url = self.url(&["rc", "rooms", room_id, "close"])?;
        self.send(
            |http, token| http.post(url.clone()).bearer_auth(token),
            "close room",
        )
        .await
        .map(|_| ())
    }

    /// `segments` as one path segment each (an id can never add a segment or
    /// start a query). No query: the doors are the account's.
    fn url(&self, segments: &[&str]) -> Result<reqwest::Url, RestError> {
        if let Some(bad) = segments
            .iter()
            .find(|s| s.is_empty() || **s == "." || **s == "..")
        {
            return Err(RestError::BadRequest(format!("\"{bad}\" is not an id")));
        }
        let mut url = reqwest::Url::parse(&self.base)
            .map_err(|e| RestError::Transport(format!("the ingest base {}: {e}", self.base)))?;
        url.path_segments_mut()
            .map_err(|()| {
                RestError::Transport(format!("the ingest base {} takes no path", self.base))
            })?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    async fn mint(&self) -> Result<String, RestError> {
        self.tokens.mint().await.map_err(|e| match e {
            atlas_artifacts::Error::Unauthorized(m) => RestError::Unauthorized(m),
            other => RestError::Transport(other.to_string()),
        })
    }

    /// Send with a fresh token, re-minting once on a `401`, and classify the
    /// status before anything reads the body.
    async fn send(
        &self,
        build: impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
        what: &str,
    ) -> Result<reqwest::Response, RestError> {
        let mut reminted = false;
        loop {
            let token = self.mint().await?;
            let response = build(&self.http, &token)
                .send()
                .await
                .map_err(|e| RestError::Transport(format!("{what}: {}", e.without_url())))?;
            let status = response.status().as_u16();
            if status == 401 && !reminted {
                reminted = true;
                continue;
            }
            if (200..300).contains(&status) {
                return Ok(response);
            }
            return Err(classify(status, response, what).await);
        }
    }
}

async fn classify(status: u16, response: reqwest::Response, what: &str) -> RestError {
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(60);
    let body: Option<ErrorBody> = response.json().await.ok();
    let code = body
        .as_ref()
        .and_then(|b| b.error.as_ref())
        .and_then(|e| e.code.clone())
        .unwrap_or_default();
    let message = body
        .as_ref()
        .and_then(|b| b.error.as_ref())
        .and_then(|e| e.message.clone())
        .unwrap_or_else(|| format!("{what}: the server answered {status}"));
    match status {
        401 => RestError::Unauthorized(message),
        403 if code == "rc_refused" => RestError::Refused {
            gate: body.and_then(|b| b.gate).unwrap_or_default(),
            message,
        },
        403 => RestError::Forbidden(message),
        404 => RestError::NotFound(message),
        409 if code == "limit_reached" => RestError::LimitReached(message),
        409 if code == "rc_no_scope" => RestError::NoScope,
        409 if code == "rc_scope_set" => RestError::ScopeSet,
        409 => RestError::Closed,
        400 => RestError::BadRequest(message),
        429 => RestError::RateLimited { retry_after },
        _ => RestError::Transport(format!("{what}: the server answered {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_create_body_carries_exactly_the_keys_the_server_accepts() {
        // The server's schema is strict: an extra key is a 400.
        let body = CreateRoomRequest {
            scope: None,
            session_id: "s1".into(),
            client_id: "desk-00000000".into(),
            agent: "atlas-agent".into(),
            model: None,
            title: None,
            member_tier: Some(Tier::View),
            capabilities: vec![Capability::Steer],
        };
        let json = serde_json::to_value(&body).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "agent",
                "capabilities",
                "clientId",
                "memberTier",
                "scope",
                "sessionId"
            ]
        );
        // `scope` is required-nullable: present as null, never absent.
        assert!(json["scope"].is_null());
        assert!(json.get("org").is_none() && json.get("orgId").is_none());
    }

    #[test]
    fn a_scope_names_its_org_and_a_nullable_workspace() {
        let scope = Scope {
            org_id: "org_1".into(),
            workspace_id: None,
        };
        assert_eq!(
            serde_json::to_value(&scope).unwrap(),
            serde_json::json!({ "orgId": "org_1", "workspaceId": null })
        );
    }

    #[test]
    fn a_room_without_an_org_is_a_solo_room() {
        let room: Room = serde_json::from_value(serde_json::json!({
            "id": "01ROOM", "orgId": null, "workspaceId": null, "sessionId": "s",
            "agent": "atlas-agent", "model": null, "title": null,
            "ownerUserId": "u", "memberTier": "view", "capabilities": [],
            "status": "open", "driverEpoch": 1, "hostOnline": false,
            "createdAt": 1, "endedAt": null, "endReason": null
        }))
        .unwrap();
        assert_eq!(room.org_id, None);
        // A server that omits the key entirely reads the same way.
        let room: Room = serde_json::from_value(serde_json::json!({
            "id": "01ROOM", "sessionId": "s",
            "agent": "atlas-agent", "model": null, "title": null,
            "ownerUserId": "u", "memberTier": "view", "capabilities": [],
            "status": "open", "driverEpoch": null, "hostOnline": null,
            "createdAt": 1, "endedAt": null, "endReason": null
        }))
        .unwrap();
        assert_eq!(room.org_id, None);
    }

    #[test]
    fn the_doors_carry_no_org_query() {
        struct NoToken;
        impl TokenSource for NoToken {
            fn mint(
                &self,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = atlas_artifacts::Result<String>> + Send + '_>,
            > {
                Box::pin(async { Ok(String::new()) })
            }
        }
        let client = RcClient::at("http://127.0.0.1:1/", Arc::new(NoToken)).unwrap();
        let url = client.url(&["rc", "rooms", "01ROOM", "close"]).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:1/rc/rooms/01ROOM/close");
        assert!(client.url(&["rc", "rooms", ""]).is_err());
    }
}
