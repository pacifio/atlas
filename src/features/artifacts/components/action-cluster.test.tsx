// @vitest-environment happy-dom
//
// The snap reveal must leave hidden controls reachable with Tab. It used
// `invisible`, and a `visibility: hidden` button is not focusable, so copy and
// comment on an undiscussed cloud message were mouse-only. Hidden now means
// transparent and inert to the pointer, never `invisible`.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ActionCluster } from "./action-cluster";

afterEach(cleanup);

function cluster(pinned: boolean) {
  render(
    <ActionCluster reveal="snap" pinned={pinned}>
      <button type="button">Copy</button>
    </ActionCluster>,
  );
  const button = screen.getByRole("button", { name: "Copy" });
  return { button, surround: button.closest("span.rounded-full") as HTMLElement };
}

describe("ActionCluster snap reveal", () => {
  it("hides with opacity, so the controls stay in the tab order", () => {
    const { button, surround } = cluster(false);
    expect(surround.className).not.toMatch(/\binvisible\b/);
    expect(surround.className).toContain("opacity-0");
    expect(surround.className).toContain("pointer-events-none");
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("comes back on focus within the surround or the row", () => {
    const { surround } = cluster(false);
    expect(surround.className).toContain("focus-within:opacity-100");
    expect(surround.className).toContain("group-focus-within/row:opacity-100");
  });

  it("stays shown when pinned", () => {
    const { surround } = cluster(true);
    expect(surround.className).not.toContain("opacity-0");
  });
});
