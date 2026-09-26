//! Mentions in what the tools post: a member the model names written as the
//! server's `<@user-id>` on the way out ([`with_mentions`], through
//! [`OrgTools::post_body`]), and read back as `@Name` on the way in
//! ([`named_mentions`]).

use rmcp::model::CallToolResult;

use super::super::cloud::Member;
use super::{resolve_member, roster_name, tool_error, OrgTools};

/// A comment body as a person reads it: every `<@user-id>` mention the
/// server parses written as `@Name` from the roster. A mention the roster
/// cannot name — it failed, or they have left — keeps its `<@id>`, so the
/// model still holds the id.
pub(in crate::commands::org_server) fn named_mentions(body: &str, roster: Option<&[Member]>) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("<@") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let named = after.find('>').and_then(|end| {
            let id = &after[..end];
            if id.is_empty() || id.contains(char::is_whitespace) || id.contains('<') {
                return None;
            }
            roster_name(roster, id).map(|name| (name, end))
        });
        match named {
            Some((name, end)) => {
                out.push('@');
                out.push_str(&name);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("<@");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `body` with each member `mentions` names written as the server's
/// `<@user-id>`: every `@<what the model named>` and `@<member's name>` in the
/// body becomes the mention, and a member the body does not `@` leads it. A
/// name that matches nobody, or several members, is the answer instead —
/// before anything is posted.
pub(in crate::commands::org_server) fn with_mentions(body: &str, mentions: &[String], roster: &[Member]) -> Result<String, CallToolResult> {
    let mut out = body.to_string();
    let mut leading = Vec::new();
    for named in mentions {
        let member = resolve_member(roster, named)?;
        let token = format!("<@{}>", member.user_id);
        let mut found = false;
        // Longest first, so "@Sam Lee" is not taken as "@Sam".
        let mut spellings = vec![named.trim_start_matches('@').to_string(), member.name.clone(), member.email.clone()];
        spellings.sort_by_key(|s| std::cmp::Reverse(s.len()));
        for spelling in spellings.iter().filter(|s| !s.is_empty()) {
            let at = format!("@{spelling}");
            if out.contains(&at) {
                out = out.replace(&at, &token);
                found = true;
            }
        }
        if !found && !out.contains(&token) {
            leading.push(token);
        }
    }
    if leading.is_empty() {
        Ok(out)
    } else {
        Ok(format!("{} {out}", leading.join(" ")))
    }
}

impl OrgTools {
    /// A post's body as it goes out — a reply's or a message's, for the call
    /// and for its approval card alike: every member `mentions` names written
    /// as `<@user-id>` ([`with_mentions`]) against the roster. `roster` is the
    /// one the caller has read already, if any; else it is read here, and
    /// only when there are mentions to write, and left in `roster` for the
    /// caller to name people with. The refusal — the roster could not be read,
    /// or a mention matched nobody or several — comes before anything is
    /// posted; a card shows the body as written instead.
    pub(super) async fn post_body(
        &self,
        org_id: &str,
        body: &str,
        mentions: &[String],
        roster: &mut Option<Vec<Member>>,
    ) -> Result<String, CallToolResult> {
        if mentions.is_empty() {
            return Ok(body.to_string());
        }
        if roster.is_none() {
            *roster = Some(self.cloud.members(org_id).await.map_err(|e| tool_error(e.to_string()))?);
        }
        with_mentions(body, mentions, roster.as_deref().unwrap_or_default())
    }
}
