import { describe, expect, it } from "vitest";
import { pickedChip, mentionOf } from "../components/session-mention-chip";
import type { MentionData } from "./mentions";
import { trustedMentionPaths } from "./picked-mentions";

const outside = (path: string): MentionData => ({
  kind: "file",
  id: path,
  displayName: path,
  absPath: path,
});

describe("trustedMentionPaths", () => {
  it("trusts an outside path only when its chip was picked", () => {
    const picked = mentionOf(pickedChip(outside("/Users/me/notes.md")));
    // Rebuilt from a handoff prompt's text: the same shape, never picked.
    const rebuilt = mentionOf(outside("/tmp/evil/setup.terminal"));
    expect(trustedMentionPaths([picked, rebuilt])).toEqual(["/Users/me/notes.md"]);
  });

  it("keeps project-relative mentions out: they resolve in the project anyway", () => {
    const relative = mentionOf(
      pickedChip({
        kind: "file",
        id: "/p/src/a.ts",
        displayName: "src/a.ts",
        absPath: "/p/src/a.ts",
      }),
    );
    expect(trustedMentionPaths([relative])).toBeUndefined();
  });

  it("never lets the flag reach the mention itself", () => {
    const m = mentionOf(pickedChip(outside("/Users/me/notes.md")));
    expect("picked" in m).toBe(false);
  });
});
