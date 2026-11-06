// A shared chat: the prompt and the response both carry cloud comments, so the
// action bars render with the comment pill in them. The layout to review is
// the bar under each node — pill flush with the bubble's edge on the prompt,
// under the first line on the response.

import type { Scenario } from "../types";
import type { Comment } from "@/features/artifacts/lib/comments-api";
import type { SessionMessage } from "@/types/agents";
import type { AnchorEntry } from "@/features/chat/lib/comment-anchors";
import { mockComment } from "../fixtures/artifacts";
import { selectionCommentBody } from "@/features/artifacts/lib/selection-comment";
import { text, thinking, tool, tools, user, t } from "../fixtures/chat";
import { setSeedTranscript } from "../fake-agent";

const transcript = [
  user("Why does the admin table refetch every time I switch windows?", t(0)),
  text(
    "It's the window `focus` listener in `main.tsx`, not the query: it invalidates every query on focus. Scoping it to the usage page stops the admin table refetching.",
    t(1),
  ),
];
const SESSION = "as-mock-chat";
const PROMPT_ROW = "am-prompt-1";
const RESPONSE_ROW = "am-response-1";
const CHECKPOINT_ROW = "cp-1";

const comments = [
  mockComment({
    id: "cc_1",
    sessionId: SESSION,
    anchorId: PROMPT_ROW,
    body: "Worth checking whether the billing table has the same problem.",
    authorId: "usr_sam",
  }),
  mockComment({
    id: "cc_2",
    sessionId: SESSION,
    anchorId: PROMPT_ROW,
    body: "Same question came up in #atlas-desktop yesterday.",
  }),
  mockComment({
    id: "cc_3",
    sessionId: SESSION,
    anchorId: RESPONSE_ROW,
    body: "Confirmed — dropping the listener stops the refetch.",
    authorId: "usr_tobi",
  }),
  mockComment({
    id: "cc_4",
    sessionId: SESSION,
    anchorId: RESPONSE_ROW,
    body: "Should the usage page keep refetch-on-focus?",
  }),
  mockComment({
    id: "cc_5",
    sessionId: SESSION,
    anchorId: RESPONSE_ROW,
    parentId: "cc_4",
    body: "Yes, those numbers need to be fresh.",
    authorId: "usr_sam",
  }),
];

/** A chat-comments scenario over `rows`, with `list` answering the comments
 *  call (or throwing, for the error variant). */
function commentScenario(
  name: string,
  description: string,
  list: () => Comment[],
  rows = transcript,
): Scenario {
  return {
    name,
    description,
    init: () => setSeedTranscript(rows),
    commands: {
      chat_comment_target: () => ({
        remoteProjectId: "rw_8c41f20b",
        sessionId: SESSION,
        entries: [
          { rowId: PROMPT_ROW, kind: "prompt", turnSeq: 1, nativeId: "prompt-1-x", toolName: null },
          // The response's native id is the wire message id, as capture records it.
          {
            rowId: RESPONSE_ROW,
            kind: "response",
            turnSeq: 1,
            nativeId: rows[1].id,
            toolName: null,
          },
          // A checkpoint row: never in the chat, so comments on it are orphans there.
          { rowId: CHECKPOINT_ROW, kind: "checkpoint", turnSeq: 1, nativeId: null, toolName: null },
        ],
      }),
      artifacts_cloud_comments: ({ sessionId }) => {
        if (String(sessionId) !== SESSION) return { byAnchor: {}, session: [] };
        const byAnchor: Record<string, Comment[]> = {};
        for (const c of list()) (byAnchor[c.anchorId] ??= []).push(c);
        return { byAnchor, session: [] };
      },
    },
  };
}

export const chatComments = commentScenario(
  "chat-comments",
  "A shared chat with comments on the prompt and the response.",
  () => comments,
);

/** Comments whose anchor row is not in the chat: one on a row that no longer
 *  exists, one on a checkpoint. The header badge counts them, the panel lists
 *  them as "A step", the transcript shows no pill for them. */
