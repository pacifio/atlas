//! Agent runner: the core agentic loop.

use crate::compact;
use crate::events::{AgentControl, AgentEvent};
use crate::{Agent, AgentOutput, ToolCallRecord};
use cersei_hooks::{HookAction, HookContext, HookEvent};
use cersei_provider::{CompletionRequest, ProviderOptions, StreamAccumulator};
use cersei_tools::permissions::{PermissionDecision, PermissionRequest};
use cersei_tools::{ToolContext, ToolResult};
use cersei_types::*;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

// ─── Tool result size management ─────────────────────────────────────────────

/// Maximum number of lines to keep in a tool result before truncation.
const MAX_HEAD_LINES: usize = 80;
const MAX_TAIL_LINES: usize = 80;
/// Char-based fallback for results without many newlines.
const MAX_SINGLE_RESULT_CHARS: usize = 20_000;

/// Truncate an individual tool result using a head+tail line strategy.
/// Keeps the first N and last N lines, which preserves both the command
/// context (head) and error messages (tail) — errors are usually at the end.
fn cap_tool_result(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    // Line-based truncation if enough lines
    if total_lines > MAX_HEAD_LINES + MAX_TAIL_LINES + 5 {
        let head: String = lines[..MAX_HEAD_LINES].join("\n");
        let tail: String = lines[total_lines.saturating_sub(MAX_TAIL_LINES)..].join("\n");
        let omitted = total_lines - MAX_HEAD_LINES - MAX_TAIL_LINES;
        return format!(
            "{head}\n\n[... {omitted} lines omitted ({total_lines} total). Pipe through `head` or `tail` for specific sections ...]\n\n{tail}"
        );
    }

    // Char-based fallback for single long lines or binary-ish output
    if content.len() > MAX_SINGLE_RESULT_CHARS {
        // Floor/ceil the cut points to char boundaries so we never slice
        // through a multibyte UTF-8 sequence (which would panic).
        let mut head_end = MAX_SINGLE_RESULT_CHARS * 70 / 100;
        while head_end > 0 && !content.is_char_boundary(head_end) {
            head_end -= 1;
        }
        let tail_chars = MAX_SINGLE_RESULT_CHARS * 20 / 100;
        let mut tail_start = content.len().saturating_sub(tail_chars);
        while tail_start < content.len() && !content.is_char_boundary(tail_start) {
            tail_start += 1;
        }
        let omitted = tail_start.saturating_sub(head_end);
        return format!(
            "{}\n\n[... {omitted} chars omitted ...]\n\n{}",
            &content[..head_end],
            &content[tail_start..]
        );
    }

    content.to_string()
}

