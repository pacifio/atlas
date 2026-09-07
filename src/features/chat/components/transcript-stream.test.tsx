// @vitest-environment happy-dom
//
// End-to-end repro for "the answer freezes part-way and lands all at once".
//
// Drives the transcript the way a real turn does — one immutable `messages`
// array per applied frame, the trailing assistant message growing by a few
// tokens each time — and asserts the DOM has the whole text after every frame.
// A freeze shows up as the rendered text staying behind the source.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Transcript } from "./transcript";
import type { ChatMessage } from "@/types/agent";

afterEach(cleanup);

const ANSWER = `Here are five jokes, one per language:

🇪🇸 **Spanish**

— ¿Por qué el libro de matemáticas estaba triste? — ¡Porque tenía demasiados problemas!

🇫🇷 **French**

— Qu'est-ce qu'un crocodile qui surveille les bagages ? — Un sac à dents !

🇩🇪 **German**

— Warum können Geister so schlecht lügen? — Weil man durch sie hindurchsehen kann!
`;

function msgs(assistantText: string): ChatMessage[] {
  return [
    {
      id: "u1",
      role: "user",
      content: "tell me a joke in 5 different languages",
      toolCalls: [],
      fileChanges: [],
      plan: null,
      timestamp: "2026-09-07T15:19:00.000Z",
    },
    {
      id: "a1",
      role: "assistant",
      content: assistantText,
      mode: "text",
      toolCalls: [],
      fileChanges: [],
      plan: null,
      timestamp: "2026-09-07T15:19:01.000Z",
    },
  ];
}

/** Let the rAF-coalesced split and the layout effects settle. */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Text as the reader sees it: whitespace-normalised, markdown markers gone. */
function visible(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("Transcript streaming", () => {
  it("keeps the rendered answer in step with the source, frame by frame", async () => {
    // Chunks of a few words, the shape a token stream actually has.
    const steps: string[] = [];
    for (let n = 4; n < ANSWER.length; n += 17) steps.push(ANSWER.slice(0, n));
    steps.push(ANSWER);

    const { container, rerender } = render(
      <Transcript
        tabId="t1"
        acpSessionId="s1"
        messages={msgs(steps[0])}
        isStreaming
        agentType="claude-code"
      />,
    );
    await settleFrame();

    const behind: string[] = [];
    for (const step of steps) {
      rerender(
        <Transcript
          tabId="t1"
          acpSessionId="s1"
          messages={msgs(step)}
          isStreaming
          agentType="claude-code"
        />,
      );
      await settleFrame();

      // The last few words of the source must be on screen. Compare on words:
      // markdown markers are consumed by the renderer, and the tail repair may
      // legitimately hide a marker that is still arriving.
      const words = step
        .replace(/[*_`~#]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      const lastWord = words[words.length - 1];
      const shown = visible(container);
      if (lastWord && lastWord.length > 2 && !shown.includes(lastWord)) {
        behind.push(`len ${step.length}: missing ${JSON.stringify(lastWord)}`);
      }
    }

    expect(behind).toEqual([]);
  });

  it("shows the whole answer once the turn settles", async () => {
    const { container, rerender } = render(
      <Transcript tabId="t2" acpSessionId="s2" messages={msgs("Here")} isStreaming />,
    );
    await settleFrame();
    rerender(
      <Transcript tabId="t2" acpSessionId="s2" messages={msgs(ANSWER)} isStreaming={false} />,
    );
    await settleFrame();
    expect(visible(container)).toContain("Warum können Geister so schlecht lügen");
  });
});
