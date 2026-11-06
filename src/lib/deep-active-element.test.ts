// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { deepActiveElement, eventOrigin, shadowHost } from "./deep-active-element";

afterEach(() => {
  document.body.innerHTML = "";
});

function editableInShadow() {
  const host = document.createElement("div");
  document.body.append(host);
  const inner = document.createElement("div");
  inner.contentEditable = "true";
  inner.tabIndex = 0;
  host.attachShadow({ mode: "open" }).append(inner);
  return { host, inner };
}

describe("deepActiveElement", () => {
  it("is the focused element itself in the light DOM", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(deepActiveElement()).toBe(input);
  });

  it("looks through a shadow host to what has focus inside it", () => {
    const { inner } = editableInShadow();
    inner.focus();
    expect(deepActiveElement()).toBe(inner);
  });
});

describe("shadowHost", () => {
  it("is the host for an element at a shadow root's top, null in the light DOM", () => {
    const { host, inner } = editableInShadow();
    expect(shadowHost(inner)).toBe(host);
    expect(shadowHost(host)).toBeNull();
  });
});

describe("eventOrigin", () => {
  // A browser retargets `e.target` to the host here; the origin is what the
  // key was really pressed in.
  it("is the element inside the shadow root the event started on", () => {
    const { inner } = editableInShadow();
    let origin: Element | null = null;
    document.addEventListener(
      "keydown",
      (e) => {
        origin = eventOrigin(e);
      },
      { once: true },
    );
    inner.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true }));
    expect(origin).toBe(inner);
  });
});