/// Truncate oldest tool results when cumulative size exceeds budget.
/// Modifies messages in place.
pub fn apply_tool_result_budget(messages: &mut [Message], budget_chars: usize) {
    // Collect total tool result size
    let total: usize = messages
        .iter()
        .flat_map(|m| match &m.content {
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|b| {
                    if let ContentBlock::ToolResult { content, .. } = b {
                        Some(match content {
                            ToolResultContent::Text(t) => t.len(),
                            ToolResultContent::Blocks(b) => b
                                .iter()
                                .map(|bb| {
                                    if let ContentBlock::Text { text } = bb {
                                        text.len()
                                    } else {
                                        0
                                    }
                                })
                                .sum(),
                        })
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>(),
            _ => vec![],
        })
        .sum();

    if total <= budget_chars {
        return;
    }

    // Truncate oldest tool results first (skip the last KEEP_RECENT messages)
    let keep_recent = 6; // don't touch recent tool results
    let truncatable_end = messages.len().saturating_sub(keep_recent);
    let mut freed = 0usize;
    let target_free = total - budget_chars;

    for msg in messages[..truncatable_end].iter_mut() {
        if freed >= target_free {
            break;
        }
        if let MessageContent::Blocks(blocks) = &mut msg.content {
            for block in blocks.iter_mut() {
                if freed >= target_free {
                    break;
                }
                if let ContentBlock::ToolResult { content, .. } = block {
                    let size = match content {
                        ToolResultContent::Text(t) => t.len(),
                        ToolResultContent::Blocks(_) => 100,
                    };
                    if size > 200 {
                        freed += size;
                        *content = ToolResultContent::Text(
                            "[truncated — re-read file if needed]".to_string(),
                        );
                    }
                }
            }
        }
    }
}

/// Run the agent without streaming (blocking until complete).
pub async fn run_agent(agent: &Agent, prompt: &str) -> Result<AgentOutput> {
    let (event_tx, _event_rx) = mpsc::channel(512);
    let (_control_tx, control_rx) = mpsc::channel(64);

    let prompt = prompt.to_string();

    // Run in a background task and collect events
    let result = run_agent_streaming(agent, &prompt, event_tx, control_rx).await;

    match result {
        Ok(output) => {
            agent.emit(AgentEvent::Complete(output.clone()));
            Ok(output)
        }
        Err(e) => {
            agent.emit(AgentEvent::Error(e.to_string()));
            Err(e)
        }
    }
}

/// Core agentic loop with streaming events.
pub async fn run_agent_streaming(
    agent: &Agent,
    prompt: &str,
    event_tx: mpsc::Sender<AgentEvent>,
    mut control_rx: mpsc::Receiver<AgentControl>,
) -> Result<AgentOutput> {
    // Load session history (skip if messages were pre-populated via with_messages)
    if agent.messages.lock().is_empty() {
        if let (Some(memory), Some(session_id)) = (&agent.memory, &agent.session_id) {
            let history = memory.load(session_id).await?;
            if !history.is_empty() {
                let count = history.len();
                agent.messages.lock().extend(history);
                let _ = event_tx
                    .send(AgentEvent::SessionLoaded {
                        session_id: session_id.clone(),
                        message_count: count,
                    })
                    .await;
                agent.emit(AgentEvent::SessionLoaded {
                    session_id: session_id.clone(),
                    message_count: count,
                });
            }
        }
    } // end session load guard

    // Add user prompt (with exploration hint for analysis tasks)
    let is_analysis = prompt.contains("index")
        || prompt.contains("analyze")
        || prompt.contains("explore")
        || prompt.contains("understand")
        || prompt.contains("tell me about")
        || prompt.contains("summary");

    let expanded_prompt = if is_analysis {
        format!(
            "{}\n\n[system hint: The project_intel section in your context shows the most important files ranked by dependency graph analysis (tree-sitter). Use parallel Read calls to read those files — entry points, stores, commands, and type files listed there. Read at least 10 files before writing output. Focus on files with the most symbols and imports.]",
            prompt
        )
    } else {
        prompt.to_string()
    };

    agent.messages.lock().push(Message::user(&expanded_prompt));

    let mut tool_calls: Vec<ToolCallRecord> = Vec::new();
    let mut turn: u32 = 0;
    let mut last_stop_reason = StopReason::EndTurn;
    let mut _last_usage = Usage::default();
    let mut max_tokens_retries: u32 = 0;
    const MAX_TOKENS_RETRY_LIMIT: u32 = 3;
    let mut had_tool_use = false;
    let mut depth_nudge_sent = false;
    let mut benchmark_retries: u32 = 0;
    const BENCHMARK_MAX_RETRIES: u32 = 4;
    let mut doom_loop_warned = false;
    // ATLAS PATCH (doom-loop-input-hash-v1): after the user allows a run to
    // continue past an escalation, suppress re-detection until this many
    // tool calls have accumulated (a fresh 6-call window).
    let mut doom_suppress_until: usize = 0;
    let mut completion_verified = false;

    // Runtime guards
    let mut files_read: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tool_error_counts: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    const MAX_TOOL_ERRORS_PER_TOOL: u32 = 3;

    // Build tool context
    let tool_ctx = ToolContext {
        working_dir: agent.working_dir.clone(),
        session_id: agent
            .session_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        permissions: Arc::clone(&agent.permission_policy),
        cost_tracker: Arc::clone(&agent.cost_tracker),
        mcp_manager: agent.mcp_manager.clone(),
        extensions: agent.extensions.clone(),
    };

    // Agentic loop
    loop {
        turn += 1;
        if turn > agent.max_turns {
            break;
        }

        // Check cancellation
        if agent.cancel_token.is_cancelled() {
            return Err(CerseiError::Cancelled);
        }

        // ── Steering injection (ATLAS PATCH steering-queue-v1) ──
        // The tool-batch boundary: the previous round's results are settled
        // and the next model call hasn't been built. User messages queued
        // mid-run land here, so no message falls between a permission prompt
        // and its approval.
        for text in drain_steering(agent, &mut control_rx) {
            agent.messages.lock().push(Message::user(&text));
            let ev = AgentEvent::Steered { text };
            let _ = event_tx.send(ev.clone()).await;
            agent.emit(ev);
        }

        let _ = event_tx.send(AgentEvent::TurnStart { turn }).await;
        agent.emit(AgentEvent::TurnStart { turn });

        // Apply tool result budget to keep context manageable
        {
            let mut msgs = agent.messages.lock();
            apply_tool_result_budget(&mut msgs, agent.tool_result_budget);
        }

        // Build completion request
        let messages = agent.messages.lock().clone();
        let tool_defs: Vec<ToolDefinition> =
            agent.tools.iter().map(|t| t.to_definition()).collect();

        let model = agent
            .model
            .clone()
            .unwrap_or_else(|| "claude-sonnet-4-6".to_string());

        let mut options = ProviderOptions::default();
        if let Some(budget) = agent.thinking_budget {
            options.set("thinking_budget", budget);
        }
        // ATLAS PATCH (model-profile-v1): providers that express thinking as
        // an effort level (OpenAI o-series / gpt-5) read this option; the
        // budget-based ones ignore it.
        if let Some(effort) = &agent.reasoning_effort {
            options.set("reasoning_effort", effort.clone());
        }

        // Todo nudge: on turns > 2, remind model about incomplete todos
        let system_with_nudge = if turn > 2 {
            let session_id = agent.session_id.as_deref().unwrap_or("default");
            let todos = cersei_tools::todo_write::get_todos(session_id);
            let incomplete = todos
                .iter()
                .filter(|t| t.status != cersei_tools::todo_write::TodoStatus::Completed)
                .count();
            if incomplete > 0 {
                let nudge = format!(
                    "\n\n[system reminder: You have {} incomplete task{} in your TodoWrite list. Make sure to complete all tasks before ending your response. Use tools to make progress on each task.]",
                    incomplete,
                    if incomplete == 1 { "" } else { "s" }
                );
                agent.system_prompt.as_ref().map(|s| format!("{s}{nudge}"))
            } else {
                agent.system_prompt.clone()
            }
        } else {
            agent.system_prompt.clone()
        };

        let request = CompletionRequest {
            model: model.clone(),
            messages: messages.clone(),
            system: system_with_nudge,
            tools: tool_defs,
            max_tokens: agent.max_tokens,
            temperature: agent.temperature,
            stop_sequences: Vec::new(),
            options,
        };

        let _ = event_tx
            .send(AgentEvent::ModelRequestStart {
                turn,
                message_count: messages.len(),
                token_estimate: 0,
            })
            .await;

        // ATLAS PATCH (retry-classified-v1): ONE classified attempt loop for
        // both failure surfaces. `provider.complete()` errors (connection /
        // DNS / TLS) were retried before, but HTTP 429/529/503 never reached
        // that path — the SSE task reports a non-success status as a
        // `StreamEvent::Error` INSIDE the stream, which used to fail the whole
        // turn instantly. Both now flow into `crate::retry::schedule_for`
        // (Zed's table), the backoff races the cancel token (a Stop during
        // backoff resolves immediately), and each attempt continues from the
        // SAME `agent.messages` history — resume, not replay. The per-call
        // counter resets naturally on any successful call, so a completed
        // tool round restores the full retry budget.
        enum CallOutcome {
            Done(cersei_provider::CompletionResponse),
            Failed(String),
        }
        let mut attempt: u32 = 0;
        let response = loop {
            let outcome = match agent.provider.complete(request.clone()).await {
                Err(e) => CallOutcome::Failed(e.to_string()),
                Ok(stream) => {
                    let mut rx = stream.into_receiver();
                    let mut accumulator = StreamAccumulator::new();
                    let _ = event_tx
                        .send(AgentEvent::ModelResponseStart {
                            turn,
                            model: model.clone(),
                        })
                        .await;

                    // Process stream events (with cancellation support)
                    let mut stream_error: Option<String> = None;
                    loop {
                        tokio::select! {
                            event = rx.recv() => {
                                match event {
                                    Some(event) => {
                                        match &event {
                                            StreamEvent::TextDelta { text, .. } => {
                                                let _ = event_tx.send(AgentEvent::TextDelta(text.clone())).await;
                                                agent.emit(AgentEvent::TextDelta(text.clone()));
                                            }
                                            StreamEvent::ThinkingDelta { thinking, .. } => {
                                                let _ = event_tx
                                                    .send(AgentEvent::ThinkingDelta(thinking.clone()))
                                                    .await;
                                                agent.emit(AgentEvent::ThinkingDelta(thinking.clone()));
                                            }
                                            StreamEvent::Error { message } => {
                                                stream_error = Some(message.clone());
                                                break;
                                            }
                                            _ => {}
                                        }
                                        accumulator.process_event(event);
                                    }
                                    None => break, // Stream ended
                                }
                            }
                            _ = agent.cancel_token.cancelled() => {
                                return Err(CerseiError::Cancelled);
                            }
                        }
                    }

                    match stream_error {
                        Some(msg) => CallOutcome::Failed(msg),
                        None => match accumulator.into_response() {
                            Ok(r) => CallOutcome::Done(r),
                            Err(e) => {
                                CallOutcome::Failed(format!("failed to decode response: {e}"))
                            }
                        },
                    }
                }
            };

            match outcome {
                CallOutcome::Done(r) => break r,
                CallOutcome::Failed(msg) => {
                    attempt += 1;
                    let Some(schedule) = crate::retry::schedule_for(&msg) else {
                        // Auth / fatal / unrecognized: surface immediately.
                        return Err(CerseiError::Provider(msg));
                    };
                    if attempt >= schedule.max_attempts {
                        return Err(CerseiError::Provider(format!(
                            "{msg} (gave up after {attempt} attempts)"
                        )));
                    }
                    let delay = schedule.delay(attempt);
                    tracing::warn!(
                        "Provider error (attempt {}/{}): {}. Retrying in {:?}...",
                        attempt,
                        schedule.max_attempts,
                        msg,
                        delay
                    );
                    let retry_ev = AgentEvent::Retry {
                        attempt,
                        max_attempts: schedule.max_attempts,
                        delay_ms: delay.as_millis() as u64,
                        last_error: msg,
                    };
                    let _ = event_tx.send(retry_ev.clone()).await;
                    agent.emit(retry_ev);
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = agent.cancel_token.cancelled() => {
                            return Err(CerseiError::Cancelled);
                        }
                    }
                }
            }
        };
        last_stop_reason = response.stop_reason.clone();
        _last_usage = response.usage.clone();

        // Update cumulative usage
        agent.cumulative_usage.lock().merge(&response.usage);
        agent.cost_tracker.add_with_model(&response.usage, &model);

        // Emit cost update
        let cumulative = agent.cumulative_usage.lock().clone();
        let _ = event_tx
            .send(AgentEvent::CostUpdate {
                turn_cost: response.usage.cost_usd.unwrap_or(0.0),
                cumulative_cost: cumulative.cost_usd.unwrap_or(0.0),
                input_tokens: cumulative.input_tokens,
                output_tokens: cumulative.output_tokens,
            })
            .await;
        agent.emit(AgentEvent::CostUpdate {
            turn_cost: response.usage.cost_usd.unwrap_or(0.0),
            cumulative_cost: cumulative.cost_usd.unwrap_or(0.0),
            input_tokens: cumulative.input_tokens,
            output_tokens: cumulative.output_tokens,
        });

        // Add assistant message to history
        agent.messages.lock().push(response.message.clone());

        // Fire PostModelTurn hooks
        let hook_ctx = HookContext {
            event: HookEvent::PostModelTurn,
            tool_name: None,
            tool_input: None,
            tool_result: None,
            tool_is_error: None,
            turn,
            cumulative_cost_usd: cumulative.cost_usd.unwrap_or(0.0),
            message_count: agent.messages.lock().len(),
        };
        let hook_action = cersei_hooks::run_hooks(&agent.hooks, &hook_ctx).await;
        if let HookAction::Block(reason) = hook_action {
            return Err(CerseiError::Provider(format!(
                "Blocked by hook: {}",
                reason
            )));
        }

        // Fire TurnsElapsed every `turns_elapsed_cadence` turns (default 10).
        // Callers can register a SkillNudgeHook here for agent-curated skill
        // creation without blocking the agent loop.
        if turn > 0 && turn % agent.turns_elapsed_cadence == 0 {
            let cadence_ctx = HookContext {
                event: HookEvent::TurnsElapsed,
                tool_name: None,
                tool_input: None,
                tool_result: None,
                tool_is_error: None,
                turn,
                cumulative_cost_usd: cumulative.cost_usd.unwrap_or(0.0),
                message_count: agent.messages.lock().len(),
            };
            // Don't block on TurnsElapsed hooks — best-effort, fire and forget.
            let _ = cersei_hooks::run_hooks(&agent.hooks, &cadence_ctx).await;
        }

        let _ = event_tx
            .send(AgentEvent::TurnComplete {
                turn,
                stop_reason: response.stop_reason.clone(),
                usage: response.usage.clone(),
            })
            .await;
        agent.emit(AgentEvent::TurnComplete {
            turn,
            stop_reason: response.stop_reason.clone(),
            usage: response.usage.clone(),
        });

        // Handle stop reason
        match &response.stop_reason {
            StopReason::EndTurn => {
                // ── Completion verification nudge ──
                // If agent is finishing but hasn't verified its output, nudge once.
                if agent.benchmark_mode && !completion_verified && turn >= 3 {
                    let recent_has_verify = tool_calls.iter().rev().take(5).any(|tc| {
                        let cmd = tc
                            .input
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        cmd.contains("cat ")
                            || cmd.contains("python ")
                            || cmd.contains("test")
                            || cmd.contains("verify")
                            || cmd.contains("node ")
                            || cmd.contains("./")
                            || cmd.contains("check")
                    });
                    if !recent_has_verify {
                        completion_verified = true;
                        agent.messages.lock().push(Message::user(
                            "[system] Before finishing, verify your solution is correct:\n\
                             1. Check that all expected output files exist and have correct content\n\
                             2. Run your solution to confirm it produces the right output\n\
                             3. Re-read the original instruction — did you satisfy EVERY requirement?"
                        ));
                        let _ = event_tx
                            .send(AgentEvent::Status(
                                "Nudging agent to verify before completion".into(),
                            ))
                            .await;
                        continue;
                    }
                }

                // ── Benchmark self-verification ──
                // In TB 2.0 tests are run externally by the verifier AFTER the agent
                // finishes. We only intervene if:
                // 1) The instruction mentions a specific test/verify command — nudge
                //    the agent to run it if it hasn't.
                // 2) The agent ran such a command and it failed — nudge to retry.
                // We do NOT hardcode /tests/run-tests.sh — that path doesn't exist
                // during agent execution in TB 2.0.
                if agent.benchmark_mode && benchmark_retries < BENCHMARK_MAX_RETRIES {
                    // Check if the instruction mentions a verification command
                    let has_instruction_tests = prompt.contains("test_outputs.py")
                        || prompt.contains("run_tests")
                        || prompt.contains("run-tests")
                        || prompt.contains("pytest")
                        || prompt.contains("verify.py")
                        || prompt.contains("check.py")
                        || prompt.contains("npm test")
                        || prompt.contains("cargo test")
                        || prompt.contains("make test");

                    if has_instruction_tests {
                        let verification = benchmark_check_tests(&tool_calls);
                        match verification {
                            BenchmarkVerification::TestsNotRun => {
                                if benchmark_retries == 0 {
                                    benchmark_retries += 1;
                                    agent.messages.lock().push(Message::user(
                                        "[system] The task instruction mentions a verification command. \
                                         Run it now to check your solution. Look at the instruction again \
                                         for the exact command."
                                    ));
                                    let _ = event_tx
                                        .send(AgentEvent::Status(
                                            "Benchmark: nudge to run instruction's test command"
                                                .into(),
                                        ))
                                        .await;
                                    continue;
                                }
                                break;
                            }
                            BenchmarkVerification::TestsFailed(ref test_output) => {
                                benchmark_retries += 1;
                                let truncated: String = test_output.chars().take(3000).collect();
                                agent.messages.lock().push(Message::user(
                                    &format!(
                                        "[system] Verification FAILED (attempt {}/{}).\n\n\
                                         Output:\n```\n{}\n```\n\n\
                                         Try a COMPLETELY DIFFERENT approach. Do NOT patch — rewrite.",
                                        benchmark_retries, BENCHMARK_MAX_RETRIES, truncated
                                    )
                                ));
                                let _ = event_tx
                                    .send(AgentEvent::Status(format!(
                                        "Benchmark: retry {}/{}",
                                        benchmark_retries, BENCHMARK_MAX_RETRIES
                                    )))
                                    .await;
                                continue;
                            }
                            BenchmarkVerification::TestsPassed => {
                                break;
                            }
                        }
                    }
                    // No test command in instruction — let the agent finish.
                    // The external verifier will run tests after.
                }

                // Depth nudge: if we had tool calls but ended very early (turn <= 3),
                // push the model to explore deeper before giving final answer.
                // This prevents shallow 1-round analysis. Only nudge once.
                if had_tool_use && turn <= 4 && !depth_nudge_sent {
                    depth_nudge_sent = true;
                    agent.messages.lock().push(Message::user(
                        "[system] Your analysis is not deep enough yet. You MUST read actual source code files before writing a summary. Use Read to examine at least 8-10 source files (stores, components, commands, types, configs). Use parallel Read calls. Do NOT write the final output until you have read enough source files to provide specific details about implementations, not just file names."
                    ));
                    continue; // Don't break — force another round
                }

                // ── Steering drain-on-finish (ATLAS PATCH steering-queue-v1) ──
                // A course-correction that arrived while the final round
                // streamed is the next thing to do, not a lost message: inject
                // it and keep the loop alive instead of finishing around it.
                let steered = drain_steering(agent, &mut control_rx);
                if !steered.is_empty() {
                    for text in steered {
                        agent.messages.lock().push(Message::user(&text));
                        let ev = AgentEvent::Steered { text };
                        let _ = event_tx.send(ev.clone()).await;
                        agent.emit(ev);
                    }
                    continue;
                }
                break;
            }
            StopReason::ToolUse => {
                max_tokens_retries = 0;
                had_tool_use = true;
                // Process tool calls
                let tool_use_blocks: Vec<(String, String, serde_json::Value)> = response
                    .message
                    .content_blocks()
                    .into_iter()
                    .filter_map(|b| {
                        if let ContentBlock::ToolUse { id, name, input } = b {
                            Some((id, name, input))
                        } else {
                            None
                        }
                    })
                    .collect();

                // Phase 1: Emit ToolStart events for all tools
                for (tool_id, tool_name, tool_input) in &tool_use_blocks {
                    let _ = event_tx
                        .send(AgentEvent::ToolStart {
                            name: tool_name.clone(),
                            id: tool_id.clone(),
                            input: tool_input.clone(),
                        })
                        .await;
                    agent.emit(AgentEvent::ToolStart {
                        name: tool_name.clone(),
                        id: tool_id.clone(),
                        input: tool_input.clone(),
                    });
                }

                // Phase 2: Execute all tools in PARALLEL via join_all
                let msg_count = agent.messages.lock().len();
                let exec_futures: Vec<_> = tool_use_blocks
                    .iter()
                    .map(|(tool_id, tool_name, tool_input)| {
                        let tool_name = tool_name.clone();
                        let tool_id = tool_id.clone();
                        let tool_input = tool_input.clone();
                        let tool_ctx = tool_ctx.clone();
                        let permission_policy = Arc::clone(&agent.permission_policy);
                        let hooks = agent.hooks.clone();
                        let cumulative_cost = cumulative.cost_usd.unwrap_or(0.0);

                        // Find tool reference by name
                        let tool_idx = agent.tools.iter().position(|t| t.name() == tool_name);

                        async move {
                            let start = Instant::now();

                            let result = if let Some(idx) = tool_idx {
                                let tool = &agent.tools[idx];
                                // Check permissions
                                let perm_req = PermissionRequest {
                                    tool_name: tool_name.clone(),
                                    tool_input: tool_input.clone(),
                                    permission_level: tool.permission_level(),
                                    description: format!("Execute tool '{}'", tool_name),
                                    id: tool_id.clone(),
                                };

                                let decision = permission_policy.check(&perm_req).await;

                                match decision {
                                    PermissionDecision::Allow
                                    | PermissionDecision::AllowOnce
                                    | PermissionDecision::AllowForSession => {
                                        let hook_ctx = HookContext {
                                            event: HookEvent::PreToolUse,
                                            tool_name: Some(tool_name.clone()),
                                            tool_input: Some(tool_input.clone()),
                                            tool_result: None,
                                            tool_is_error: None,
                                            turn,
                                            cumulative_cost_usd: cumulative_cost,
                                            message_count: msg_count,
                                        };
                                        let hook_action =
                                            cersei_hooks::run_hooks(&hooks, &hook_ctx).await;

                                        match hook_action {
                                            HookAction::Block(reason) => ToolResult::error(
                                                format!("Blocked by hook: {}", reason),
                                            ),
                                            HookAction::ModifyInput(new_input) => {
                                                tool.execute(new_input, &tool_ctx).await
                                            }
                                            _ => tool.execute(tool_input.clone(), &tool_ctx).await,
                                        }
                                    }
                                    PermissionDecision::Deny(reason) => {
                                        ToolResult::error(format!("Permission denied: {}", reason))
                                    }
                                }
                            } else {
                                ToolResult::error(format!("Unknown tool: {}", tool_name))
                            };

                            let duration = start.elapsed();
                            (tool_id, tool_name, tool_input, result, duration)
                        }
                    })
                    .collect();

                // ATLAS PATCH (tool-cancel-race-v1): race the parallel tool
                // round against the cancel token. Unpatched, `tool.execute()`
                // was never raced — a running Bash/Edit completed (and its
                // writes landed) long after the user hit Stop. On cancel we
                // drop the tool futures (tools that spawn subprocesses must
                // reap them on drop — see atlas BashTool's process-group kill)
                // and synthesize a paired cancelled ToolResult for EVERY
                // tool_use in this round: the assistant message holding the
                // tool_use blocks is already in history (pushed above), and a
                // tool_use without a matching tool_result is invalid provider
                // history for the next turn.
                let results = tokio::select! {
                    r = futures::future::join_all(exec_futures) => r,
                    _ = agent.cancel_token.cancelled() => {
                        let cancelled_blocks: Vec<ContentBlock> = tool_use_blocks
                            .iter()
                            .map(|(tool_id, _, _)| ContentBlock::ToolResult {
                                tool_use_id: tool_id.clone(),
                                content: ToolResultContent::Text(
                                    crate::TOOL_CANCELLED_MESSAGE.to_string(),
                                ),
                                is_error: Some(true),
                            })
                            .collect();
                        agent.messages.lock().push(Message::user_blocks(cancelled_blocks));
                        return Err(CerseiError::Cancelled);
                    }
                };

                // Phase 3: Process results sequentially (emit events, build result blocks)
                let mut result_blocks: Vec<ContentBlock> = Vec::new();

                for (tool_id, tool_name, tool_input, mut result, duration) in results {
                    // ── Guard: Read-before-edit ──
                    // Track files that have been read; block edits to unread files
                    if (tool_name == "Read" || tool_name == "read") && !result.is_error {
                        if let Some(path) = tool_input.get("file_path").and_then(|v| v.as_str()) {
                            files_read.insert(path.to_string());
                        }
                    }
                    if (tool_name == "Edit" || tool_name == "edit") && !result.is_error {
                        if let Some(path) = tool_input.get("file_path").and_then(|v| v.as_str()) {
                            if !files_read.contains(path) {
                                // Check if file exists — new files don't need prior read
                                let file_exists = std::path::Path::new(path).exists()
                                    || tool_ctx.working_dir.join(path).exists();
                                if file_exists {
                                    result = ToolResult::error(
                                        format!("You must Read '{}' before editing it. Read the file first to understand its current contents.", path)
                                    );
                                }
                            }
                        }
                    }

                    // ── Guard: Per-tool error counter with reflection ──
                    if result.is_error {
                        let count = tool_error_counts.entry(tool_name.clone()).or_insert(0);
                        *count += 1;
                        let remaining = MAX_TOOL_ERRORS_PER_TOOL.saturating_sub(*count);
                        result.content = format!(
                            "{}\n\n[Tool '{}' failed {} time(s). {} attempts remaining. Analyze the error and try a different approach.]",
                            result.content, tool_name, count, remaining
                        );
                    } else {
                        tool_error_counts.remove(&tool_name);
                    }

                    // Compress before emitting ToolEnd so the savings stats ride
                    // along on the event (error results are not compressed).
                    let (capped_content, compression) = if result.is_error {
                        (result.content.clone(), None)
                    } else {
                        let level = *agent.compression_level.lock();
                        let (compressed, stats) =
                            cersei_compression::compress_tool_output_with_stats(
                                &tool_name,
                                &tool_input,
                                &result.content,
                                level,
                            );
                        (cap_tool_result(&compressed), Some(stats))
                    };

                    // ATLAS PATCH (tool-result-metadata-v1): carry the
                    // structured half of the result onto the event. Upstream
                    // drops `ToolResult::metadata` here, so a tool that
                    // computes a real before/after has it thrown away one
                    // frame after computing it.
                    let _ = event_tx
                        .send(AgentEvent::ToolEnd {
                            name: tool_name.clone(),
                            id: tool_id.clone(),
                            result: result.content.clone(),
                            is_error: result.is_error,
                            duration,
                            compression,
                            metadata: result.metadata.clone(),
                        })
                        .await;
                    agent.emit(AgentEvent::ToolEnd {
                        name: tool_name.clone(),
                        id: tool_id.clone(),
                        result: result.content.clone(),
                        is_error: result.is_error,
                        duration,
                        compression,
                        metadata: result.metadata.clone(),
                    });

                    tool_calls.push(ToolCallRecord {
                        name: tool_name,
                        id: tool_id.clone(),
                        input: tool_input,
                        result: result.content.clone(),
                        is_error: result.is_error,
                        duration,
                    });
                    // ATLAS PATCH (tool-result-metadata-v1): a tool that
                    // produces an image says so in its metadata, and the block
                    // carries the image alongside the text. Upstream can only
                    // emit `Text`, so an image tool has no way to hand the
                    // model an image at all.
                    let content = match result
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("image"))
                        .and_then(|img| {
                            Some(cersei_types::ImageSource {
                                source_type: "base64".to_string(),
                                media_type: Some(img.get("media_type")?.as_str()?.to_string()),
                                data: Some(img.get("data")?.as_str()?.to_string()),
                                url: None,
                            })
                        }) {
                        Some(source) => ToolResultContent::Blocks(vec![
                            ContentBlock::Image { source },
                            ContentBlock::Text {
                                text: capped_content,
                            },
                        ]),
                        None => ToolResultContent::Text(capped_content),
                    };
                    result_blocks.push(ContentBlock::ToolResult {
                        tool_use_id: tool_id,
                        content,
                        is_error: Some(result.is_error),
                    });
                }

                // Add tool results as user message
                agent
                    .messages
                    .lock()
                    .push(Message::user_blocks(result_blocks));

                // ── Doom loop detection (ATLAS PATCH doom-loop-input-hash-v1) ──
                // Keys on (tool, input) and requires failures — a healthy
                // Read/Edit alternation over the same file no longer trips it.
                // First trigger nudges; a repeat after the nudge escalates to
                // a permission ask so the user decides whether the run
                // continues (OpenCode's move), instead of letting the model
                // thrash to the turn cap.
                if tool_calls.len() >= doom_suppress_until.max(3)
                    && doom_loop_pattern(&tool_calls)
                {
                    if !doom_loop_warned {
                        doom_loop_warned = true;
                        let ev = AgentEvent::DoomLoop { escalated: false };
                        let _ = event_tx.send(ev.clone()).await;
                        agent.emit(ev);
                        agent.messages.lock().push(Message::user(
                            "[system] You are stuck in a repetitive loop. Your recent tool calls \
                             are repeating the same pattern. STOP and reconsider:\n\
                             1. What exactly is going wrong? Read the error messages carefully.\n\
                             2. Is there a COMPLETELY different approach to this problem?\n\
                             3. Try a different tool, different arguments, or a different algorithm.\n\
                             Do NOT repeat the same commands."
                        ));
                        let _ = event_tx
                            .send(AgentEvent::Status(
                                "Doom loop detected — forcing new approach".into(),
                            ))
                            .await;
                    } else {
                        let ev = AgentEvent::DoomLoop { escalated: true };
                        let _ = event_tx.send(ev.clone()).await;
                        agent.emit(ev);
                        let recent: Vec<String> = tool_calls
                            .iter()
                            .rev()
                            .take(6)
                            .map(|tc| tc.name.clone())
                            .collect();
                        let ask = PermissionRequest {
                            tool_name: crate::DOOM_LOOP_ASK.to_string(),
                            tool_input: serde_json::json!({ "recent_tools": recent }),
                            permission_level: cersei_tools::PermissionLevel::Dangerous,
                            description: "The agent keeps repeating the same failing tool \
                                          calls after being told to change approach. Continue \
                                          anyway?"
                                .to_string(),
                            id: uuid::Uuid::new_v4().to_string(),
                        };
                        match agent.permission_policy.check(&ask).await {
                            PermissionDecision::Allow
                            | PermissionDecision::AllowOnce
                            | PermissionDecision::AllowForSession => {
                                // The user chose to let it run — give the
                                // model a fresh window before re-evaluating.
                                doom_loop_warned = false;
                                doom_suppress_until = tool_calls.len() + 6;
                            }
                            PermissionDecision::Deny(_) => {
                                agent.messages.lock().push(Message::user(
                                    "[system] Run stopped by the user after repeated failing \
                                     tool calls.",
                                ));
                                last_stop_reason = StopReason::EndTurn;
                                break;
                            }
                        }
                    }
                }
            }
            StopReason::MaxTokens => {
                max_tokens_retries += 1;
                if max_tokens_retries > MAX_TOKENS_RETRY_LIMIT {
                    break; // Give up after 3 retries
                }
                // ── Truncation guard (ATLAS PATCH max-tokens-guard-v1) ──
                // A length-stopped message can carry tool_use blocks whose
                // JSON was salvage-parsed from a truncated stream — it
                // validates but lies (Pi fails these closed for the same
                // reason). They are never executed (only ToolUse stops run
                // tools), but the assistant message holding them is already
                // in history: without paired tool_results the next model
                // call is invalid provider history. Fail each closed and
                // have the model re-issue the calls in full.
                match max_tokens_repair(&response.message) {
                    Some(repair) => agent.messages.lock().push(repair),
                    None => agent
                        .messages
                        .lock()
                        .push(Message::user("Continue from exactly where you stopped.")),
                }
            }
            _ => break,
        }

        // Auto-compact: check context utilization after each turn
        if agent.auto_compact {
            let model_name = agent.model.as_deref().unwrap_or("claude-sonnet-4-6");
            let tokens_used = compact::estimate_messages_tokens(&agent.messages.lock());
            // ATLAS PATCH (model-profile-v1): an explicit window from the
            // host beats the substring table (whose unknown-model default of
            // 200k makes small models overflow instead of compacting).
            let context_window = agent
                .context_window
                .unwrap_or_else(|| compact::context_window_for_model(model_name));
            let pct = if context_window > 0 {
                tokens_used as f64 / context_window as f64
            } else {
                0.0
            };

            // Emit token warnings
            if pct >= compact::WARNING_PCT {
                use crate::events::WarningState;
                let state = if pct >= compact::CRITICAL_PCT {
                    WarningState::Critical
                } else {
                    WarningState::Warning
                };
                let _ = event_tx
                    .send(AgentEvent::TokenWarning {
                        pct_used: pct,
                        state,
                    })
                    .await;
                agent.emit(AgentEvent::TokenWarning {
                    pct_used: pct,
                    state,
                });
            }

            // Auto-compact at the configured threshold: try LLM
            // summarization, fall back to snip.
            // ATLAS PATCH (model-profile-v1): honor the builder's
            // compact_threshold — it was stored and never read, so the knob
            // silently did nothing.
            if compact::should_compact_at(tokens_used, context_window, agent.compact_threshold) {
                let msgs_snapshot = agent.messages.lock().clone();
                let model_name_owned = model_name.to_string();

                // ATLAS PATCH (pre-compact-hook-v1): everything the summary
                // is about to lose gets one chance to persist (contract C1 —
                // the memory flush registers here). Runs on the full
                // snapshot, before any split point is chosen.
                if let Some(hook) = &agent.pre_compact {
                    hook(msgs_snapshot.clone()).await;
                }
                // ATLAS PATCH (pre-compact-hook-v1): CompactStart/CompactEnd
                // existed in the event enum but were never emitted, so
                // listeners keyed on them (Atlas resets its read-registry on
                // CompactEnd) never fired.
                let start_ev = AgentEvent::CompactStart {
                    reason: crate::events::CompactReason::ThresholdExceeded,
                    messages_before: msgs_snapshot.len(),
                };
                let _ = event_tx.send(start_ev.clone()).await;
                agent.emit(start_ev);

                // Try LLM-based summarization first
                let (messages_after, tokens_freed) = match compact::compact_conversation(
                    agent.provider.as_ref(),
                    &msgs_snapshot,
                    &model_name_owned,
                    compact::KEEP_RECENT_MESSAGES,
                    None,
                )
                .await
                {
                    Ok(result) if !result.summary.is_empty() => {
                        let mut msgs = agent.messages.lock();
                        let before = msgs.len();
                        let split_idx = msgs.len().saturating_sub(compact::KEEP_RECENT_MESSAGES);
                        let recent = msgs[split_idx..].to_vec();
                        *msgs = vec![Message::user(&result.summary)];
                        msgs.extend(recent);
                        tracing::info!(
                            "LLM compact: {before} → {} messages, freed ~{} tokens",
                            msgs.len(),
                            result.tokens_freed_estimate
                        );
                        (msgs.len(), result.tokens_freed_estimate)
                    }
                    _ => {
                        // Fallback: snip-compact (truncation)
                        let mut msgs = agent.messages.lock();
                        let before = msgs.len();
                        let (compacted, freed) = compact::snip_compact(
                            std::mem::take(&mut *msgs),
                            compact::KEEP_RECENT_MESSAGES,
                        );
                        *msgs = compacted;
                        tracing::info!(
                            "Snip compact (fallback): {before} → {} messages, freed ~{freed} tokens",
                            msgs.len()
                        );
                        (msgs.len(), freed)
                    }
                };
                let end_ev = AgentEvent::CompactEnd {
                    messages_after,
                    tokens_freed,
                };
                let _ = event_tx.send(end_ev.clone()).await;
                agent.emit(end_ev);
            }
        }
    }

    // Persist session
    if let (Some(memory), Some(session_id)) = (&agent.memory, &agent.session_id) {
        let messages = agent.messages.lock().clone();
        memory.store(session_id, &messages).await?;
        let _ = event_tx
            .send(AgentEvent::SessionSaved {
                session_id: session_id.clone(),
            })
            .await;
        agent.emit(AgentEvent::SessionSaved {
            session_id: session_id.clone(),
        });
    }

    // Build output
    let last_message = agent
        .messages
        .lock()
        .iter()
        .rev()
        .find(|m| m.role == Role::Assistant)
        .cloned()
        .unwrap_or_else(|| Message::assistant(""));

    let output = AgentOutput {
        message: last_message,
        usage: agent.cumulative_usage.lock().clone(),
        stop_reason: last_stop_reason,
        turns: turn,
        tool_calls,
    };

    // Notify reporters
    for reporter in &agent.reporters {
        reporter.on_complete(&output).await;
    }

    Ok(output)
}

