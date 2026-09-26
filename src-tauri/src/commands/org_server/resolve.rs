//! **Name resolution**: how a member or a conversation the model names
//! becomes an id. Not a tool — the tools that take a person or a conversation
//! by name call it, against the roster and the conversation list the
//! organisation cloud returned.
//!
//! The model is never trusted to invent an id, and never left to guess one:
//! a name matches by rule, in tiers, and the first tier with any match
//! decides.
//!
//! 1. **The id itself** — what a mention in the prompt carries, and what an
//!    earlier `org_members` or `org_conversations` answer gave the model.
//! 2. **The exact name**, as the roster spells it.
//! 3. **The email** (members only), ignoring case, as email does.
//! 4. **The name ignoring case.**
//!
//! Before any tier, an **organisation link** ([`OrgLink`]) — what a composer
//! mention of a member, a conversation or a recorded session puts in the
//! prompt — is read as the id it carries, and as nothing else: a member link
//! matches that member's id only, and a link of another kind matches nothing.
//!
//! A leading `@` on a member or `#` on a channel is how people write them,
//! not part of the name, and is dropped. Nothing looser than case is matched
//! — no prefixes, no first names — because a loose match that finds one
//! person is a guess that happened to be unique. Zero matches is an error;
//! exactly one is used; more than one returns every candidate, with its id,
//! so the model can ask the user which one (ADR-0013).
//!
//! Pure: no cloud, no clock, no I/O.

use super::cloud::{Member, OrgConversation};

/// The scheme every organisation link is written in.
pub const ORG_LINK_SCHEME: &str = "atlas-org://";

/// An **organisation link**: how a composer mention of a member, a
/// conversation or a recorded session reaches the model — a resource link
/// carrying the id, so "send it to @Grace" or "the comments on @Session" need
/// no name resolution. The one definition of the form: `compose_prompt`
/// writes it ([`OrgLink::uri`]), and the tools read it ([`OrgLink::parse`])
/// through [`member`], [`conversation`] and the session tools' target, so every
/// argument that takes a member, a conversation or a session takes its link.
///
/// - `atlas-org://member/<user id>`
/// - `atlas-org://conversation/<conversation id>`
/// - `atlas-org://recorded-session/<Workspace id>/<session id>`
///
/// A recorded session is not a local past session: that one is a transcript on
/// this disk, inlined into the prompt, and never becomes a link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrgLink {
    Member { user_id: String },
    Conversation { id: String },
    RecordedSession { workspace_id: String, session_id: String },
}

/// One id as a path segment: the characters that would end or re-scope it
/// are percent-encoded, and nothing else — ids are opaque, and short.
fn segment(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for ch in id.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '?' => out.push_str("%3F"),
            '#' => out.push_str("%23"),
            ' ' => out.push_str("%20"),
            c => out.push(c),
        }
    }
    out
}

/// A path segment back to its id, or `None` for a blank or badly encoded one.
fn unsegment(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let id = String::from_utf8(out).ok()?;
    (!id.trim().is_empty()).then_some(id)
}

impl OrgLink {
    /// The link as the prompt carries it.
    pub fn uri(&self) -> String {
        match self {
            OrgLink::Member { user_id } => format!("{ORG_LINK_SCHEME}member/{}", segment(user_id)),
            OrgLink::Conversation { id } => format!("{ORG_LINK_SCHEME}conversation/{}", segment(id)),
            OrgLink::RecordedSession { workspace_id, session_id } => {
                format!("{ORG_LINK_SCHEME}recorded-session/{}/{}", segment(workspace_id), segment(session_id))
            }
        }
    }

    /// The link `text` is, or `None` when it is not one — a name, an email,
    /// a bare id, or a malformed link, which then matches nothing.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let scheme = text.get(..ORG_LINK_SCHEME.len())?;
        if !scheme.eq_ignore_ascii_case(ORG_LINK_SCHEME) {
            return None;
        }
        let rest = text[ORG_LINK_SCHEME.len()..].trim_end_matches('/');
        let parts: Vec<&str> = rest.split('/').collect();
        match parts.as_slice() {
            ["member", id] => Some(OrgLink::Member { user_id: unsegment(id)? }),
            ["conversation", id] => Some(OrgLink::Conversation { id: unsegment(id)? }),
            ["recorded-session", workspace, session] => Some(OrgLink::RecordedSession {
                workspace_id: unsegment(workspace)?,
                session_id: unsegment(session)?,
            }),
            _ => None,
        }
    }

    /// Whether `text` is written as an organisation link at all, well formed
    /// or not.
    pub fn looks_like(text: &str) -> bool {
        text.trim().get(..ORG_LINK_SCHEME.len()).is_some_and(|s| s.eq_ignore_ascii_case(ORG_LINK_SCHEME))
    }
}

