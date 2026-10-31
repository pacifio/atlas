import { describe, expect, it } from "vitest";
import {
  editorForOutsideFiles,
  editorName,
  openInLabel,
  resolvePreferredEditor,
} from "./preferred-editor";
import type { ExternalEditor } from "./external-editor-api";

const cursor = { id: "cursor", label: "Cursor" };
const zed = { id: "zed", label: "Zed" };
const system = { id: "system", label: "System default" };
const detected: ExternalEditor[] = [cursor, zed, system];

describe("the preferred editor", () => {
  it("is the one the setting names, when it is installed", () => {
    expect(resolvePreferredEditor("zed", detected)).toEqual(zed);
    expect(resolvePreferredEditor("system", detected)).toEqual(system);
  });

  it("is the first detected when the setting is empty or names a missing editor", () => {
    expect(resolvePreferredEditor("", detected)).toEqual(cursor);
    expect(resolvePreferredEditor("sublime", detected)).toEqual(cursor);
  });

  it("is the system default when no editor is installed", () => {
    expect(resolvePreferredEditor("", [system])).toEqual(system);
  });

  it("is nothing until detection answers", () => {
    expect(resolvePreferredEditor("zed", null)).toBeNull();
    expect(resolvePreferredEditor("zed", [])).toBeNull();
  });
});

describe("a file outside the project", () => {
  it("opens in an editor only when the user named one", () => {
    expect(editorForOutsideFiles("zed", detected)).toEqual(zed);
    expect(editorForOutsideFiles("", detected)).toBeNull();
    expect(editorForOutsideFiles("system", detected)).toBeNull();
    expect(editorForOutsideFiles("sublime", detected)).toBeNull();
  });
});

describe("labels", () => {
  it("names an editor, and the system default as the default app", () => {
    expect(openInLabel(cursor)).toBe("Open in Cursor");
    expect(openInLabel(system)).toBe("Open in Default App");
    expect(editorName(null)).toBe("Editor");
  });
});