// ─── Steering (ATLAS PATCH steering-queue-v1) ───────────────────────────────

/// Drain pending control messages into the agent's steering queue, then take
/// every queued steer. Called at the top of each loop iteration (the
/// tool-batch boundary) and once more before finishing on EndTurn.
fn drain_steering(agent: &Agent, control_rx: &mut mpsc::Receiver<AgentControl>) -> Vec<String> {
    while let Ok(ctrl) = control_rx.try_recv() {
        match ctrl {
            AgentControl::InjectMessage(m) => agent.steering.lock().push_back(m),
            AgentControl::Cancel => agent.cancel_token.cancel(),
            // Permission responses travel through the policy's own channel.
            AgentControl::PermissionResponse { .. } => {}
        }
    }
    agent.take_steered()
}

// ─── Doom loop detection (ATLAS PATCH doom-loop-input-hash-v1) ──────────────

/// Identity of a tool call for thrash detection: the tool name plus a hash of
/// its exact input. Names alone false-positive on healthy Read/Edit
/// alternation over the same file; byte-identical inputs are the signature of
/// a genuine loop.
fn doom_key(tc: &ToolCallRecord) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    tc.name.hash(&mut h);
    tc.input.to_string().hash(&mut h);
    h.finish()
}

/// Two thrash shapes over the most recent calls, both requiring failures:
/// 1. three consecutive identical (tool, input) calls, all errors;
/// 2. the same two identical calls alternating three times ([A,B]×3) with at
///    least two errors in the window.
fn doom_loop_pattern(tool_calls: &[ToolCallRecord]) -> bool {
    let recent: Vec<&ToolCallRecord> = tool_calls.iter().rev().take(6).collect();
    let keys: Vec<u64> = recent.iter().map(|tc| doom_key(tc)).collect();
    let errors: Vec<bool> = recent.iter().map(|tc| tc.is_error).collect();

    let three_identical = keys.len() >= 3
        && keys[0] == keys[1]
        && keys[1] == keys[2]
        && errors[..3].iter().all(|e| *e);

    let alternating = keys.len() >= 6
        && keys[0] == keys[2]
        && keys[2] == keys[4]
        && keys[1] == keys[3]
        && keys[3] == keys[5]
        && keys[0] != keys[1]
        && errors.iter().filter(|e| **e).count() >= 2;

    three_identical || alternating
}

