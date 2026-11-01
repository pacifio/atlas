// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SlashCommandPicker, type SlashCommand } from "./slash-command-picker";

// The virtualizer draws nothing into a zero-sized scroller, and happy-dom
// lays nothing out. It reads the scroller's rect from client*.
const SIZES = { offsetHeight: 360, offsetWidth: 460, clientHeight: 360, clientWidth: 460 };
const KEYS = Object.keys(SIZES) as (keyof typeof SIZES)[];
const originals = new Map(
  KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]),
);
beforeAll(() => {
  for (const key of KEYS) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => SIZES[key],
    });
  }
});
afterAll(() => {
  for (const key of KEYS) {
    const desc = originals.get(key);
    if (desc) Object.defineProperty(HTMLElement.prototype, key, desc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});
afterEach(cleanup);

const LONG =
  "Use this skill when the user wants to run, audit or update a build; triggers include 'use', 'run'. ".repeat(
    10,
  );

const skills = (n: number): SlashCommand[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `skill-${i}`,
    signature: `/skill-${i}`,
    description: LONG,
    handler: "passthrough",
  }));

function picker(commands: SlashCommand[], query: string) {
  render(
    <SlashCommandPicker
      open
      query={query}
      anchor={{ x: 10, y: 500 }}
      onSelect={() => {}}
      onClose={() => {}}
      commands={commands}
    />,
  );
  return document.querySelector(".atlas-slash-picker")!;
}

describe("SlashCommandPicker", () => {
  it("marks one description match per row, however often a one-letter query occurs", () => {
    const root = picker(skills(5), "u");
    // Every row matches by description only (no `u` in `skill-N`), so each
    // gets exactly one mark — not one per `u` in a thousand characters.
    expect(root.querySelectorAll("button")).toHaveLength(5);
    expect(root.querySelectorAll("mark")).toHaveLength(5);
    // The text itself is untouched: the unmarked tail is folded back in.
    const desc = root.querySelector("button span:nth-child(2)")!;
    expect(desc.textContent).toBe(LONG);
  });

  it("still marks every occurrence in the command name", () => {
    const root = picker(
      [
        {
          name: "run-ui-build",
          signature: "/run-ui-build",
          description: "",
          handler: "passthrough",
        },
      ],
      "u",
    );
    const name = root.querySelector("button span")!;
    expect(name.querySelectorAll("mark")).toHaveLength(3);
    expect(name.textContent).toBe("/run-ui-build");
  });

  it("renders only the rows in view, not every advertised command", () => {
    // An agent with a few hundred skills advertises a few hundred commands,
    // and `/u` matches nearly all of them by description.
    const root = picker(skills(300), "u");
    const rendered = root.querySelectorAll("button").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
  });
});
