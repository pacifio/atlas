// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! The Seam-2 fixture suite: recorded gateway streams, played through the
//! machine, asserted on the events the engine actually receives.

use super::*;
use bytes::Bytes;
use codex_protocol::models::ContentItem;
use futures::stream;
use pretty_assertions::assert_eq;

const IDLE: Duration = Duration::from_secs(5);

/// Plays a recorded stream, already framed, one SSE line per chunk.
async fn play(frames: &[&str]) -> Vec<Result<ResponseEvent, ApiError>> {
    let body: Vec<Bytes> = frames
        .iter()
        .map(|frame| Bytes::from(format!("data: {frame}\n\n")))
        .collect();
    play_bytes(body, ChatDialect::default()).await
}

async fn play_with(
    frames: &[&str],
    dialect: ChatDialect,
) -> Vec<Result<ResponseEvent, ApiError>> {
    let body: Vec<Bytes> = frames
        .iter()
        .map(|frame| Bytes::from(format!("data: {frame}\n\n")))
        .collect();
    play_bytes(body, dialect).await
}

/// Plays raw bytes, so a fixture can control where the chunk boundaries fall.
async fn play_bytes(
    chunks: Vec<Bytes>,
    dialect: ChatDialect,
) -> Vec<Result<ResponseEvent, ApiError>> {
    let byte_stream: ByteStream = Box::pin(stream::iter(
        chunks.into_iter().map(Ok::<_, codex_client::TransportError>),
    ));
    let (tx, mut rx) = mpsc::channel(64);
    process_chat_sse(byte_stream, tx, IDLE, /*telemetry*/ None, dialect).await;

    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

fn text_delta(text: &str) -> String {
    format!(
        r#"{{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{{"index":0,"delta":{{"content":"{text}"}},"finish_reason":null}}]}}"#
    )
}

const FINISH_STOP: &str = r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
const USAGE_ONLY: &str = r#"{"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"total_tokens":142,"prompt_tokens_details":{"cached_tokens":40}}}"#;

fn assistant_text(events: &[Result<ResponseEvent, ApiError>]) -> Option<String> {
    events.iter().find_map(|event| match event {
        Ok(ResponseEvent::OutputItemDone(ResponseItem::Message { role, content, .. }))
            if role == "assistant" =>
        {
            content.iter().find_map(|part| match part {
                ContentItem::OutputText { text } => Some(text.clone()),
                _ => None,
            })
        }
        _ => None,
    })
}

fn deltas(events: &[Result<ResponseEvent, ApiError>]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            Ok(ResponseEvent::OutputTextDelta(delta)) => Some(delta.as_str()),
            _ => None,
        })
        .collect()
}

fn completion(
    events: &[Result<ResponseEvent, ApiError>],
) -> Option<(Option<TokenUsage>, Option<bool>)> {
    events.iter().find_map(|event| match event {
        Ok(ResponseEvent::Completed {
            token_usage,
            end_turn,
            ..
        }) => Some((token_usage.clone(), *end_turn)),
        _ => None,
    })
}

fn error_of(events: &[Result<ResponseEvent, ApiError>]) -> Option<&ApiError> {
    events.iter().find_map(|event| event.as_ref().err())
}

#[test]
fn the_done_sentinel_is_what_ends_a_successful_turn() {
    // The Responses machine ends on `response.completed`; this wire has no such
    // event, and `[DONE]` is the only thing that says the answer is whole.
    let events = tokio_test::block_on(play(&[
        &text_delta("Hello"),
        &text_delta(", world"),
        FINISH_STOP,
        USAGE_ONLY,
        "[DONE]",
    ]));

    assert_eq!(deltas(&events), "Hello, world");
    assert_eq!(assistant_text(&events).as_deref(), Some("Hello, world"));
    let Some((usage, end_turn)) = completion(&events) else {
        panic!("the turn must complete");
    };
    assert_eq!(end_turn, Some(true));
    let Some(usage) = usage else {
        panic!("the usage-only chunk carries the meter's numbers");
    };
    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.cached_input_tokens, 40);
    assert_eq!(usage.total_tokens, 142);
    // Derived as total − prompt, the way the gateway's own meter derives it,
    // rather than read from `completion_tokens` (7 here, and wrong).
    assert_eq!(usage.output_tokens, 42);
}

