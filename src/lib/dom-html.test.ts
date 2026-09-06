// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { applyHtml, escapeHtml } from "./dom-html";

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("applyHtml", () => {
  it("fills an empty element", () => {
    const el = host();
    applyHtml(el, "<p>hello</p>");
    expect(el.innerHTML).toBe("<p>hello</p>");
  });

  it("keeps the nodes that did not change", () => {
    // The whole point: a streaming update must not destroy the DOM the reader
    // is looking at (selection, hover, scroll inside a wide block all live on
    // these nodes).
    const el = host();
    applyHtml(el, "<p>settled</p><p>grow</p>");
    const settled = el.firstElementChild;
    const growing = el.lastElementChild;

    applyHtml(el, "<p>settled</p><p>growing text</p>");

    expect(el.firstElementChild).toBe(settled);
    expect(el.lastElementChild).toBe(growing);
    expect(el.lastElementChild?.textContent).toBe("growing text");
  });

  it("adds and removes elements as the html changes", () => {
    const el = host();
    applyHtml(el, "<p>one</p>");
    applyHtml(el, "<p>one</p><ul><li>two</li></ul>");
    expect(el.querySelectorAll("li")).toHaveLength(1);
    applyHtml(el, "<p>one</p>");
    expect(el.querySelectorAll("li")).toHaveLength(0);
  });

  it("preserves an injected code bar and its enhanced flag", () => {
    // The copy/language bar is added after parsing, so it is never in the
    // incoming html — morphing must not treat it as removed content.
    const el = host();
    applyHtml(el, "<pre><code>a</code></pre>");
    const pre = el.querySelector("pre")!;
    pre.dataset.enhanced = "1";
    const bar = document.createElement("div");
    bar.className = "atlas-code-bar";
    pre.appendChild(bar);

    applyHtml(el, "<pre><code>a b</code></pre>");

    expect(el.querySelector("pre")).toBe(pre);
    expect(pre.dataset.enhanced).toBe("1");
    expect(pre.querySelectorAll(".atlas-code-bar")).toHaveLength(1);
    expect(pre.querySelector("code")?.textContent).toBe("a b");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup in a raw-source placeholder", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});