/// What a name came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolution<'a, T> {
    /// Nothing matched.
    None,
    /// Exactly one matched: use it.
    One(&'a T),
    /// More than one matched in the deciding tier, in list order: ask.
    Many(Vec<&'a T>),
}

/// The first tier with any match decides; within it, one is an answer and
/// more is a question.
fn first_tier<'a, T>(items: &'a [T], tiers: &[&dyn Fn(&T) -> bool]) -> Resolution<'a, T> {
    for matches in tiers {
        let found: Vec<&T> = items.iter().filter(|item| matches(item)).collect();
        match found.len() {
            0 => continue,
            1 => return Resolution::One(found[0]),
            _ => return Resolution::Many(found),
        }
    }
    Resolution::None
}

/// A member by id, name or email.
pub fn member<'a>(roster: &'a [Member], query: &str) -> Resolution<'a, Member> {
    if OrgLink::looks_like(query) {
        return match OrgLink::parse(query) {
            Some(OrgLink::Member { user_id }) => first_tier(roster, &[&|m: &Member| m.user_id == user_id]),
            _ => Resolution::None,
        };
    }
    let query = query.trim();
    let name = query.strip_prefix('@').unwrap_or(query).trim();
    if name.is_empty() {
        return Resolution::None;
    }
    let lower = name.to_lowercase();
    first_tier(
        roster,
        &[
            &|m: &Member| m.user_id == query,
            &|m: &Member| m.name == name,
            &|m: &Member| !m.email.is_empty() && m.email.to_lowercase() == lower,
            &|m: &Member| m.name.to_lowercase() == lower,
        ],
    )
}

/// A channel's name as people write it after the `#`.
fn named(conversation: &OrgConversation) -> Option<&str> {
    conversation.name.as_deref().map(|n| n.strip_prefix('#').unwrap_or(n))
}

/// A conversation by id or name. Only channels have names; a DM is reached
/// through its member, not its conversation.
pub fn conversation<'a>(conversations: &'a [OrgConversation], query: &str) -> Resolution<'a, OrgConversation> {
    if OrgLink::looks_like(query) {
        return match OrgLink::parse(query) {
            Some(OrgLink::Conversation { id }) => first_tier(conversations, &[&|c: &OrgConversation| c.id == id]),
            _ => Resolution::None,
        };
    }
    let query = query.trim();
    let name = query.strip_prefix('#').unwrap_or(query).trim();
    if name.is_empty() {
        return Resolution::None;
    }
    let lower = name.to_lowercase();
    first_tier(
        conversations,
        &[
            &|c: &OrgConversation| c.id == query,
            &|c: &OrgConversation| named(c) == Some(name),
            &|c: &OrgConversation| named(c).is_some_and(|n| n.to_lowercase() == lower),
        ],
    )
}

#[cfg(test)]
mod tests {
    use atlas_comms::wire::ConversationKind;

    use super::*;

    fn m(user_id: &str, name: &str, email: &str) -> Member {
        Member { user_id: user_id.into(), name: name.into(), email: email.into(), role: None }
    }

    fn roster() -> Vec<Member> {
        vec![
            m("u-ada", "Ada Lovelace", "ada@acme.dev"),
            m("u-sam1", "Sam Lee", "sam.lee@acme.dev"),
            m("u-sam2", "Sam Lee", "slee@acme.dev"),
            m("u-grace", "Grace Hopper", "Grace@Acme.dev"),
            m("u-GRACE", "grace hopper", "gh@elsewhere.dev"),
        ]
    }

    fn ids<T>(found: Resolution<'_, T>, id: impl Fn(&T) -> &str) -> Result<String, Vec<String>> {
        match found {
            Resolution::None => Err(Vec::new()),
            Resolution::One(one) => Ok(id(one).to_string()),
            Resolution::Many(many) => Err(many.into_iter().map(|c| id(c).to_string()).collect()),
        }
    }

    fn who(query: &str) -> Result<String, Vec<String>> {
        ids(member(&roster(), query), |m| &m.user_id)
    }

    #[test]
    fn an_exact_name_resolves_to_its_member() {
        assert_eq!(who("Ada Lovelace"), Ok("u-ada".into()));
        assert_eq!(who("@Ada Lovelace"), Ok("u-ada".into()), "an @ is how people write a member");
    }

    #[test]
    fn a_name_in_another_case_resolves_when_no_one_has_it_exactly() {
        assert_eq!(who("ada lovelace"), Ok("u-ada".into()));
        assert_eq!(who("  ADA LOVELACE "), Ok("u-ada".into()));
    }

    #[test]
    fn an_exact_name_wins_over_the_same_name_in_another_case() {
        assert_eq!(who("grace hopper"), Ok("u-GRACE".into()));
        assert_eq!(who("Grace Hopper"), Ok("u-grace".into()));
        assert_eq!(who("GRACE HOPPER"), Err(vec!["u-grace".into(), "u-GRACE".into()]), "two differ only by case");
    }

    #[test]
    fn an_email_resolves_ignoring_case() {
        assert_eq!(who("slee@acme.dev"), Ok("u-sam2".into()));
        assert_eq!(who("grace@acme.DEV"), Ok("u-grace".into()));
    }

    #[test]
    fn an_id_resolves_to_itself() {
        assert_eq!(who("u-sam1"), Ok("u-sam1".into()));
    }

