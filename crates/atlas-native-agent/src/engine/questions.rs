//! Clarifying questions: the engine's `request_user_input` through the
//! question card (ADR-0013).
//!
//! The engine ships a first-class question tool — one to three questions, each
//! with a header, a sentence and two or three options, and a free-form "Other"
//! the *client* adds — and blocks the turn until it hears back. Atlas already
//! has the surface for it: the question card that ACP agents' AskUserQuestion
//! elicitations render on, pinned above the composer where the permission
//! card sits. This module is the join, in both directions.
//!
//! # The card decides by shape, so the shape is the contract
//!
//! The frontend picks the card over the generic form dialog by looking at the
//! schema, not at which agent sent it (`elicitationQuestionForm`,
//! `src/features/chat/lib/elicitation-schema.ts`). What it recognises is the
//! Claude adapter's bridge: one titled `oneOf` string field per question, and
//! a free-text companion per question marked with
//! `_meta._askUserQuestionCustomAnswer.questionId`. Emitting exactly that is
//! what makes the engine's question render as a question — options plus
//! Other — with no frontend change and no agent check.
//!
//! # Only an answer is an answer
//!
//! Skipping the card (decline), stopping the turn (cancel) and a store that
//! went away all come back to the engine as an **error**, never as an empty
//! accept. The engine reads a client error on this request as "no answers" and
//! lets the model carry on, so the turn never hangs on a dismissed card, and
//! the model is never told the user chose something they did not.

use std::collections::HashMap;

use agent_client_protocol::schema::v1 as acp;
use atlas_engine_app_server_protocol as v2;
use serde_json::{json, Map, Value as JsonValue};

/// The marker the question card reads to pair a free-text field with the
/// question it answers. The Claude adapter's spelling, kept verbatim.
const CUSTOM_ANSWER_META_KEY: &str = "_askUserQuestionCustomAnswer";

/// The free-text companion's field name for question `id`.
///
/// Question ids are the model's snake_case identifiers, so a double
/// underscore keeps the companion clear of any id it would plausibly mint.
fn other_key(id: &str) -> String {
    format!("{id}__other")
}

/// What the engine is told when the card was dismissed instead of answered.
pub const DISMISSED: &str = "the user dismissed the question without answering";

/// The engine's question, as an elicitation on `session_id`'s thread that the
/// question card renders.
pub fn elicitation(
    session_id: &acp::SessionId,
    params: &v2::ToolRequestUserInputParams,
) -> Result<acp::CreateElicitationRequest, String> {
    let mut properties = Map::new();
    for question in &params.questions {
        let options = question.options.as_deref().unwrap_or_default();
        let mut field = json!({
            "type": "string",
            "title": question.header,
            "description": question.question,
        });
        if !options.is_empty() {
            field["oneOf"] = options
                .iter()
                .map(|option| {
                    json!({
                        "const": option.label,
                        "title": option.label,
                        "description": option.description,
                    })
                })
                .collect();
        }
        properties.insert(question.id.clone(), field);
        // Other rides only beside a choice list. A question with no options is
        // free text already — the engine refuses those today, but the card's
        // fallback (the form dialog) still answers one if it ever arrives.
        if !options.is_empty() {
            properties.insert(
                other_key(&question.id),
                json!({
                    "type": "string",
                    "title": "Other",
                    "_meta": { CUSTOM_ANSWER_META_KEY: { "questionId": question.id } },
                }),
            );
        }
    }

    // The card prints `message` only when there is one question and that
    // question has no text of its own; the form dialog prints it always. The
    // question itself is the honest line for one, and a count for several.
    let message = match params.questions.as_slice() {
        [only] => only.question.clone(),
        many => format!("The agent has {} questions for you.", many.len()),
    };

    serde_json::from_value(json!({
        "mode": "form",
        "sessionId": session_id,
        "requestedSchema": { "type": "object", "properties": properties },
        "message": message,
    }))
    .map_err(|e| format!("the question could not be shaped for the card: {e}"))
}