// ─── MaxTokens truncation repair (ATLAS PATCH max-tokens-guard-v1) ──────────

/// The user message that repairs a MaxTokens-stopped assistant message
/// carrying tool_use blocks: one error tool_result per call (they were never
/// executed; their salvage-parsed arguments may be incomplete) plus a text
/// block telling the model to re-issue. `None` when the message carries no
/// tool_use — plain truncated prose just gets "continue".
fn max_tokens_repair(message: &Message) -> Option<Message> {
    let truncated_ids: Vec<String> = message
        .content_blocks()
        .into_iter()
        .filter_map(|b| {
            if let ContentBlock::ToolUse { id, .. } = b {
                Some(id)
            } else {
                None
            }
        })
        .collect();
    if truncated_ids.is_empty() {
        return None;
    }
    let mut blocks: Vec<ContentBlock> = truncated_ids
        .into_iter()
        .map(|id| ContentBlock::ToolResult {
            tool_use_id: id,
            content: ToolResultContent::Text(crate::MAX_TOKENS_TOOL_MESSAGE.to_string()),
            is_error: Some(true),
        })
        .collect();
    blocks.push(ContentBlock::Text {
        text: "Your response was cut off by the output-token limit. \
               Re-issue the last tool call(s) in full."
            .to_string(),
    });
    Some(Message::user_blocks(blocks))
}