export const chatCommentsOrphan = commentScenario(
  "chat-comments-orphan",
  "Comments on a row the chat does not have (gone, and a checkpoint) beside one on the prompt.",
  () => [
    mockComment({ id: "co_1", sessionId: SESSION, anchorId: PROMPT_ROW, body: "on the prompt" }),
    mockComment({
      id: "co_2",
      sessionId: SESSION,
      anchorId: "am-gone",
      body: "row was retried away",
    }),
    mockComment({
      id: "co_3",
      sessionId: SESSION,
      anchorId: CHECKPOINT_ROW,
      anchorKind: "checkpoint",
      body: "on a checkpoint",
    }),
  ],
);

const MANY_BODIES = [
  "Does this cover the usage page too?",
  "Tested on staging, the refetch is gone.",
  "Can we get a regression test for this?",
  "Nice catch.",
  "Linked this from the retro notes.",
];

/** Sixty comments on the response from four people, a guest among them:
 *  the pill caps at "9+" with at most three faces; the popover scrolls. */
export const chatCommentsMany = commentScenario(
  "chat-comments-many",
  "Sixty comments from four people (one a guest) on the response.",
  () =>
    Array.from({ length: 60 }, (_, i) =>
      mockComment({
        id: `cm_${i}`,
        sessionId: SESSION,
        anchorId: RESPONSE_ROW,
        body: MANY_BODIES[i % MANY_BODIES.length],
        authorId: i % 4 === 3 ? null : ["usr_priya", "usr_sam", "usr_tobi"][i % 4],
        guestName: i % 4 === 3 ? "Guest Reviewer" : null,
        parentId: i > 0 && i % 5 === 0 ? "cm_0" : null,
      } as Partial<Comment> & { id: string }),
    ),
);

/** A deleted root with its two replies kept: the pill counts the two replies. */
export const chatCommentsRepliesOnly = commentScenario(
  "chat-comments-replies-only",
  "A deleted comment whose two replies remain, on the prompt.",
  () => [
    mockComment({
      id: "cr_1",
      sessionId: SESSION,
      anchorId: PROMPT_ROW,
      body: "",
      deletedAt: "2026-09-20T10:05:00.000Z",
    }),
    mockComment({
      id: "cr_2",
      sessionId: SESSION,
      anchorId: PROMPT_ROW,
      parentId: "cr_1",
      body: "reply one",
    }),
    mockComment({
      id: "cr_3",
      sessionId: SESSION,
      anchorId: PROMPT_ROW,
      parentId: "cr_1",
      body: "reply two",
      authorId: "usr_sam",
    }),
  ],
);

/** The comments read fails: no pills, no toast, no retry loop. */
export const chatCommentsError = commentScenario(
  "chat-comments-error",
  "The comments read fails: the chat shows no pills and no error.",
  () => {
    throw new Error("comments service unavailable");
  },
);

/**
 * A comment on a tool call inside a folded run — the case the "Worked" header
 * used to speak for.
 *
 * What to review: the fold's summary line ("Read files, ran commands") wears the
 * aggregate pill at its end, NOT the turn header above it, whose line belongs to
 * the prompt's action bar; opening the fold shows the pill on the third call,
 * which is the one that was discussed.
 */
const CALL_IDS = ["tcx-1", "tcx-2", "tcx-3"];
const toolTranscript = [
  user("Why is the retry helper swallowing the abort?", t(0)),
  thinking("Read the client, then find the call sites.", t(1)),
  tools(
    [
      tool.read("src/lib/api.ts", { id: CALL_IDS[0] }),
      tool.search("listUsers\\(", { id: CALL_IDS[1] }),
      tool.run("bun test src/lib", { id: CALL_IDS[2], result: "2 pass\n0 fail\n" }),
    ],
    t(2),
  ),
  text("`request()` catches the AbortError and retries it. I'll rethrow instead.", t(6)),
];

