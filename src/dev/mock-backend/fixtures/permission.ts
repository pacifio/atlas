// Fixtures for a mock `permission_request` delta — the `tool_call` / `options`
// shape Rust puts on the wire for it (`permission_tool_call` /
// `permission_options`, `crates/atlas-agent-delta/src/project.rs:394-402`
// and `:370-391`):
//
//   tool_call: { toolCallId, title, kind, status: "pending", rawInput }
//   options:   [{ optionId, name, kind }, ...]   (kind: allow_once |
//              allow_always | reject_once | reject_always, flattened from
//              whatever shape the agent sent)
//
// `permission-modal.tsx` reads three things out of `rawInput` (via
// `extractPlanMarkdown` / `extractQuestions`) to pick which of its three
// layouts to render, so these builders cover all three: a plain tool call, an
// `ExitPlanMode` plan, and Claude's `AskUserQuestion` bridge.

import type { PermissionOptionRef, ToolCallRef } from "@/types/acp";

/** The four options a plain command approval offers. Naming one after another
 *  agent's own brand ("Codex") exercises `permission-modal.tsx`'s
 *  `relabelAgentBrand` — codex-acp's real copy does exactly this
 *  ("No, and tell Codex what to do differently"). */
export function standardOptions(subject: string): PermissionOptionRef[] {
  return [
    { optionId: "allow_once", name: "Yes", kind: "allow_once" },
    {
      optionId: "allow_always",
      name: `Yes, and don't ask again for ${subject}`,
      kind: "allow_always",
    },
    { optionId: "reject_once", name: "No", kind: "reject_once" },
    {
      optionId: "reject_always",
      name: "No, and tell Codex what to do differently",
      kind: "reject_always",
    },
  ];
}

/** A long, multi-line shell pipeline — long enough (single lines over 80
 *  chars, several of them) to check the tool-call preview wraps it instead of
 *  overflowing the card. */
export const LONG_COMMAND = [
  "find . -type f \\( -name '*.spec.ts' -o -name '*.test.ts' \\) -not -path './node_modules/*' -not -path './dist/*'",
  "  -exec grep -l 'describe.only\\|it.only\\|test.only' {} +",
  "  | xargs -I{} sh -c 'echo === {} === && sed -n \"1,5p\" {} && echo'",
  "  | tee /tmp/focused-tests-report.txt",
].join("\n");

export const LONG_COMMAND_RESULT = [
  "=== src/features/chat/lib/questions.test.ts ===",
  'it.only("composes a single answer without a label when there is one question", () => {',
  "",
  "=== src/features/editor/lib/wikilinks.test.ts ===",
  'describe.only("wikilink escaping", () => {',
  "",
  "Wrote /tmp/focused-tests-report.txt",
].join("\n");

/** ExitPlanMode's plan markdown — long enough to exercise the plan panel's
 *  internal scroll. */
export const PLAN_MARKDOWN = `## Add a \`disabled\` prop to \`Button\`

1. Add \`disabled?: boolean\` to \`ButtonProps\` in \`src/components/button.tsx\`
   and forward it to the underlying \`<button>\`, along with a matching
   \`aria-disabled\`.
2. Update every call site that renders a submit/destructive action to pass
   \`disabled\` while its owning form is pending.
3. Extend \`button.test.tsx\` with a case that asserts the disabled state
   renders \`aria-disabled="true"\` and blocks the click handler.
4. Run the component test suite and fix anything that regresses.

\`\`\`ts
export function Button({ label, disabled }: { label: string; disabled?: boolean }) {
  return (
    <button className="btn" disabled={disabled} aria-disabled={disabled}>
      {label}
    </button>
  );
}
\`\`\`

No other components read \`ButtonProps\` directly, so this should be a
contained change.`;

/** The options Claude's ExitPlanMode approval offers — mirrors
 *  `exit-plan-modes.ts`'s `EXIT_PLAN_OPTION_MODE` keys. Deliberately omits a
 *  `bypass` option, the case that makes `permission-modal.tsx` add its own
 *  "Yes, and bypass permissions" row back (only visible for the `claude-code`
 *  agent type). */