// ─── Benchmark self-verification helpers ────────────────────────────────────

#[derive(Debug)]
enum BenchmarkVerification {
    TestsNotRun,
    TestsFailed(String), // carries the test output for retry feedback
    TestsPassed,
}

/// Analyze tool call history to determine if tests were run and whether they passed.
fn benchmark_check_tests(tool_calls: &[ToolCallRecord]) -> BenchmarkVerification {
    let test_patterns = [
        "run-tests",
        "run_tests",
        "pytest",
        "python -m pytest",
        "bash run-tests.sh",
        "npm test",
        "cargo test",
        "go test",
        "make test",
        "jest",
        "mocha",
        "unittest",
    ];

    let mut found_test_run = false;
    let mut last_test_failed = false;
    let mut last_test_output = String::new();

    // Check the most recent tool calls (last 30) for test execution
    for tc in tool_calls.iter().rev().take(30) {
        if tc.name != "Bash" && tc.name != "bash" {
            continue;
        }

        let cmd = tc
            .input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let is_test_cmd = test_patterns.iter().any(|p| cmd.contains(p));
        if !is_test_cmd {
            continue;
        }

        found_test_run = true;
        last_test_output = tc.result.clone();

        // Primary signal: exit code (most reliable)
        if tc.is_error {
            last_test_failed = true;
            break;
        }

        // Secondary: parse output for pass/fail indicators
        let result_lower = tc.result.to_lowercase();

        let has_pass = result_lower.contains("passed")
            || result_lower.contains("success")
            || result_lower.contains("all tests")
            || result_lower.contains("exit code 0")
            || tc.result.contains("PASSED")
            || tc.result.contains("PASS")
            || (result_lower.contains(" ok") && !result_lower.contains("not ok"));

        let has_failure = result_lower.contains("failed")
            || result_lower.contains("failure")
            || result_lower.contains("traceback")
            || result_lower.contains("not ok")
            || result_lower.contains("assertion")
            || (result_lower.contains("error")
                && !result_lower.contains("error handling")
                && !result_lower.contains("error_"));

        if has_failure && !has_pass {
            last_test_failed = true;
        } else {
            last_test_failed = false;
        }
        break; // Only care about the most recent test run
    }

    if !found_test_run {
        BenchmarkVerification::TestsNotRun
    } else if last_test_failed {
        BenchmarkVerification::TestsFailed(last_test_output)
    } else {
        BenchmarkVerification::TestsPassed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, input: serde_json::Value, is_error: bool) -> ToolCallRecord {
        ToolCallRecord {
            name: name.to_string(),
            id: "t".to_string(),
            input,
            result: String::new(),
            is_error,
            duration: std::time::Duration::ZERO,
        }
    }

    #[test]
    fn max_tokens_with_tool_use_fails_the_calls_closed() {
        // Pins the guard: a length-stopped message carrying tool_use blocks
        // gets one error tool_result per call + a re-issue instruction, so
        // provider history stays valid and the lying calls never run.
        let msg = Message::assistant_blocks(vec![
            ContentBlock::Text {
                text: "Editing now.".into(),
            },
            ContentBlock::ToolUse {
                id: "t1".into(),
                name: "Edit".into(),
                input: json!({"file_path": "a.rs", "old_string": "trunca"}),
            },
        ]);
        let repair = max_tokens_repair(&msg).expect("tool_use present → repair");
        let blocks = repair.content_blocks();
        let results: Vec<_> = blocks
            .iter()
            .filter_map(|b| {
                if let ContentBlock::ToolResult {
                    tool_use_id,
                    is_error,
                    ..
                } = b
                {
                    Some((tool_use_id.clone(), *is_error))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(results, [("t1".to_string(), Some(true))]);
        assert!(
            blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Text { text } if text.contains("Re-issue"))),
            "the model is told to re-issue the call"
        );
    }

    #[test]
    fn max_tokens_without_tool_use_needs_no_repair() {
        assert!(max_tokens_repair(&Message::assistant("just prose, cut off")).is_none());
    }

    #[test]
    fn healthy_read_edit_alternation_is_not_a_doom_loop() {
        // The old detector keyed on names alone and fired on exactly this:
        // Read/Edit over the same file with DIFFERENT inputs, no errors.
        let calls: Vec<ToolCallRecord> = (0..3)
            .flat_map(|i| {
                vec![
                    call("Read", json!({"file_path": format!("src/a{i}.rs")}), false),
                    call("Edit", json!({"file_path": format!("src/a{i}.rs"), "old_string": i.to_string()}), false),
                ]
            })
            .collect();
        assert!(!doom_loop_pattern(&calls));
    }

    #[test]
    fn three_identical_failing_calls_trip() {
        let calls: Vec<ToolCallRecord> = (0..3)
            .map(|_| call("Bash", json!({"command": "make build"}), true))
            .collect();
        assert!(doom_loop_pattern(&calls));
    }

    #[test]
    fn three_identical_succeeding_calls_do_not_trip() {
        let calls: Vec<ToolCallRecord> = (0..3)
            .map(|_| call("Read", json!({"file_path": "a.rs"}), false))
            .collect();
        assert!(!doom_loop_pattern(&calls));
    }

    #[test]
    fn identical_alternation_with_failures_trips() {
        let calls: Vec<ToolCallRecord> = (0..3)
            .flat_map(|_| {
                vec![
                    call("Read", json!({"file_path": "a.rs"}), false),
                    call("Edit", json!({"file_path": "a.rs", "old_string": "x"}), true),
                ]
            })
            .collect();
        assert!(doom_loop_pattern(&calls));
    }

    #[test]
    fn identical_alternation_without_failures_does_not_trip() {
        let calls: Vec<ToolCallRecord> = (0..3)
            .flat_map(|_| {
                vec![
                    call("Read", json!({"file_path": "a.rs"}), false),
                    call("Grep", json!({"pattern": "x"}), false),
                ]
            })
            .collect();
        assert!(!doom_loop_pattern(&calls));
    }

    #[test]
    fn same_tool_different_inputs_failing_does_not_trip() {
        // Legitimately iterating through variants of a failing command.
        let calls: Vec<ToolCallRecord> = (0..3)
            .map(|i| call("Bash", json!({"command": format!("test {i}")}), true))
            .collect();
        assert!(!doom_loop_pattern(&calls));
    }
}