export const chatCommentsTools: Scenario = {
  name: "chat-comments-tools",
  description: "A comment on the third call of a folded tool run, and one on the response.",
  init: () => setSeedTranscript(toolTranscript),
  commands: {
    chat_comment_target: () => ({
      remoteProjectId: "rw_8c41f20b",
      sessionId: SESSION,
      entries: [
        { rowId: PROMPT_ROW, kind: "prompt", turnSeq: 1, nativeId: "prompt-1-x", toolName: null },
        { rowId: "am-think-1", kind: "thinking", turnSeq: 1, nativeId: null, toolName: null },
        { rowId: "tc-1", kind: "tool_call", turnSeq: 1, nativeId: CALL_IDS[0], toolName: "Read" },
        { rowId: "tc-2", kind: "tool_call", turnSeq: 1, nativeId: CALL_IDS[1], toolName: "Search" },
        { rowId: "tc-3", kind: "tool_call", turnSeq: 1, nativeId: CALL_IDS[2], toolName: "Bash" },
        {
          rowId: RESPONSE_ROW,
          kind: "response",
          turnSeq: 1,
          nativeId: toolTranscript[3].id,
          toolName: null,
        },
      ],
    }),
    artifacts_cloud_comments: () => ({
      byAnchor: {
        "tc-3": [
          mockComment({
            id: "ct_1",
            sessionId: SESSION,
            anchorKind: "tool_call",
            anchorId: "tc-3",
            body: "This is the command that was timing out in CI.",
          }),
          mockComment({
            id: "ct_2",
            sessionId: SESSION,
            anchorKind: "tool_call",
            anchorId: "tc-3",
            parentId: "ct_1",
            body: "Fixed by the rethrow below.",
            authorId: "usr_sam",
          }),
        ],
        [RESPONSE_ROW]: [
          mockComment({ id: "ct_3", sessionId: SESSION, anchorId: RESPONSE_ROW, body: "agreed" }),
        ],
      },
      session: [],
    }),
  },
};

// Long prose, code and a persisted passage comment: the selection toolbar and
// the whole-response hover control must stay near what the reader sees.
const longResponse = [
  "The window focus listener invalidates every query. Scope it to the usage page.",
  "",
  "```ts",
  "const onFocus = () => {",
  "  refreshUsage();",
  "};",
  "```",
  "",
  ...Array.from(
    { length: 16 },
    (_, i) =>
      `### Check ${i + 1}\n\nSwitch between windows and confirm the admin table retains its data. The usage page should still refresh on focus. This check belongs in the regression suite.`,
  ),
].join("\n");
export const chatCommentsSelection = commentScenario(
  "chat-comments-selection",
  "A long response with code and a persisted selection comment, for Cite/Comment and hover checks.",
  () => [
    ...comments,
    mockComment({
      id: "cc_selection",
      sessionId: SESSION,
      anchorId: RESPONSE_ROW,
      body: selectionCommentBody(
        "Scope it to the usage page.",
        "Should this cover the billing page as well?",
      ),
      authorId: "usr_sam",
    }),
  ],
  [transcript[0], text(longResponse, t(1))],
);

/** The same chat, not shared: no cloud target, so no comments. A click on the
 *  prose starts nothing, and neither the footer nor the selection pill offers
 *  Comment. Cite stays, without "Share with team". */
export const chatCommentsUnshared: Scenario = {
  name: "chat-comments-unshared",
  description: "A session that is not shared: nothing offers a comment.",
  init: () => setSeedTranscript(transcript),
  commands: {
    chat_comment_target: () => null,
  },
};

/**
 * A long shared chat — sixty turns, each a thinking step, a folded run of
 * three calls and a response with code — with threads spread from the top of
 * the thread to the bottom, on every kind of row (prompt, response, thinking,
 * a call inside a fold).
 *
 * What to review: clicking each thread in the footer's comments popup lands on
 * its row and opens the row's thread, however far above the rendered window
 * the row is and whether or not its fold was open. And it should feel instant.
 */