#[test]
fn a_stream_that_stops_short_of_done_is_an_error_and_not_a_short_answer() {
    // The gateway's rule, in one test: "a client must treat a stream that ends
    // without `data: [DONE]` as incomplete". Reporting this as a completed turn
    // is how a truncated answer becomes indistinguishable from a finished one.
    let events = tokio_test::block_on(play(&[&text_delta("Half an ans"), FINISH_STOP]));

    assert!(
        completion(&events).is_none(),
        "an incomplete stream must not complete the turn",
    );
    let Some(err) = error_of(&events) else {
        panic!("an incomplete stream is an error");
    };
    assert!(
        err.to_string().contains("[DONE]"),
        "the error should say what was missing: {err}",
    );
    // The partial text still reached the user — it was really delivered.
    assert_eq!(deltas(&events), "Half an ans");
}

#[test]
fn an_in_stream_error_frame_is_parsed_rather_than_dropped() {
    // The Responses machine skips this frame — it has no top-level `type` — and
    // the caller then sees the generic "stream closed" instead of the gateway's
    // own diagnosis. Failure was detected; the reason was lost.
    let events = tokio_test::block_on(play(&[
        &text_delta("partial"),
        r#"{"error":{"type":"provider_error","code":"provider_error","message":"Vertex hung up"}}"#,
    ]));

    let Some(err) = error_of(&events) else {
        panic!("the frame must surface as an error");
    };
    assert!(
        err.to_string().contains("Vertex hung up"),
        "the gateway's own message is the diagnosis: {err}",
    );
    assert!(completion(&events).is_none());
}

#[test]
fn an_error_frame_wins_even_if_done_arrives_anyway() {
    // The gateway withholds the sentinel after an error, and two independent
    // signals are the point. If one ever did arrive, honouring it would present
    // a truncated answer as a finished one.
    let events = tokio_test::block_on(play(&[
        &text_delta("partial"),
        r#"{"error":{"code":"provider_error","message":"upstream died"}}"#,
        "[DONE]",
    ]));

    assert!(completion(&events).is_none(), "an errored turn never completes");
    assert!(error_of(&events).is_some());
}

#[test]
fn a_cap_error_arriving_mid_stream_is_not_retried() {
    // The classification runs on the frame, so the 402 rule holds wherever the
    // error shows up.
    let events = tokio_test::block_on(play(&[
        r#"{"error":{"code":"cap_exceeded","message":"budget spent"}}"#,
    ]));
    let Some(err) = error_of(&events) else {
        panic!("a cap frame must surface as an error");
    };
    let engine_error = crate::map_api_error(match err {
        ApiError::InvalidRequest { message } => ApiError::InvalidRequest {
            message: message.clone(),
        },
        other => panic!("a cap must be the non-retryable variant, got {other:?}"),
    });
    assert!(!engine_error.is_retryable());
}

