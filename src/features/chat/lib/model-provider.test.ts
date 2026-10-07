import { describe, expect, it } from "vitest";
import { providerDisplay } from "./model-provider";

describe("providerDisplay", () => {
  it("reads the gateway's publisher and an ACP group name as one provider", () => {
    expect(providerDisplay("anthropic")).toEqual(providerDisplay("Anthropic"));
    expect(providerDisplay("anthropic")).toMatchObject({ label: "Claude", logo: "claude" });
    expect(providerDisplay("x-ai")).toMatchObject({ key: "xai", label: "Grok" });
  });

  // Every alias a gateway publisher or an ACP group name might use, and the
  // one provider it reads as. Spelling variants ("X AI", "Meta-Llama") are
  // folded by normalisation before the table is consulted.
  it.each([
    ["anthropic", "claude", "Claude"],
    ["Claude", "claude", "Claude"],
    ["openai", "openai", "OpenAI"],
    ["OpenAI", "openai", "OpenAI"],
    ["google", "gemini", "Gemini"],
    ["Gemini", "gemini", "Gemini"],
    ["xai", "xai", "Grok"],
    ["X AI", "xai", "Grok"],
    ["deepseek", "deepseek", "DeepSeek"],
    ["mistral", "mistral", "Mistral"],
    ["mistralai", "mistral", "Mistral"],
    ["Mistral AI", "mistral", "Mistral"],
    ["meta", "meta", "Llama"],
    ["meta-llama", "meta", "Llama"],
    ["moonshot", "kimi", "Kimi"],
    ["moonshotai", "kimi", "Kimi"],
    ["z-ai", "zhipu", "GLM"],
    ["zhipu", "zhipu", "GLM"],
    ["ZhipuAI", "zhipu", "GLM"],
    ["qwen", "qwen", "Qwen"],
    ["alibaba", "qwen", "Qwen"],
  ])("reads %j as %s (%s)", (stated, logo, label) => {
    expect(providerDisplay(stated)).toEqual({ key: logo, label, logo });
  });

  it("files every alias of one provider under one rail key", () => {
    const keys = (aliases: string[]) => new Set(aliases.map((a) => providerDisplay(a)?.key));
    expect(keys(["anthropic", "Anthropic", "claude", "Claude"]).size).toBe(1);
    expect(keys(["google", "Gemini"]).size).toBe(1);
    expect(keys(["z-ai", "zhipu", "zhipuai"]).size).toBe(1);
    expect(keys(["qwen", "alibaba"]).size).toBe(1);
  });

  it("keeps an unknown provider as stated rather than guessing", () => {
    expect(providerDisplay("Local")).toEqual({ key: "local", label: "Local", logo: "local" });
    expect(providerDisplay("cloudflare")?.label).toBe("Cloudflare");
    expect(providerDisplay("My Lab")).toEqual({ key: "mylab", label: "My Lab", logo: "mylab" });
  });

  it("is null when nothing was stated", () => {
    expect(providerDisplay(undefined)).toBeNull();
    expect(providerDisplay(null)).toBeNull();
    expect(providerDisplay("  ")).toBeNull();
    expect(providerDisplay("--")).toBeNull();
  });
});
