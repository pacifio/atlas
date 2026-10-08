import { describe, expect, it } from "vitest";

import { curateModels, defaultModelFor } from "./model-catalog";
import { CHAT_PROVIDERS, providerById } from "./providers";

describe.each([
  ["minimax", "MINIMAX_API_KEY"],
  ["minimax-cn", "MINIMAX_CN_API_KEY"],
])("MiniMax BYOK (%s)", (id, env) => {
  it("exposes an independent regional key and chat provider", () => {
    const provider = providerById(id);
    expect(provider).toMatchObject({ id, env, chat: true });
    expect(CHAT_PROVIDERS).toContain(provider);
  });

  it("offers the configured models when discovery is unavailable", () => {
    const models = ["MiniMax-M3", "MiniMax-M2.7"];
    expect(curateModels(id, [])).toEqual(models);
    expect(defaultModelFor(id, [])).toBe(models[0]);
  });

  it("ranks the preferred model first when both are available", () => {
    const models = ["MiniMax-M3", "MiniMax-M2.7"];
    expect(curateModels(id, [...models].reverse())).toEqual(models);
  });
});