#[test]
fn claude_thinking_arrives_as_reasoning_rather_than_as_the_answer() {
    // The gateway keeps thinking out of `content` as `reasoning_content`. Read
    // as content it would be printed to the user as the answer.
    let events = tokio_test::block_on(play(&[
        r#"{"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}"#,
        r#"{"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":" harder"},"finish_reason":null}]}"#,
        &text_delta("42"),
        FINISH_STOP,
        "[DONE]",
    ]));

    let reasoning: String = events
        .iter()
        .filter_map(|event| match event {
            Ok(ResponseEvent::ReasoningContentDelta { delta, .. }) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(reasoning, "Let me think harder");
    assert_eq!(deltas(&events), "42", "thinking must not leak into the answer");
    assert_eq!(assistant_text(&events).as_deref(), Some("42"));

    let reasoning_item = events.iter().any(|event| {
        matches!(
            event,
            Ok(ResponseEvent::OutputItemDone(ResponseItem::Reasoning { .. }))
        )
    });
    assert!(reasoning_item, "the thinking block has to be finished, not left open");
}

#[test]
fn a_multi_byte_character_split_across_chunk_boundaries_survives() {
    // The exact bug class the vendored SDK patch was written for: decoding a
    // partial UTF-8 sequence produces a replacement character, and when the
    // stream is a file edit the corruption is written to disk.
    let frame = text_delta("héllo — ok");
    let raw = format!("data: {frame}\n\n");
    let bytes = raw.into_bytes();

    // Split at every byte position, so no boundary is safe by luck.
    let mut chunks: Vec<Bytes> = Vec::new();
    for byte in &bytes {
        chunks.push(Bytes::from(vec![*byte]));
    }
    chunks.push(Bytes::from_static(b"data: [DONE]\n\n"));

    let events = tokio_test::block_on(play_bytes(chunks, ChatDialect::default()));
    assert_eq!(deltas(&events), "héllo — ok");
    assert!(
        !deltas(&events).contains('\u{FFFD}'),
        "a replacement character means a byte boundary was decoded early",
    );
}

#[test]
fn tool_call_fragments_are_reassembled_into_one_call() {
    // Ids and names arrive once, on the opening fragment; arguments arrive in
    // pieces with nothing but the index tying them together.
    let events = tokio_test::block_on(play(&[
        r#"{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"shell","arguments":"{\"cmd\":"}}]},"finish_reason":null}]}"#,
        r#"{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls -l\"}"}}]},"finish_reason":null}]}"#,
        r#"{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        "[DONE]",
    ]));

    let call = events
        .iter()
        .find_map(|event| match event {
            Ok(ResponseEvent::OutputItemDone(item @ ResponseItem::FunctionCall { .. })) => {
                Some(item.clone())
            }
            _ => None,
        })
;
    let Some(call) = call else {
        panic!("the call must be reassembled");
    };
    let ResponseItem::FunctionCall {
        name,
        arguments,
        call_id,
        ..
    } = call
    else {
        unreachable!()
    };
    assert_eq!(name, "shell");
    assert_eq!(call_id, "call_a");
    assert_eq!(arguments, r#"{"cmd":"ls -l"}"#);

    let Some((_, end_turn)) = completion(&events) else {
        panic!("the turn completes");
    };
    assert_eq!(
        end_turn,
        Some(false),
        "a turn that ended in tool calls is not a turn the model finished",
    );
}

#[test]
fn two_parallel_calls_stay_two_calls() {
    // They interleave by index. Keyed on anything else, their arguments merge
    // into one unparseable string.
    let events = tokio_test::block_on(play(&[
        r#"{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{\"p\":1}"}},{"index":1,"id":"b","function":{"name":"read","arguments":"{\"p\":2}"}}]},"finish_reason":null}]}"#,
        r#"{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        "[DONE]",
    ]));

    let calls: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Ok(ResponseEvent::OutputItemDone(ResponseItem::FunctionCall {
                call_id,
                arguments,
                ..
            })) => Some((call_id.clone(), arguments.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        calls,
        vec![
            ("a".to_string(), r#"{"p":1}"#.to_string()),
            ("b".to_string(), r#"{"p":2}"#.to_string()),
        ],
    );
}

#[test]
fn a_flattened_freeform_tool_comes_back_as_the_shape_its_handler_accepts() {
    // Without this the engine's router hands a `Function` payload to
    // apply_patch, whose handler matches only `Custom` — so the model asks for
    // a patch, the tool never runs, and nothing says why.
    let dialect = ChatDialect {
        freeform_tools: ["apply_patch".to_string()].into_iter().collect(),
    };
    let events = tokio_test::block_on(play_with(
        &[
            r#"{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"p1","function":{"name":"apply_patch","arguments":"{\"input\":\"*** Begin Patch\\n*** End Patch\"}"}}]},"finish_reason":null}]}"#,
            r#"{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            "[DONE]",
        ],
        dialect,
    ));

    let call = events
        .iter()
        .find_map(|event| match event {
            Ok(ResponseEvent::OutputItemDone(item @ ResponseItem::CustomToolCall { .. })) => {
                Some(item.clone())
            }
            _ => None,
        })
;
    let Some(call) = call else {
        panic!("a freeform tool must come back as a CustomToolCall");
    };
    let ResponseItem::CustomToolCall { name, input, .. } = call else {
        unreachable!()
    };
    assert_eq!(name, "apply_patch");
    assert_eq!(input, "*** Begin Patch\n*** End Patch");
}

#[test]
fn a_tool_not_flattened_stays_an_ordinary_function_call() {
    // The other side of the same switch, so the unwrapping cannot be applied to
    // everything.
    let events = tokio_test::block_on(play(&[
        r#"{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"shell","arguments":"{\"input\":\"ls\"}"}}]},"finish_reason":null}]}"#,
        r#"{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        "[DONE]",
    ]));

    let is_function = events.iter().any(|event| {
        matches!(
            event,
            Ok(ResponseEvent::OutputItemDone(ResponseItem::FunctionCall { .. }))
        )
    });
    assert!(is_function, "only flattened tools are unwrapped");
}

#[test]
fn every_finish_reason_the_gateway_maps_is_reported_honestly() {
    // The gateway maps Anthropic's stop_reason onto these. `length` means the
    // answer was cut off at max_tokens — reporting it as a finished turn is how
    // a truncation becomes invisible.
    for (reason, expected) in [
        ("stop", Some(true)),
        ("tool_calls", Some(false)),
        ("length", Some(false)),
        ("content_filter", Some(true)),
    ] {
        let frame = format!(
            r#"{{"id":"c1","choices":[{{"index":0,"delta":{{}},"finish_reason":"{reason}"}}]}}"#
        );
        let events = tokio_test::block_on(play(&[&text_delta("x"), &frame, "[DONE]"]));
        let Some((_, end_turn)) = completion(&events) else {
            panic!("the turn completes");
        };
        assert_eq!(end_turn, expected, "finish_reason {reason}");
    }
}

#[test]
fn a_turn_with_no_usage_chunk_still_completes() {
    // The gateway reports a usage block missing a count as no usage at all
    // rather than as zero, so the engine has to cope with `None` instead of
    // recording a fabricated measurement.
    let events = tokio_test::block_on(play(&[&text_delta("hi"), FINISH_STOP, "[DONE]"]));
    let Some((usage, _)) = completion(&events) else {
        panic!("the turn completes");
    };
    assert!(usage.is_none());
}

#[test]
fn an_unparseable_frame_poisons_the_turn_rather_than_vanishing() {
    // This test used to assert the opposite — that the frame is skipped and
    // the turn completes — on the theory that gateways emit keepalives. They
    // do, but as SSE *comments*, which the eventsource layer never surfaces
    // as data; a data frame this client cannot read carried something, and
    // whatever it carried is gone. Reporting the turn complete anyway is the
    // header's "short success", the exact outcome the withheld-`[DONE]` rule
    // exists to prevent — one layer up from the decoder (#59).
    let events = tokio_test::block_on(play(&[
        "{not json",
        &text_delta("still here"),
        FINISH_STOP,
        "[DONE]",
    ]));
    // The content that did arrive still streams — it was really delivered —
    // but the close reports an error, not a complete answer.
    assert_eq!(deltas(&events), "still here");
    assert!(
        completion(&events).is_none(),
        "a stream with a lost frame must not report a completed turn",
    );
    let Some(err) = error_of(&events) else {
        panic!("a lost frame is an error at close");
    };
    assert!(
        err.to_string().contains("could not read"),
        "the error should say what happened: {err}",
    );
}

#[test]
fn an_explicit_null_where_a_default_is_declared_is_a_lost_frame_too() {
    // `#[serde(default)]` covers a *missing* key, not a present-but-null one:
    // `{"choices":null}` fails the chunk parse. The failure mode must be the
    // same as any other unreadable frame — recorded, surfaced at close —
    // because it is silent by construction otherwise.
    let events = tokio_test::block_on(play(&[
        r#"{"id":"c1","choices":null}"#,
        FINISH_STOP,
        "[DONE]",
    ]));
    assert!(completion(&events).is_none());
    assert!(error_of(&events).is_some());
}

#[test]
fn a_gateway_error_frame_still_wins_over_a_lost_frame_diagnosis() {
    // The gateway's own diagnosis is strictly better than "a frame here was
    // unreadable". When both happen, the user sees the gateway's message.
    let events = tokio_test::block_on(play(&[
        "{not json",
        r#"{"error":{"message":"quota exhausted","code":"usage_limit_reached"}}"#,
        "[DONE]",
    ]));
    let Some(err) = error_of(&events) else {
        panic!("an error frame is an error");
    };
    assert!(
        err.to_string().contains("quota exhausted"),
        "the gateway's own diagnosis wins: {err}",
    );
}

#[test]
fn every_delta_is_inside_an_item_the_engine_was_told_about() {
    // Found by the seam test, not by inspection: the engine's turn loop
    // *panics* on a delta with no item open — `error_or_panic("OutputTextDelta
    // without active item")` — because a delta has nowhere to be rendered until
    // something says what it belongs to. The Responses wire announces each item
    // with its own event; this one announces nothing, so the boundaries have to
    // be inferred from which field the delta arrived in.
    let events = tokio_test::block_on(play(&[
        r#"{"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}"#,
        &text_delta("answer"),
        FINISH_STOP,
        "[DONE]",
    ]));

    let mut open: Option<&'static str> = None;
    for event in &events {
        match event {
            Ok(ResponseEvent::OutputItemAdded(item)) => {
                assert!(open.is_none(), "an item was opened while another was open");
                open = Some(match item {
                    ResponseItem::Reasoning { .. } => "reasoning",
                    ResponseItem::Message { .. } => "message",
                    other => panic!("unexpected opened item: {other:?}"),
                });
            }
            Ok(ResponseEvent::ReasoningContentDelta { .. }) => {
                assert_eq!(open, Some("reasoning"), "a thinking delta with no item open");
            }
            Ok(ResponseEvent::OutputTextDelta(_)) => {
                assert_eq!(open, Some("message"), "a text delta with no item open");
            }
            Ok(ResponseEvent::OutputItemDone(_)) => open = None,
            _ => {}
        }
    }
    assert_eq!(open, None, "the last item was never closed");

    // Not vacuous: both kinds of delta really were produced.
    assert_eq!(deltas(&events), "answer");
    assert_eq!(assistant_text(&events).as_deref(), Some("answer"));
}

#[test]
fn a_usage_block_missing_a_count_is_no_usage_rather_than_a_zero() {
    // The gateway's own rule, and the reason the counts are optional: "a
    // fabricated zero would read downstream as a measurement and settle the
    // request at nothing". A defaulted 0 here is indistinguishable from a turn
    // that genuinely cost nothing, so nothing downstream can ever notice.
    let partial = r#"{"id":"c1","choices":[],"usage":{"prompt_tokens":100}}"#;
    let events = tokio_test::block_on(play(&[&text_delta("hi"), FINISH_STOP, partial, "[DONE]"]));
    let Some((usage, _)) = completion(&events) else {
        panic!("the turn completes");
    };
    assert!(
        usage.is_none(),
        "a usage block missing `total_tokens` must report no usage, got {usage:?}",
    );

    // And the complete block still reports, so this is not "usage never works".
    let events = tokio_test::block_on(play(&[&text_delta("hi"), FINISH_STOP, USAGE_ONLY, "[DONE]"]));
    let Some((usage, _)) = completion(&events) else {
        panic!("the turn completes");
    };
    assert!(usage.is_some());
}