    #[test]
    fn two_members_with_one_name_are_both_candidates_in_roster_order() {
        assert_eq!(who("Sam Lee"), Err(vec!["u-sam1".into(), "u-sam2".into()]));
    }

    #[test]
    fn nothing_looser_than_case_matches() {
        assert_eq!(who("Ada"), Err(vec![]), "a first name is a guess");
        assert_eq!(who("Lovelace"), Err(vec![]));
        assert_eq!(who("ada@acme"), Err(vec![]));
        assert_eq!(who(""), Err(vec![]));
        assert_eq!(who("@"), Err(vec![]));
    }

    fn c(id: &str, kind: ConversationKind, name: Option<&str>) -> OrgConversation {
        OrgConversation { id: id.into(), kind, name: name.map(Into::into), member_ids: None, caller_is_member: true }
    }

    fn channels() -> Vec<OrgConversation> {
        vec![
            c("c-general", ConversationKind::Channel, Some("general")),
            c("c-design", ConversationKind::Channel, Some("Design")),
            c("c-design-2", ConversationKind::Channel, Some("design")),
            c("c-dm", ConversationKind::Dm, None),
            c("c-ops", ConversationKind::Channel, Some("#ops")),
        ]
    }

    fn which(query: &str) -> Result<String, Vec<String>> {
        ids(conversation(&channels(), query), |c| &c.id)
    }

    #[test]
    fn a_channel_resolves_by_name_with_or_without_its_hash() {
        assert_eq!(which("general"), Ok("c-general".into()));
        assert_eq!(which("#general"), Ok("c-general".into()));
        assert_eq!(which("ops"), Ok("c-ops".into()), "a name stored with its hash matches without it");
        assert_eq!(which("#OPS"), Ok("c-ops".into()));
    }

    #[test]
    fn a_channel_name_in_another_case_resolves_unless_one_has_it_exactly() {
        assert_eq!(which("GENERAL"), Ok("c-general".into()));
        assert_eq!(which("design"), Ok("c-design-2".into()));
        assert_eq!(which("DESIGN"), Err(vec!["c-design".into(), "c-design-2".into()]));
    }

    #[test]
    fn a_conversation_resolves_by_its_id() {
        assert_eq!(which("c-dm"), Ok("c-dm".into()));
    }

    #[test]
    fn a_member_link_resolves_to_the_member_it_carries_and_to_nothing_else() {
        assert_eq!(who("atlas-org://member/u-sam2"), Ok("u-sam2".into()), "one of two Sam Lees, by id");
        assert_eq!(who("  ATLAS-ORG://member/u-ada "), Ok("u-ada".into()));
        assert_eq!(who("atlas-org://member/u-nobody"), Err(vec![]));
        assert_eq!(who("atlas-org://conversation/u-ada"), Err(vec![]), "a conversation link is not a member");
        assert_eq!(who("atlas-org://recorded-session/ws/u-ada"), Err(vec![]));
        assert_eq!(who("atlas-org://member/"), Err(vec![]), "a malformed link is not a name either");
    }

    #[test]
    fn a_conversation_link_resolves_to_the_conversation_it_carries_and_to_nothing_else() {
        assert_eq!(which("atlas-org://conversation/c-dm"), Ok("c-dm".into()), "a DM, which has no name");
        assert_eq!(which("atlas-org://conversation/c-design"), Ok("c-design".into()));
        assert_eq!(which("atlas-org://member/c-general"), Err(vec![]), "a member link is not a conversation");
        assert_eq!(which("atlas-org://conversation/general"), Err(vec![]), "a link carries an id, never a name");
    }

    #[test]
    fn every_link_reads_back_as_itself() {
        for link in [
            OrgLink::Member { user_id: "u-1".into() },
            OrgLink::Conversation { id: "c-general".into() },
            OrgLink::RecordedSession { workspace_id: "ws-atlas".into(), session_id: "rs-1".into() },
            OrgLink::Member { user_id: "odd/id?#with space%".into() },
        ] {
            assert_eq!(OrgLink::parse(&link.uri()), Some(link.clone()), "{}", link.uri());
        }
        assert_eq!(OrgLink::Member { user_id: "u-1".into() }.uri(), "atlas-org://member/u-1");
        assert_eq!(OrgLink::Conversation { id: "c-1".into() }.uri(), "atlas-org://conversation/c-1");
        assert_eq!(
            OrgLink::RecordedSession { workspace_id: "ws".into(), session_id: "rs".into() }.uri(),
            "atlas-org://recorded-session/ws/rs",
        );
    }

    #[test]
    fn names_ids_and_malformed_links_are_not_links() {
        for text in [
            "Ada Lovelace",
            "u-1",
            "file:///tmp/a.rs",
            "atlas-org://",
            "atlas-org://member",
            "atlas-org://member/a/b",
            "atlas-org://recorded-session/ws",
            "atlas-org://session/rs-1",
            "atlas-org://member/%zz",
        ] {
            assert_eq!(OrgLink::parse(text), None, "{text}");
        }
    }

    #[test]
    fn an_unknown_channel_matches_nothing() {
        assert_eq!(which("random"), Err(vec![]));
        assert_eq!(which("#"), Err(vec![]));
    }
}
