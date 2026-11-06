// The cache is served SYNCHRONOUSLY on open, so a stale entry is not a slow
// panel — it is a wrong one. These cases pin what must be forgotten and when.

import { afterEach, describe, expect, it } from "vitest";

import type { SessionDetail } from "../types";
import {
  clearDetailCache,
  invalidateCachedDetail,
  readCachedDetail,
  writeCachedDetail,
} from "./detail-cache";

const detail = (id: string) =>
  ({ summary: { id }, entries: [], counts: {}, tools: [] }) as unknown as SessionDetail;

const ref = (sessionId: string, projectPath = "/repo", remoteProjectId: string | null = null) => ({
  sessionId,
  projectPath,
  remoteProjectId,
});

afterEach(() => clearDetailCache());

describe("the detail cache", () => {
  it("serves what it was given, keyed by Session and Project", () => {
    writeCachedDetail(ref("s1"), detail("s1"));
    expect(readCachedDetail(ref("s1"))?.summary.id).toBe("s1");
    // The same Session id under a different Project is a different row.
    expect(readCachedDetail(ref("s1", "/other"))).toBeUndefined();
  });

  it("forgets one Session wherever it is held", () => {
    // A realtime frame names the Session, not the checkout it is filed under
    // here — and one id can be held by two Projects.
    writeCachedDetail(ref("s1", "/a"), detail("s1"));
    writeCachedDetail(ref("s1", "/b"), detail("s1"));
    writeCachedDetail(ref("s2", "/a"), detail("s2"));

    invalidateCachedDetail("s1");

    expect(readCachedDetail(ref("s1", "/a"))).toBeUndefined();
    expect(readCachedDetail(ref("s1", "/b"))).toBeUndefined();
    // Its neighbour is untouched.
    expect(readCachedDetail(ref("s2", "/a"))?.summary.id).toBe("s2");
  });

  it("does not forget a Session whose id merely ends the same way", () => {
    writeCachedDetail(ref("abc"), detail("abc"));
    invalidateCachedDetail("bc");
    expect(readCachedDetail(ref("abc"))?.summary.id).toBe("abc");
  });

  it("evicts the oldest first, and a read makes an entry young again", () => {
    for (let i = 0; i < 24; i++) writeCachedDetail(ref(`s${i}`), detail(`s${i}`));
    // Touch the oldest so the next write evicts the second-oldest instead.
    expect(readCachedDetail(ref("s0"))).toBeDefined();
    writeCachedDetail(ref("new"), detail("new"));

    expect(readCachedDetail(ref("s0"))?.summary.id).toBe("s0");
    expect(readCachedDetail(ref("s1"))).toBeUndefined();
  });

  it("drops everything on a resync or an org switch", () => {
    writeCachedDetail(ref("s1"), detail("s1"));
    clearDetailCache();
    expect(readCachedDetail(ref("s1"))).toBeUndefined();
  });
});
