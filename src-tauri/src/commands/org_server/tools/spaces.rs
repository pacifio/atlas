//! Pages in a conversation's Space: `org_page_create`, and `org_page_write`,
//! which draws on one.

use rmcp::model::CallToolResult;
use serde_json::{json, Value};
use uuid::Uuid;

use super::super::cloud::{OrgConversation, NewPage};
use super::super::OrgScope;
use super::diagram::diagram;
use super::{conversation_json, is_id, resolve_conversation, tool_error, tool_json, OrgTools};
use crate::commands::memory_server::Grant;
use crate::commands::ui_server::UiRequest;

/// The longest a page's name may be: the contract's `SPACE_PAGE_NAME_MAX`,
/// counted as the contract counts it (UTF-16 units), and checked here so an
/// overlong name is refused before a socket is dialled rather than by the
/// Space after.
const PAGE_NAME_MAX: usize = 200;

impl OrgTools {
    /// `org_page_create`: a page with `name` at the root of the Space of the
    /// conversation `conversation` resolves to, created as the caller, and its
    /// id — which the UI tool server can open, and a later write fills.
    ///
    /// Auto-approved (ADR-0014): a page reaches no one, anyone in the
    /// conversation can see, move or delete it, and the call is audited like
    /// every call. Only in a conversation the caller is in — a channel they
    /// could join but have not is refused here, naming it, rather than left to
    /// the Space's refusal, so the model can say what to do. The conversation
    /// list is chat's, so a session whose organisation chat is not on is
    /// refused before anything is created.
    pub(super) async fn create_page(&self, scope: &OrgScope, conversation: &str, name: &str) -> CallToolResult {
        if name.encode_utf16().count() > PAGE_NAME_MAX {
            return tool_error(format!("a page's `name` is at most {PAGE_NAME_MAX} characters; shorten it"));
        }
        let conversation = match self.joined_conversation(scope, conversation, "add a page to", "created").await {
            Ok(one) => one,
            Err(answer) => return answer,
        };
        let page = NewPage { org_id: &scope.org_id, conversation_id: &conversation.id, name };
        let page_id = match self.cloud.create_page(page).await {
            Ok(id) => id,
            Err(e) => return tool_error(e.to_string()),
        };
        // The roster only names the people in a DM; when it cannot be read,
        // they keep their ids and the page is still reported.
        let roster = if conversation.member_ids.is_some() { self.cloud.members(&scope.org_id).await.ok() } else { None };
        tool_json(json!({
            "page_id": page_id,
            "conversation": conversation_json(&conversation, roster.as_deref()),
            "name": name,
        }))
    }
}

impl OrgTools {
    /// The conversation `query` resolves to, when the caller is in it: a Space
    /// is its members'. Refused otherwise, naming it — `verb` and `outcome`
    /// say what could not be done ("add a page to", "created").
    async fn joined_conversation(
        &self,
        scope: &OrgScope,
        query: &str,
        verb: &str,
        outcome: &str,
    ) -> Result<OrgConversation, CallToolResult> {
        let conversations = self.cloud.conversations(&scope.org_id).await.map_err(|e| tool_error(e.to_string()))?;
        let conversation = resolve_conversation(&conversations, query)?;
        if !conversation.caller_is_member {
            let named = conversation.name.as_deref().map_or_else(|| conversation.id.clone(), |n| format!("#{n}"));
            return Err(tool_error(format!(
                "you are not a member of {named}, so you cannot {verb} its Space; ask the user to join it \
                 first. Nothing was {outcome}."
            )));
        }
        Ok(conversation)
    }

    /// `org_page_write`: replace the content of page `page`, in the Space of
    /// the conversation `conversation` resolves to, with the diagram
    /// `document` — drawn by the window, as the caller.
    ///
    /// The page's codec lives in the frontend (the Space relay never looks
    /// inside a page), so this is the organisation call that crosses to the
    /// window ([`super::WINDOW_TOOLS`]): the document is checked here
    /// ([`diagram`]), the conversation resolved and the caller's membership
    /// confirmed as for `org_page_create`, and only then is the window asked
    /// to lay the document out and write it into the page through the Space's
    /// own sync — so a teammate with the page open sees it drawn. The window's
    /// answer (the page id and how many nodes and edges it placed) is the
    /// tool's; its refusal, or its silence past the bridge's timeout, is a
    /// tool error.
    ///
    /// Auto-approved (ADR-0014): drawing on a page reaches no one, anyone in
    /// the conversation can see and undo it, and the call is audited like
    /// every call.
    pub(super) async fn write_page(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        conversation: &str,
        page: &str,
        document: Option<&Value>,
    ) -> CallToolResult {
        // The shape every id is checked for ([`is_id`]), before the window is
        // asked, so a name or a link passed as a page id is refused in words.
        if !is_id(page) {
            return tool_error(format!(
                "\"{page}\" is not a page id; pass the `page_id` org_page_create answered. Nothing was drawn."
            ));
        }
        let document = match diagram(document) {
            Ok(document) => document,
            Err(refusal) => return tool_error(format!("{refusal}. Nothing was drawn.")),
        };
        let conversation = match self.joined_conversation(scope, conversation, "draw on", "drawn").await {
            Ok(one) => one,
            Err(answer) => return answer,
        };
        let Some(window) = &self.window else {
            return tool_error("the Atlas window is not available to draw on the page. Nothing was drawn.");
        };
        let asked = UiRequest {
            request_id: Uuid::new_v4(),
            session_id: grant.session_id.clone(),
            agent: grant.agent.clone(),
            cwd: grant.cwd.clone(),
            tool: "org_page_write".to_string(),
            args: json!({
                "org_id": scope.org_id,
                "conversation_id": conversation.id,
                "page_id": page,
                "document": document,
            }),
        };
        match window.perform(asked).await {
            Ok(answer) => tool_json(answer),
            Err(e) => tool_error(e),
        }
    }
}
