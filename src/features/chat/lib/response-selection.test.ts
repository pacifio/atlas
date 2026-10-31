// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { actionPosition, insertedDraft, selectedAnchor } from "./response-selection";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

function fixture() {
  document.body.innerHTML = `<div id="viewport"><div data-comment-anchor="u1"><p>User text</p></div><div data-agent-response="m1" data-comment-anchor="m1"><p>First <em>selected</em> paragraph.</p><pre><code>const a = 1;\n  const b = 2;</code></pre><button>Copy</button><p>After toolbar</p></div><div data-agent-response="m2" data-comment-anchor="m2"><p>Another response</p></div><div data-streaming><p>Still arriving</p></div></div><p id="outside">Outside</p>`;
  return document.querySelector<HTMLElement>("#viewport")!;
}

function select(start: Node, end = start, from = 0, to = end.textContent!.length) {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("completed response selection", () => {
  it("keeps exactly the selected code, including indentation and newlines", () => {
    const viewport = fixture(),
      code = viewport.querySelector("code")!.firstChild!;
    const hit = selectedAnchor(select(code), viewport);
    expect(hit?.text).toBe("const a = 1;\n  const b = 2;");
    expect(hit?.anchor.dataset.commentAnchor).toBe("m1");
  });
  it("allows a passage across nested inline nodes and prose blocks", () => {
    const viewport = fixture();
    const start = viewport.querySelector("em")!.firstChild!;
    const end = viewport.querySelector("code")!.firstChild!;
    expect(selectedAnchor(select(start, end), viewport)?.text).toContain("selected");
  });
  it("takes a prompt's text too: a prompt can be commented on", () => {
    const viewport = fixture();
    const hit = selectedAnchor(
      select(document.querySelector('[data-comment-anchor="u1"] p')!.firstChild!),
      viewport,
    );
    expect(hit?.text).toBe("User text");
    expect(hit?.anchor.dataset.commentAnchor).toBe("u1");
  });
  it.each(["[data-streaming] p", "#outside", "button"])("excludes %s", (selector) => {
    const viewport = fixture();
    expect(
      selectedAnchor(select(document.querySelector(selector)!.firstChild!), viewport),
    ).toBeNull();
  });
  it("excludes a range crossing two responses or a toolbar", () => {
    const viewport = fixture();
    const first = viewport.querySelector("p")!.firstChild!;
    const last = viewport.querySelector('[data-agent-response="m2"] p')!.firstChild!;
    expect(selectedAnchor(select(first, last), viewport)).toBeNull();
    const prose = viewport.querySelector('[data-agent-response="m1"] p')!.firstChild!;
    expect(selectedAnchor(select(prose, last), viewport)).toBeNull();
    const after = viewport.querySelector('[data-agent-response="m1"] p:last-child')!.firstChild!;
    expect(selectedAnchor(select(prose, after), viewport)).toBeNull();
  });
  it("excludes empty, whitespace-only and collapsed selections", () => {
    const viewport = fixture(),
      node = viewport.querySelector("code")!.firstChild!;
    expect(selectedAnchor(select(node, node, 0, 0), viewport)).toBeNull();
    node.textContent = " \n ";
    expect(selectedAnchor(select(node), viewport)).toBeNull();
    expect(selectedAnchor(null, viewport)).toBeNull();
  });
});

describe("composer insertion", () => {
  it("keeps the existing complete-value targeted insert contract", () => {
    expect(insertedDraft("Old draft", { text: "Already appended draft", tabId: "chat-a" })).toBe(
      "Already appended draft",
    );
  });
  it("keeps untargeted inserts additive and avoids a blank leading gap", () => {
    expect(insertedDraft("Old draft", { text: "New text" })).toBe("Old draft\n\nNew text");
    expect(insertedDraft("  ", { text: "> Selected" })).toBe("> Selected");
  });
});

describe("panel positioning", () => {
  const bounds = { left: 100, top: 50, width: 400, height: 200 } as DOMRect;
  const size = { width: 400, height: 200, offsetWidth: 400, offsetHeight: 200 };
  it("flips above and clamps horizontally at the panel's lower right edge", () => {
    expect(
      actionPosition(bounds, size, { x: 498, top: 210, bottom: 240 }, { width: 140, height: 30 }),
    ).toEqual({ left: 252, top: 122 });
  });
  it("converts screen coordinates to layout pixels at 150% UI scale", () => {
    expect(
      actionPosition(
        { ...bounds, width: 600, height: 300 } as DOMRect,
        size,
        { x: 250, top: 100, bottom: 125 },
        { width: 140, height: 30 },
      ),
    ).toEqual({ left: 100, top: 58 });
  });
});
