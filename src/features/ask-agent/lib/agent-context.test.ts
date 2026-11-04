import { beforeEach, describe, expect, it } from "vitest";

import { composePrompt, toShortForm } from "@/features/chat/lib/mentions";
import { inlineQueuedText } from "@/features/chat/lib/queued-text";
import {
  forgetSentTexts,
  knownMention,
  rememberMention,
  resetMentionRegistryForTests,
} from "@/features/chat/lib/mention-registry";
import { tokenizeShortForms } from "@/features/chat/lib/composer-short-forms";
import {
  CONTEXT_BODY_MAX_CHARS,
  CONTEXT_LOG_MAX_CHARS,
  agentContextMention,
  contextAsText,
  contextLabel,
  withContextsInline,
  type AgentContext,
} from "./agent-context";

beforeEach(() => resetMentionRegistryForTests());

const file: AgentContext = {
  kind: "file_range",
  path: "src/lib/api.ts",
  startLine: 12,
  endLine: 14,
  excerpt: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
};
const hunk: AgentContext = {
  kind: "diff_hunk",
  path: "src/a.ts",
  hunk: "@@ -1,2 +1,2 @@\n-old\n+new",
  staged: true,
};
const memory: AgentContext = {
  kind: "memory_entry",
  id: "mem-7",
  memoryKind: "decision",
  text: "Sessions, not chats.",
  project: "atlas",
};
const commit: AgentContext = { kind: "commit", sha: "a1b2c3d4e5f6", subject: "Tighten header" };
const error: AgentContext = {
  kind: "error",
  source: "git push",
  message: "Push rejected",
  log: " ! [rejected] main -> main",
  command: "git push --progress",
  cwd: "/repo",
};
const quote: AgentContext = { kind: "quote", text: "some selected words", source: "Memory" };

describe("each kind, as the agent reads it", () => {
  it("names its source in the header and quotes the excerpt", () => {
    expect(contextAsText({ id: "f1", context: file })).toBe(
      "Context (@ctx:f1), `src/lib/api.ts`, lines 12–14:\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```",
    );
    expect(contextAsText({ id: "h1", context: hunk })).toBe(
      "Context (@ctx:h1), a staged diff hunk in `src/a.ts`:\n```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```",
    );
    expect(contextAsText({ id: "m1", context: memory })).toBe(
      "Context (@ctx:m1), decision memory `mem-7` in project atlas:\n```\nSessions, not chats.\n```",
    );
    expect(contextAsText({ id: "c1", context: commit })).toBe(
      "Context (@ctx:c1), commit `a1b2c3d4e5f6`: Tighten header",
    );
    expect(contextAsText({ id: "e1", context: error })).toBe(
      "Context (@ctx:e1), an error from git push, running `git push --progress`, in `/repo`:\n" +
        "```\nPush rejected\n```\nLog:\n```\n ! [rejected] main -> main\n```",
    );
    expect(contextAsText({ id: "q1", context: quote })).toBe(
      "Context (@ctx:q1), quoted text from Memory:\n```\nsome selected words\n```",
    );
  });

  it("fences an excerpt so its own backticks cannot close it", () => {
    const text = contextAsText({ id: "x", context: { kind: "quote", text: "a ```` b" } });
    expect(text).toContain("`````\na ```` b\n`````");
  });

  it("labels each chip on one short line", () => {
    expect(contextLabel(file)).toBe("src/lib/api.ts:12–14");
    expect(contextLabel({ ...file, endLine: 12 })).toBe("src/lib/api.ts:12");
    expect(contextLabel(hunk)).toBe("src/a.ts · staged hunk");
    expect(contextLabel(commit)).toBe("a1b2c3d Tighten header");
    expect(contextLabel(error)).toBe("git push error");
    expect(contextLabel(quote)).toBe("“some selected words”");
    expect(contextLabel({ ...memory, text: "x ".repeat(60) }).length).toBeLessThanOrEqual(40);
  });
});

describe("caps", () => {
  it("keeps a body's start and a log's end", () => {
    const m = agentContextMention({
      ...error,
      message: "m".repeat(CONTEXT_BODY_MAX_CHARS * 2),
      log: `start${"x".repeat(CONTEXT_LOG_MAX_CHARS)}FAILED`,
    });
    if (m.context.kind !== "error") throw new Error("kind");
    expect(m.context.message).toHaveLength(CONTEXT_BODY_MAX_CHARS);
    expect(m.context.log).toHaveLength(CONTEXT_LOG_MAX_CHARS);
    expect(m.context.log?.startsWith("…")).toBe(true);
    expect(m.context.log?.endsWith("FAILED")).toBe(true);
  });
});

describe("the chip", () => {
  it("writes `@ctx:<id>` and comes back as itself from the registry", () => {
    const m = agentContextMention(file, "k3x9q2");
    expect(toShortForm(m)).toBe("@ctx:k3x9q2");
    rememberMention(m, "/repo");
    expect(knownMention("@ctx:k3x9q2", "/repo")).toEqual(m);
    const doc = tokenizeShortForms("look @ctx:k3x9q2 here", {
      known: (t) => knownMention(t.raw, "/repo"),
      rebuilt: () => null,
    });
    expect(doc[1]).toMatchObject({ type: "sessionMention", attrs: { data: m } });
    forgetSentTexts([m]);
    expect(knownMention("@ctx:k3x9q2", "/repo")).toBeNull();
  });

  it("is written after the prose by composePrompt, without calling compose_prompt", async () => {
    const m = agentContextMention(commit, "c1");
    const composed = await composePrompt("Explain @ctx:c1", [m]);
    expect(composed).toEqual({
      prose: "Explain @ctx:c1\n\nContext (@ctx:c1), commit `a1b2c3d4e5f6`: Tighten header",
      resourceLinks: [],
      pastedTexts: [],
    });
  });

  it("is inlined on the plain-text paths too", () => {
    const m = agentContextMention(quote, "q1");
    const inlined = withContextsInline("Hi @ctx:q1", [m]);
    expect(inlined).toBe(`Hi @ctx:q1\n\n${contextAsText(m)}`);
    expect(inlineQueuedText("Hi @ctx:q1", [m])).toBe(inlined);
    expect(withContextsInline("Hi", [])).toBe("Hi");
  });
});
