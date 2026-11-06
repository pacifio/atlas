import { describe, expect, it } from "vitest";

import { curateModels, defaultModelFor } from "./model-catalog";
import { CHAT_PROVIDERS, providerById } from "./providers";

const currentModels = ["MiniMax-M3.1-Flash", "MiniMax-M3"];

describe.each([
  ["minimax", "MINIMAX_API_KEY"],
  ["minimax-cn", "MINIMAX_CN_API_KEY"],
])("MiniMax BYOK (%s)", (id, env) => {
  it("exposes an independent regional key and chat provider", () => {
    const provider = providerById(id);
    expect(provider).toMatchObject({ id, env, chat: true });
    expect(CHAT_PROVIDERS).toContain(provider);
  });

  it.each([
    { liveIds: [] },
    { liveIds: ["MiniMax-M2.7"] },
    { liveIds: [...currentModels].reverse() },
    { liveIds: ["speech-2.8-hd"] },
  ])("offers Flash first regardless of stale or unavailable discovery: $liveIds", ({ liveIds }) => {
    expect(curateModels(id, liveIds)).toEqual(currentModels);
    expect(defaultModelFor(id, curateModels(id, liveIds))).toBe(currentModels[0]);
    expect(defaultModelFor(id, [])).toBe(currentModels[0]);
  });

  it.each(["MiniMax-M3", "MiniMax-M2.7", "my-custom-model"])(
    "preserves an explicit saved selection: %s",
    (saved) => {
      expect(defaultModelFor(id, curateModels(id, []), saved)).toBe(saved);
    },
  );
});

describe("MiniMax gateway recommendations", () => {
  it("uses verified route IDs and removes older MiniMax choices only", () => {
    const live = [
      "custom/unchanged-model",
      "minimax/minimax-m2.7",
      "minimax/minimax-m3",
      "minimax/minimax-m3.1-flash",
    ];
    expect(curateModels("openrouter", live)).toEqual([
      "minimax/minimax-m3.1-flash",
      "minimax/minimax-m3",
      "custom/unchanged-model",
    ]);
    expect(defaultModelFor("openrouter", curateModels("openrouter", live))).toBe(
      "minimax/minimax-m3.1-flash",
    );
    expect(defaultModelFor("openrouter", curateModels("openrouter", live), live[1])).toBe(live[1]);
  });

  it("preserves unrelated providers and their saved-model validation", () => {
    expect(curateModels("custom", ["custom-model", "embedding-model"])).toEqual(["custom-model"]);
    expect(defaultModelFor("custom", ["custom-model"], "missing-model")).toBe("custom-model");
    expect(defaultModelFor("custom", ["first", "saved"], "saved")).toBe("saved");
  });
});
