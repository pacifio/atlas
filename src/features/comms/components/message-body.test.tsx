// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { MessageBody } from "./message-body";
import { insertLink, linePrefix, wrap } from "../lib/markdown-insert";
import type { OrgMemberProfile } from "../types";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const ada: OrgMemberProfile = {
  id: "u_ada",
  name: "Ada Lovelace",
  email: "ada@x.test",
  role: "member",
};
const grace: OrgMemberProfile = {
  id: "u_grace",
  name: "Grace Hopper",
  email: "grace@x.test",
  role: "member",
};
const members = new Map([
  [ada.id, ada],
  [grace.id, grace],
]);

/**
 * Render and wait for the lazy impl to replace the plain-text fallback.
 *
 * Waits on the FALLBACK going away rather than on any particular rendered tag:
 * a body that is a bare HTML block produces no paragraph to wait for, and the
 * fallback's `whitespace-pre-wrap` is the one class the impl never emits.
 */
async function show(body: string, me = "u_ada") {
  const view = render(<MessageBody body={body} members={members} me={me} />);
  await waitFor(() => expect(view.container.querySelector(".whitespace-pre-wrap")).toBe(null));
  return view;
}

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

describe("MessageBody", () => {
  it("renders a mention as the member's name, not the stored id", async () => {
    const { container } = await show("hi <@u_grace>");
    const chip = await screen.findByText("@Grace Hopper");
    expect(chip.closest("[data-mention-pill]")?.getAttribute("title")).toBe("grace@x.test");
    expect(screen.queryByText(/u_grace/)).toBe(null);
    // The face is part of the pill, not just the name.
    expect(container.querySelector("[data-mention-pill] span[style*='background']")).not.toBe(null);
  });

  it("styles a mention of you differently from a mention of someone else", async () => {
    const { container } = await show("<@u_ada> and <@u_grace>", "u_ada");
    const pills = [...container.querySelectorAll("[data-mention-pill]")];
    expect(pills).toHaveLength(2);
    expect(pills[0].hasAttribute("data-mention-self")).toBe(true);
    expect(pills[1].hasAttribute("data-mention-self")).toBe(false);
  });

  it("names an unknown id honestly", async () => {
    await show("<@u_ghost>");
    expect(await screen.findByText("@unknown")).toBeTruthy();
  });

  it("always highlights a broadcast", async () => {
    const { container } = await show("@channel ship it", "u_ada");
    const chip = container.querySelector("[data-mention-pill][data-mention-self]");
    expect(chip?.textContent).toBe("@channel");
  });

  // The guarantee the whole design rests on.
  it("leaves a mention inside code as the literal token", async () => {
    const { container } = await show("try `<@u_grace>` here");
    expect(container.querySelector("code")?.textContent).toBe("<@u_grace>");
    expect(screen.queryByText("@Grace Hopper")).toBe(null);
  });

  it("renders the constructs the old parser could not", async () => {
    const { container: h } = await show("# Heading");
    expect(h.querySelector("h1")?.textContent).toBe("Heading");
    cleanup();

    const { container: t } = await show("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(t.querySelectorAll("td")).toHaveLength(2);
    // The wrapper is what lets a wide table scroll instead of crushing columns.
    expect(t.querySelector("table")?.parentElement?.className).toContain("overflow-x-auto");
    cleanup();

    const { container: n } = await show("- outer\n  - inner");
    expect(n.querySelectorAll("ul ul li")).toHaveLength(1);
    cleanup();

    const { container: c } = await show("- [x] done\n- [ ] todo");
    const boxes = [...c.querySelectorAll("input[type=checkbox]")];
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false]);
    // A message is immutable; a tickable box would misrepresent that.
    expect(boxes.every((b) => (b as HTMLInputElement).disabled)).toBe(true);
    cleanup();

    const { container: r } = await show("a\n\n---\n\nb");
    expect(r.querySelector("hr")).not.toBe(null);
  });

  it("keeps a single newline as a visible line break", async () => {
    const { container } = await show("one\ntwo\nthree");
    expect(container.querySelectorAll("br")).toHaveLength(2);
  });

  it("highlights a tagged fence and labels its language", async () => {
    const { container } = await show("```ts\nconst a = 1;\n```");
    expect(container.querySelector("pre")?.textContent).toContain("ts");
    expect(container.querySelector("code.hljs, code[class*='language-']")).not.toBe(null);
  });

  it("renders an image as a link, never an img", async () => {
    const { container } = await show("![a diagram](https://x.test/i.png)");
    expect(container.querySelector("img")).toBe(null);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://x.test/i.png");
  });

  describe("link hardening", () => {
    it("refuses a javascript: url", async () => {
      const { container } = await show("[x](javascript:alert(1))");
      expect(container.querySelector("a")?.getAttribute("href") || "").toBe("");
    });

    it("refuses a relative url, which would navigate the app frame away", async () => {
      const { container } = await show("[x](/etc/passwd)");
      expect(container.querySelector("a")?.getAttribute("href") || "").toBe("");
    });

    it("opens an allowed url in the system browser instead of navigating", async () => {
      const { container } = await show("[docs](https://example.test/a)");
      const a = container.querySelector("a") as HTMLAnchorElement;
      expect(a.getAttribute("href")).toBe("https://example.test/a");
      a.click();
      expect(openUrl).toHaveBeenCalledWith("https://example.test/a");
    });

    it("does not open a refused url on click", async () => {
      const { container } = await show("[x](javascript:alert(1))");
      (container.querySelector("a") as HTMLAnchorElement).click();
      expect(openUrl).not.toHaveBeenCalled();
    });
  });

  it("shows raw HTML as the characters someone typed", async () => {
    const { container } = await show("<script>alert(1)</script> and <b>not bold</b>");
    expect(container.querySelector("script")).toBe(null);
    expect(container.querySelector("b")).toBe(null);
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  // The toolbar and the renderer must not drift: drive the cases from the
  // functions the buttons actually call.
  it("renders everything the composer toolbar can insert", async () => {
    const sel = (value: string) => ({ value, start: 0, end: value.length });
    const cases: [string, string, string][] = [
      ["bold", wrap(sel("bold"), "**").value, "STRONG"],
      ["italic", wrap(sel("italic"), "*").value, "EM"],
      ["code", wrap(sel("code"), "`").value, "CODE"],
      ["quote", linePrefix(sel("quote"), "> ").value, "BLOCKQUOTE"],
      ["item", linePrefix(sel("item"), "- ").value, "LI"],
      ["item", linePrefix(sel("item"), "1. ", true).value, "LI"],
    ];
    for (const [text, source, tag] of cases) {
      const { container } = await show(source);
      expect(container.querySelector(tag.toLowerCase())?.textContent, source).toContain(text);
      cleanup();
    }

    const { container } = await show(insertLink(sel("label")).value);
    expect(container.querySelector("a")).not.toBe(null);
  });

  it("strikes through ~~text~~", async () => {
    const { container } = await show("~~gone~~");
    expect(container.querySelector("span.line-through")?.textContent).toBe("gone");
  });
});