const LONG_TURNS = 60;
const longTurn = (i: number): SessionMessage[] => {
  const s = i * 30;
  return [
    user(
      `Turn ${i + 1}: why does step ${i + 1} of the import pipeline stall on large files?`,
      t(s),
    ),
    thinking(`Look at the reader for step ${i + 1}, then the chunker.`, t(s + 1)),
    tools(
      [
        tool.read(`src/import/step-${i + 1}.ts`, { id: `lc-${i}-0` }),
        tool.search(`chunk${i + 1}(`, { id: `lc-${i}-1` }),
        tool.run(`bun test src/import/step-${i + 1}`, {
          id: `lc-${i}-2`,
          result: "3 pass\n0 fail\n",
        }),
      ],
      t(s + 2),
    ),
    text(
      [
        `Step ${i + 1} reads the whole file before chunking, so memory grows with the input.`,
        "",
        "```ts",
        `export async function step${i + 1}(file: Blob) {`,
        "  for await (const chunk of file.stream()) {",
        "    await handle(chunk);",
        "  }",
        "}",
        "```",
        "",
        ...Array.from(
          { length: 4 },
          (_, k) =>
            `Paragraph ${k + 1}: streaming keeps the peak at one chunk. The tests cover a 2 GB fixture, and the progress bar now advances per chunk instead of jumping at the end.`,
        ),
      ].join("\n"),
      t(s + 20),
    ),
  ];
};
const longTranscript = Array.from({ length: LONG_TURNS }, (_, i) => longTurn(i)).flat();
const LONG_SESSION = "as-mock-long";
/** Where the threads hang: [turn, kind, comment]. */
const LONG_THREADS: [number, "prompt" | "response" | "thinking" | "tool", string][] = [
  [1, "prompt", "Long-thread: the second prompt, near the very top."],
  [4, "response", "Long-thread: a response early in the thread."],
  [8, "tool", "Long-thread: the search call inside turn nine's fold."],
  [13, "thinking", "Long-thread: the thinking step of turn fourteen."],
  [29, "response", "Long-thread: a response in the middle of the thread."],
  [57, "tool", "Long-thread: the test run near the bottom."],
];
const longRowId = (turn: number, kind: string) => `al-${turn}-${kind}`;

export const chatCommentsLong: Scenario = {
  name: "chat-comments-long",
  description:
    "Sixty turns with threads on prompts, responses, thinking and folded calls, top to bottom.",
  init: () => setSeedTranscript(longTranscript),
  commands: {
    chat_comment_target: () => ({
      remoteProjectId: "rw_8c41f20b",
      sessionId: LONG_SESSION,
      entries: Array.from({ length: LONG_TURNS }, (_, i): AnchorEntry[] => {
        const [, , run, response] = longTranscript.slice(i * 4, i * 4 + 4);
        return [
          {
            rowId: longRowId(i, "prompt"),
            kind: "prompt",
            turnSeq: i + 1,
            nativeId: null,
            toolName: null,
          },
          {
            rowId: longRowId(i, "thinking"),
            kind: "thinking",
            turnSeq: i + 1,
            nativeId: null,
            toolName: null,
          },
          ...run.tool_calls.map((c, k): AnchorEntry => ({
            rowId: longRowId(i, `tool-${k}`),
            kind: "tool_call",
            turnSeq: i + 1,
            nativeId: c.id,
            toolName: c.tool_name,
          })),
          {
            rowId: longRowId(i, "response"),
            kind: "response",
            turnSeq: i + 1,
            nativeId: response.id,
            toolName: null,
          },
        ];
      }).flat(),
    }),
    artifacts_cloud_comments: () => {
      const byAnchor: Record<string, Comment[]> = {};
      LONG_THREADS.forEach(([turn, kind, body], n) => {
        const anchorId = longRowId(
          turn,
          kind === "tool" ? (turn === 8 ? "tool-1" : "tool-2") : kind,
        );
        byAnchor[anchorId] = [
          mockComment({
            id: `cl_${n}`,
            sessionId: LONG_SESSION,
            anchorKind: kind === "tool" ? "tool_call" : undefined,
            anchorId,
            body,
            authorId: ["usr_priya", "usr_sam", "usr_tobi"][n % 3],
          } as Partial<Comment> & { id: string }),
        ];
      });
      return { byAnchor, session: [] };
    },
  },
};
