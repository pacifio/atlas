// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use super::*;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputPayload;
use pretty_assertions::assert_eq;

fn message(role: &str, text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: role.to_string(),
        content: vec![ContentItem::InputText {
            text: text.to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

fn call(call_id: &str, name: &str, arguments: &str) -> ResponseItem {
    ResponseItem::FunctionCall {
        id: None,
        name: name.to_string(),
        namespace: None,
        arguments: arguments.to_string(),
        encrypted_function_args: None,
        call_id: call_id.to_string(),
        internal_chat_message_metadata_passthrough: None,
    }
}

fn output(call_id: &str, text: &str) -> ResponseItem {
    ResponseItem::FunctionCallOutput {
        id: None,
        call_id: call_id.to_string(),
        output: FunctionCallOutputPayload {
            body: FunctionCallOutputBody::Text(text.to_string()),
            success: Some(true),
        },
        internal_chat_message_metadata_passthrough: None,
    }
}

fn build<'a>(model: &'a str, items: &'a [ResponseItem], tools: &'a [Value]) -> BuiltChatRequest {
    build_chat_request(ChatRequestInput {
        model,
        instructions: "You are an agent.",
        items,
        tools,
        max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        output_schema: None,
    })
}

fn body_of(built: &BuiltChatRequest) -> Value {
    serde_json::to_value(&built.request)
        .unwrap_or_else(|err| panic!("the request must serialize: {err}"))
}

#[test]
fn the_body_carries_nothing_the_gateway_would_refuse() {
    // The gateway answers *anything* off its allowlist with a 400, nested keys
    // included — so the whole request dies for one stray field. This asserts
    // the property the type is shaped to guarantee, because the type is what
    // someone will edit.
    let items = [message("user", "hello")];
    let built = build("claude-sonnet-4-6", &items, &[]);
    let body = body_of(&built);

    let Some(object) = body.as_object() else {
        panic!("the request body must be a JSON object, got {body}");
    };
    let keys: Vec<&str> = object.keys().map(String::as_str).collect();
    for key in &keys {
        assert!(
            ALLOWED_TOP_LEVEL_KEYS.contains(key),
            "`{key}` is not on the gateway's allowlist; this request is a 400",
        );
    }
    // Not vacuous: the body has to actually say something.
    assert!(keys.contains(&"messages") && keys.contains(&"model"));
}

#[test]
fn none_of_the_six_parameters_claude_refuses_is_ever_emitted() {
    // Five of these the builder simply never sets. `response_format` it would,
    // and does not — the default model is a Claude, so an unconditional
    // allowlist would fail every default-model request.
    let items = [message("user", "hello")];
    let schema = json!({"type": "object"});
    let built = build_chat_request(ChatRequestInput {
        model: "claude-sonnet-4-6",
        instructions: "",
        items: &items,
        tools: &[],
        max_output_tokens: 1024,
        output_schema: Some(&schema),
    });
    let body = body_of(&built);
    for param in REFUSED_BY_CLAUDE {
        assert!(
            body.get(param).is_none(),
            "`{param}` is a 400 invalid_parameter on Claude models",
        );
    }
}

#[test]
fn a_schema_constrained_turn_still_gets_its_schema_on_a_model_that_accepts_one() {
    // The other half of the gate. Dropping `response_format` everywhere would
    // be a safe-looking way to lose a feature on the models that support it.
    let items = [message("user", "hello")];
    let schema = json!({"type": "object", "properties": {}});
    let built = build_chat_request(ChatRequestInput {
        model: "gemini-3.6-flash",
        instructions: "",
        items: &items,
        tools: &[],
        max_output_tokens: 1024,
        output_schema: Some(&schema),
    });
    let body = body_of(&built);
    assert_eq!(body["response_format"]["type"], json!("json_schema"));
    assert_eq!(body["response_format"]["json_schema"]["schema"], schema);
}

#[test]
fn max_tokens_is_always_there_and_never_above_the_clamp() {
    // Absence means an injected 4,096, counted reasoning-inclusive, which
    // truncates an agent turn in a way that reads as the model stopping early.
    let items = [message("user", "hi")];
    let body = body_of(&build("claude-sonnet-4-6", &items, &[]));
    assert_eq!(body["max_tokens"], json!(DEFAULT_MAX_OUTPUT_TOKENS));

    let built = build_chat_request(ChatRequestInput {
        model: "claude-sonnet-4-6",
        instructions: "",
        items: &items,
        tools: &[],
        max_output_tokens: 999_999,
        output_schema: None,
    });
    assert_eq!(built.request.max_tokens, OUTPUT_TOKEN_CLAMP);
}

#[test]
fn the_baked_instructions_lead_as_a_system_message() {
    // `instructions` is a Responses field and off the allowlist, so the system
    // prompt has nowhere else to go. Losing it silently would leave the agent
    // with no instructions at all and no error to explain why.
    let items = [message("user", "hi")];
    let built = build("claude-sonnet-4-6", &items, &[]);
    assert_eq!(
        built.request.messages.first(),
        Some(&ChatMessage::System {
            content: "You are an agent.".to_string()
        }),
    );
}

#[test]
fn a_developer_message_is_a_system_message_here() {
    let items = [message("developer", "extra rules")];
    let built = build_chat_request(ChatRequestInput {
        model: "claude-sonnet-4-6",
        instructions: "",
        items: &items,
        tools: &[],
        max_output_tokens: 1024,
        output_schema: None,
    });
    assert_eq!(
        built.request.messages,
        vec![ChatMessage::System {
            content: "extra rules".to_string()
        }],
    );
}

#[test]
fn parallel_tool_calls_become_one_assistant_turn_carrying_both() {
    // They arrive as two consecutive items. Two consecutive assistant turns is
    // not a shape Anthropic accepts, and the gateway translates the default
    // model to Anthropic.
    let items = [
        call("c1", "shell", r#"{"cmd":"ls"}"#),
        call("c2", "shell", r#"{"cmd":"pwd"}"#),
        output("c1", "a b"),
        output("c2", "/tmp"),
    ];
    let built = build("claude-sonnet-4-6", &items, &[]);
    let messages = &built.request.messages[1..];

    let ChatMessage::Assistant { tool_calls, .. } = &messages[0] else {
        panic!("the two calls belong to one assistant turn, got {messages:#?}");
    };
    assert_eq!(tool_calls.len(), 2);
    assert_eq!(tool_calls[0].id, "c1");
    assert_eq!(tool_calls[1].function.name, "shell");
    assert_eq!(
        messages[1],
        ChatMessage::Tool {
            tool_call_id: "c1".to_string(),
            content: "a b".to_string(),
        },
    );
}

#[test]
fn unparseable_tool_arguments_do_not_take_the_whole_request_down_with_them() {
    // The gateway's Anthropic translation answers invalid JSON arguments with a
    // 400 rather than emptying the call, so one malformed replayed call would
    // make every later turn in that thread fail.
    let items = [call("c1", "shell", "not json at all")];
    let built = build("claude-sonnet-4-6", &items, &[]);
    let ChatMessage::Assistant { tool_calls, .. } = &built.request.messages[1] else {
        panic!("expected an assistant turn");
    };
    assert_eq!(tool_calls[0].function.arguments, "{}");
}

#[test]
fn reasoning_is_dropped_because_this_wire_cannot_carry_it() {
    // Accepted loss, recorded in the gateway-fit research: the gateway keeps
    // Claude's thinking out of `content` on the way back and documents no way
    // to send it in. Replaying one would be a 400.
    let items = [
        ResponseItem::Reasoning {
            id: None,
            summary: vec![],
            content: None,
            encrypted_content: Some("opaque".to_string()),
            internal_chat_message_metadata_passthrough: None,
        },
        message("user", "hi"),
    ];
    let built = build("claude-sonnet-4-6", &items, &[]);
    let body = serde_json::to_string(&built.request)
        .unwrap_or_else(|err| panic!("serialize: {err}"));
    assert!(!body.contains("opaque"), "reasoning must not reach the wire");
    assert_eq!(built.request.messages.len(), 2, "system + user");
}

#[test]
fn images_ride_as_content_parts_rather_than_being_dropped() {
    let items = [ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![
            ContentItem::InputText {
                text: "what is this".to_string(),
            },
            ContentItem::InputImage {
                image_url: "data:image/png;base64,AAAA".to_string(),
                detail: None,
            },
        ],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }];
    let built = build("claude-sonnet-4-6", &items, &[]);
    let ChatMessage::User { content } = &built.request.messages[1] else {
        panic!("expected a user turn");
    };
    assert_eq!(
        content[1],
        ContentPart::ImageUrl {
            image_url: ImageUrlPart {
                url: "data:image/png;base64,AAAA".to_string()
            }
        },
    );
}

#[test]
fn a_function_tool_is_re_nested_under_the_key_the_gateway_reads() {
    // `function.parameters` is what the gateway rewrites into Anthropic's
    // `input_schema`. Left in the Responses shape — `type` and `name` at the
    // top level — the tool is either refused or arrives with no schema.
    let tools = [json!({
        "type": "function",
        "name": "shell",
        "description": "run a command",
        "strict": false,
        "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
    })];
    let items = [message("user", "hi")];
    let built = build("claude-sonnet-4-6", &items, &tools);
    let Some(tools) = built.request.tools else {
        panic!("tools must survive the reshape");
    };

    assert_eq!(tools[0]["type"], json!("function"));
    assert_eq!(tools[0]["function"]["name"], json!("shell"));
    assert_eq!(
        tools[0]["function"]["parameters"]["properties"]["cmd"]["type"],
        json!("string"),
    );
    assert!(
        tools[0].get("name").is_none(),
        "a top-level `name` is the Responses shape",
    );
    assert_eq!(built.request.tool_choice.as_deref(), Some("auto"));
}

#[test]
fn a_freeform_tool_is_flattened_and_its_name_recorded_for_the_way_back() {
    // apply_patch is the one that matters. A flattened tool whose name is not
    // recorded comes back as a `Function` payload, and the handler that runs
    // patches only accepts `Custom` — so the tool silently never runs.
    let tools = [json!({
        "type": "custom",
        "name": "apply_patch",
        "description": "edit files",
        "format": {"type": "grammar", "syntax": "lark", "definition": "start: ..."},
    })];
    let items = [message("user", "hi")];
    let built = build("claude-sonnet-4-6", &items, &tools);

    assert!(built.freeform_tools.contains("apply_patch"));
    let Some(tools) = built.request.tools else {
        panic!("tools must survive the reshape");
    };
    assert_eq!(tools[0]["function"]["name"], json!("apply_patch"));
    assert_eq!(
        tools[0]["function"]["parameters"]["required"],
        json!(["input"]),
    );
}

#[test]
fn a_responses_native_tool_shape_is_dropped_rather_than_sent() {
    // Sending it is a 400 that kills the whole request; dropping it loses one
    // tool. The authored catalogue turns these off, so this is the backstop.
    let tools = [
        json!({"type": "web_search"}),
        json!({"type": "function", "name": "shell", "description": "", "parameters": {}}),
    ];
    let items = [message("user", "hi")];
    let built = build("claude-sonnet-4-6", &items, &tools);
    let Some(tools) = built.request.tools else {
        panic!("the function tool must survive");
    };
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["function"]["name"], json!("shell"));
}

#[test]
fn no_tools_means_no_tool_choice_either() {
    let items = [message("user", "hi")];
    let built = build("claude-sonnet-4-6", &items, &[]);
    assert!(built.request.tools.is_none());
    assert!(
        built.request.tool_choice.is_none(),
        "`tool_choice` with no tools is a request the provider can only refuse",
    );
}

#[test]
fn the_claude_family_is_recognised_from_the_slug_the_catalogue_authors() {
    for slug in ["claude-sonnet-4-6", "claude-opus-5", "claude-opus-4-8"] {
        assert!(is_claude_model(slug), "{slug}");
    }
    for slug in ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gpt-5-codex"] {
        assert!(!is_claude_model(slug), "{slug}");
    }
}

#[test]
fn stream_is_on_because_the_usage_chunk_is_how_the_turn_is_metered() {
    let items = [message("user", "hi")];
    assert!(build("claude-sonnet-4-6", &items, &[]).request.stream);
}
