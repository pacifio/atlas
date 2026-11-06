import { describe, expect, it } from "vitest";

import {
  MAX_BYTES,
  MAX_ENTRIES,
  readCachedPullRequestDetail,
  writeCachedPullRequestDetail,
} from "./pull-request-detail-cache";
import type { PrDetail } from "./pull-requests-types";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const detail = (number: number, body = "") =>
  ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    state: "open",
    headBranch: "feat",
    baseBranch: "main",
    body,
    capabilities: {},
    viewerPermissions: {},
    checks: [],
    labels: [],
    reviewers: [],
  }) as unknown as PrDetail;

describe("pull request detail cache", () => {
  it("reads back what was kept, per checkout and number", () => {
    const store = memoryStorage();
    writeCachedPullRequestDetail("/repo", detail(4), store);
    expect(readCachedPullRequestDetail("/repo", 4, store)?.title).toBe("PR 4");
    expect(readCachedPullRequestDetail("/other", 4, store)).toBeUndefined();
    expect(readCachedPullRequestDetail("/repo", 5, store)).toBeUndefined();
  });

  it("keeps only the most recent pull requests", () => {
    const store = memoryStorage();
    for (let n = 1; n <= MAX_ENTRIES + 3; n++)
      writeCachedPullRequestDetail("/repo", detail(n), store);
    expect(readCachedPullRequestDetail("/repo", 1, store)).toBeUndefined();
    expect(readCachedPullRequestDetail("/repo", MAX_ENTRIES + 3, store)).toBeDefined();
    // Reading one again makes it the newest.
    writeCachedPullRequestDetail("/repo", detail(4), store);
    for (let n = 100; n < 100 + MAX_ENTRIES - 1; n++) {
      writeCachedPullRequestDetail("/repo", detail(n), store);
    }
    expect(readCachedPullRequestDetail("/repo", 4, store)).toBeDefined();
  });

  it("stays under its byte budget and cuts a huge description short", () => {
    const store = memoryStorage();
    for (let n = 1; n <= MAX_ENTRIES; n++) {
      writeCachedPullRequestDetail("/repo", detail(n, "x".repeat(100_000)), store);
    }
    const raw = store.getItem("atlas.pullRequests.detail.v1") ?? "";
    expect(raw.length).toBeLessThanOrEqual(MAX_BYTES);
    const newest = readCachedPullRequestDetail("/repo", MAX_ENTRIES, store);
    expect(newest?.body.length).toBeLessThan(100_000);
    expect(newest?.body.endsWith("…")).toBe(true);
  });

  it("treats garbage as nothing kept", () => {
    const store = memoryStorage();
    store.setItem("atlas.pullRequests.detail.v1", "{not json");
    expect(readCachedPullRequestDetail("/repo", 4, store)).toBeUndefined();
    store.setItem(
      "atlas.pullRequests.detail.v1",
      JSON.stringify([{ key: "/repo\u00004", detail: { number: 4 } }]),
    );
    expect(readCachedPullRequestDetail("/repo", 4, store)).toBeUndefined();
  });
});
