import { describe, expect, it } from "vitest";
import {
  EXTERNAL_SESSIONS_HINT,
  EXTRACTION_NOTE,
  HANDOFF_HINT,
  RAW_HINT,
} from "./memory-sharing-copy";

describe("the summarizer popover copy", () => {
  it("never claims context is injected", () => {
    for (const s of [HANDOFF_HINT, RAW_HINT, EXTRACTION_NOTE]) expect(s).not.toMatch(/inject/i);
  });
  it("says extraction uses the Atlas model and is redacted", () => {
    expect(EXTRACTION_NOTE).toMatch(/Atlas model/);
    expect(EXTRACTION_NOTE).toMatch(/redacted/);
  });
  it("scopes 'no model call' to the handoff only", () => {
    expect(RAW_HINT).toMatch(/No model call for the handoff/);
  });
});

describe("the sessions-outside-Atlas copy", () => {
  it("says what is read, that it is sent to the model, and that it starts off", () => {
    expect(EXTERNAL_SESSIONS_HINT).toMatch(/imported from your terminal/);
    expect(EXTERNAL_SESSIONS_HINT).toMatch(/sent to the extraction model/);
    expect(EXTERNAL_SESSIONS_HINT).toMatch(/Off by default/);
  });
});
