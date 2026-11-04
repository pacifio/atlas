import { describe, expect, it } from "vitest";

import { toastFixable } from "./toast-fix";

describe("toastFixable", () => {
  it.each([
    ["Couldn't install Claude: npm exited with code 1", ""],
    ["Couldn't refresh the model list", "gateway answered 502"],
    ["Pull failed", "fatal: refusing to merge unrelated histories"],
    ["Import failed: unexpected token at line 3", ""],
    ["Keybindings not saved — the file is read-only", ""],
    ["Couldn't refresh the model list", "The operation was aborted due to timeout"],
    ["Couldn't load the registry", "the gateway response was not a valid JSON"],
    ["Couldn't install Codex: node version must be >=18", ""],
  ])("offers a fix for an error with a cause: %s", (title, description) => {
    expect(toastFixable(title, description)).toBe(true);
  });

  it.each([
    ["Couldn't copy", ""],
    ["Open a project before cloning a repo.", ""],
    ["More comments could not be loaded", ""],
    ["", ""],
  ])("leaves it off a failure with no cause: %s", (title, description) => {
    expect(toastFixable(title, description)).toBe(false);
  });

  it.each([
    ["Sign-in cancelled", "You closed the browser window."],
    ["Name is required", "Type a name for the project."],
    ["Couldn't create it: an organization named “acme” already exists", ""],
  ])("leaves it off a cancel or a validation message: %s", (title, description) => {
    expect(toastFixable(title, description)).toBe(false);
  });
});