/// The user's response to the card, as the engine's answer — or the error it
/// reads as "not answered".
///
/// A typed Other replaces the pick for its question: that is the card's own
/// precedence rule, and it is how the free text reaches the model. A question
/// the user left blank is left out, so the model sees which ones went
/// unanswered rather than an empty string it might read as a choice.
pub fn answers(
    params: &v2::ToolRequestUserInputParams,
    response: &acp::CreateElicitationResponse,
) -> Result<v2::ToolRequestUserInputResponse, String> {
    let acp::ElicitationAction::Accept(accepted) = &response.action else {
        return Err(DISMISSED.to_string());
    };
    let content = serde_json::to_value(&accepted.content).unwrap_or(JsonValue::Null);

    let mut answers = HashMap::new();
    for question in &params.questions {
        let other = content
            .get(other_key(&question.id))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let picked = match other {
            Some(text) => vec![text.to_string()],
            None => strings(content.get(&question.id)),
        };
        if !picked.is_empty() {
            answers.insert(
                question.id.clone(),
                v2::ToolRequestUserInputAnswer { answers: picked },
            );
        }
    }
    Ok(v2::ToolRequestUserInputResponse { answers })
}

/// One field's value as the engine's list of answer strings.
fn strings(value: Option<&JsonValue>) -> Vec<String> {
    match value {
        Some(JsonValue::String(s)) if !s.trim().is_empty() => vec![s.clone()],
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(JsonValue::as_str)
            .map(str::to_string)
            .collect(),
        Some(JsonValue::Number(n)) => vec![n.to_string()],
        Some(JsonValue::Bool(b)) => vec![b.to_string()],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(id: &str, header: &str, text: &str, labels: &[&str]) -> v2::ToolRequestUserInputQuestion {
        v2::ToolRequestUserInputQuestion {
            id: id.to_string(),
            header: header.to_string(),
            question: text.to_string(),
            is_other: true,
            is_secret: false,
            options: Some(
                labels
                    .iter()
                    .map(|label| v2::ToolRequestUserInputOption {
                        label: label.to_string(),
                        description: format!("pick {label}"),
                    })
                    .collect(),
            ),
        }
    }

    fn params(questions: Vec<v2::ToolRequestUserInputQuestion>) -> v2::ToolRequestUserInputParams {
        v2::ToolRequestUserInputParams {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            item_id: "call-1".to_string(),
            questions,
            is_blocking: true,
            auto_resolution_ms: None,
        }
    }

    fn accept(content: JsonValue) -> acp::CreateElicitationResponse {
        serde_json::from_value(json!({ "action": "accept", "content": content }))
            .expect("an accept response")
    }

    fn schema(request: &acp::CreateElicitationRequest) -> JsonValue {
        let wire = serde_json::to_value(request).expect("serialises");
        wire["requestedSchema"].clone()
    }

    #[test]
    fn a_question_becomes_a_titled_choice_field_with_an_other_companion() {
        let p = params(vec![question(
            "which_comment",
            "Comment",
            "Which comment should I resolve?",
            &["The first one", "All four"],
        )]);
        let request = elicitation(&acp::SessionId::new("thread-1"), &p).expect("shaped");
        let schema = schema(&request);

        let field = &schema["properties"]["which_comment"];
        assert_eq!(field["type"], "string");
        assert_eq!(field["title"], "Comment");
        assert_eq!(field["description"], "Which comment should I resolve?");
        assert_eq!(
            field["oneOf"],
            json!([
                { "const": "The first one", "title": "The first one", "description": "pick The first one" },
                { "const": "All four", "title": "All four", "description": "pick All four" },
            ]),
        );
        // The marker the card pairs the free-text field by — the shape
        // `elicitationQuestionForm` recognises, so this renders as the card.
        let other = &schema["properties"]["which_comment__other"];
        assert_eq!(other["type"], "string");
        assert_eq!(other["_meta"][CUSTOM_ANSWER_META_KEY]["questionId"], "which_comment");
    }

    #[test]
    fn the_elicitation_is_a_form_scoped_to_the_session() {
        let p = params(vec![question("q", "H", "Which?", &["A", "B"])]);
        let request = elicitation(&acp::SessionId::new("thread-1"), &p).expect("shaped");
        let wire = serde_json::to_value(&request).expect("serialises");
        assert_eq!(wire["mode"], "form");
        assert_eq!(wire["sessionId"], "thread-1");
        assert_eq!(wire["message"], "Which?");
    }

    #[test]
    fn several_questions_are_several_fields_and_the_message_counts_them() {
        let p = params(vec![
            question("channel", "Channel", "Which channel?", &["#eng", "#design"]),
            question("tone", "Tone", "How formal?", &["Casual", "Formal"]),
        ]);
        let request = elicitation(&acp::SessionId::new("thread-1"), &p).expect("shaped");
        let schema = schema(&request);
        for key in ["channel", "channel__other", "tone", "tone__other"] {
            assert!(schema["properties"].get(key).is_some(), "missing {key}");
        }
        assert_eq!(request.message, "The agent has 2 questions for you.");
    }

    #[test]
    fn a_picked_option_is_the_answer_for_its_question() {
        let p = params(vec![question("q", "H", "Which?", &["A", "B"])]);
        let response = answers(&p, &accept(json!({ "q": "B" }))).expect("answered");
        assert_eq!(response.answers["q"].answers, ["B"]);
    }

    #[test]
    fn typed_other_text_replaces_the_pick() {
        let p = params(vec![question("q", "H", "Which?", &["A", "B"])]);
        let response =
            answers(&p, &accept(json!({ "q": "A", "q__other": "  neither, use C  " }))).expect("answered");
        assert_eq!(response.answers["q"].answers, ["neither, use C"]);
    }

    #[test]
    fn each_question_is_answered_under_its_own_id() {
        let p = params(vec![
            question("channel", "Channel", "Which channel?", &["#eng", "#design"]),
            question("tone", "Tone", "How formal?", &["Casual", "Formal"]),
        ]);
        let response = answers(
            &p,
            &accept(json!({ "channel": "#eng", "tone__other": "dry" })),
        )
        .expect("answered");
        assert_eq!(response.answers["channel"].answers, ["#eng"]);
        assert_eq!(response.answers["tone"].answers, ["dry"]);
    }

    #[test]
    fn a_question_left_blank_is_left_out_rather_than_answered_empty() {
        let p = params(vec![
            question("a", "A", "First?", &["x", "y"]),
            question("b", "B", "Second?", &["x", "y"]),
        ]);
        let response = answers(&p, &accept(json!({ "a": "x", "b__other": "   " }))).expect("answered");
        assert!(response.answers.contains_key("a"));
        assert!(!response.answers.contains_key("b"));
    }

    #[test]
    fn declining_or_cancelling_is_an_error_never_an_empty_answer() {
        let p = params(vec![question("q", "H", "Which?", &["A", "B"])]);
        for action in [acp::ElicitationAction::Decline, acp::ElicitationAction::Cancel] {
            let response = acp::CreateElicitationResponse::new(action);
            assert_eq!(answers(&p, &response).unwrap_err(), DISMISSED);
        }
    }

    #[test]
    fn the_answer_is_the_engines_own_response_shape() {
        let p = params(vec![question("q", "H", "Which?", &["A", "B"])]);
        let response = answers(&p, &accept(json!({ "q": "A" }))).expect("answered");
        assert_eq!(
            serde_json::to_value(response).expect("serialises"),
            json!({ "answers": { "q": { "answers": ["A"] } } }),
        );
    }
}