export function exitPlanOptions(): PermissionOptionRef[] {
  return [
    { optionId: "exit-plan-default", name: "Yes, and auto-accept edits", kind: "allow_once" },
    {
      optionId: "exit-plan-accept-edits",
      name: "Yes, and ask before edits",
      kind: "allow_once",
    },
    { optionId: "reject_once", name: "No, keep planning", kind: "reject_once" },
  ];
}

/** Claude's `AskUserQuestion` input shape, bridged onto a permission tool
 *  call's `rawInput` — see `lib/questions.ts`'s `extractQuestions`. */
interface AskUserQuestionInput extends Record<string, unknown> {
  questions: {
    header?: string;
    question: string;
    multiSelect?: boolean;
    options: { label: string; description?: string }[];
  }[];
}

/** One question, three choices. The permission options are named after the
 *  same three choices, so answering it exercises `permission-modal.tsx`'s
 *  fast path: a single, unambiguous answer resolves a real ACP option instead
 *  of falling back to a composed free-text message. */
export function askUserQuestionSingle(): {
  rawInput: AskUserQuestionInput;
  options: PermissionOptionRef[];
} {
  const choices = ["Optimistic locking", "Pessimistic locking", "Skip for now"];
  return {
    rawInput: {
      questions: [
        {
          header: "Approach",
          question:
            "Two writers can race on the same row when a document is edited from two tabs. Which should I use?",
          multiSelect: false,
          options: choices.map((label) => ({ label })),
        },
      ],
    },
    options: choices.map((label, i) => ({ optionId: `q-${i}`, name: label, kind: "allow_once" })),
  };
}

/** Two questions, one multi-select — exercises the stepper's progress dots
 *  and the composed-free-text fallback (no permission option names the exact
 *  combination of answers, so it always sends a message instead). */
export function askUserQuestionMulti(): {
  rawInput: AskUserQuestionInput;
  options: PermissionOptionRef[];
} {
  return {
    rawInput: {
      questions: [
        {
          header: "Scope",
          question: "Which packages does this change touch?",
          multiSelect: true,
          options: [
            { label: "web", description: "The Vite frontend" },
            { label: "api", description: "The Tauri commands" },
            { label: "cli", description: "The standalone CLI" },
          ],
        },
        {
          header: "Tests",
          question: "Should I also update the snapshot tests?",
          multiSelect: false,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    },
    options: [
      { optionId: "allow_once", name: "Answer", kind: "allow_once" },
      { optionId: "reject_once", name: "Skip", kind: "reject_once" },
    ],
  };
}

/** The `tool_call` half of a `permission_request` delta. `toolName` and
 *  `content` are what an outward action's card reads (`outward-approval.ts`):
 *  the organisation tool's own name, and the recipient then the body as text
 *  blocks. Omitted for every other card, as the wire omits them. */
export function permissionToolCall(opts: {
  id: string;
  title: string;
  kind: string;
  rawInput: unknown;
  toolName?: string;
  content?: string[];
}): ToolCallRef {
  return {
    toolCallId: opts.id,
    title: opts.title,
    kind: opts.kind,
    status: "pending",
    rawInput: opts.rawInput,
    ...(opts.toolName ? { toolName: opts.toolName } : {}),
    ...(opts.content ? { content: opts.content } : {}),
  };
}

/** The three options the native seam offers on an outward reply
 *  (ADR-0014). Allow is a click on these cards, never a key. */
export function outwardOptions(): PermissionOptionRef[] {
  return [
    { optionId: "allow_once", name: "Post reply", kind: "allow_once" },
    {
      optionId: "allow_always",
      name: "Post, and don't ask again this session",
      kind: "allow_always",
    },
    { optionId: "reject_once", name: "Decline", kind: "reject_once" },
  ];
}
