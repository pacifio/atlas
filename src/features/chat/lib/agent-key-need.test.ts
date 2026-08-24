import { describe, expect, it } from "vitest";
import { detectKeyNeed } from "./agent-key-need";

describe("detectKeyNeed", () => {
  it("recognises the errors these agents actually return", () => {
    // Both captured verbatim from a live spawn (2026-08-17). These are the
    // whole reason in-app key entry exists: neither agent offers a login flow
    // Atlas can run, so the key IS the only route to a working session.
    const gemini = detectKeyNeed("Gemini API key is missing or not configured.");
    expect(gemini?.provider).toBe("google");
    expect(gemini?.envVar).toBeNull(); // prose form — no var named

    const qwen = detectKeyNeed(
      "Authentication required: Use Qwen Code CLI to authenticate first. " +
        "Requires setting the `OPENAI_API_KEY` environment variable",
    );
    expect(qwen?.provider).toBe("openai");
    expect(qwen?.envVar).toBe("OPENAI_API_KEY");
  });

  it("prefers an explicitly named env var over prose", () => {
    // Naming the var is unambiguous, and echoing it back shows the user Atlas
    // understood the actual request.
    const need = detectKeyNeed("set GOOGLE_GENERATIVE_AI_API_KEY to continue");
    expect(need?.provider).toBe("google");
    expect(need?.envVar).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  it("is case-insensitive", () => {
    expect(detectKeyNeed("missing anthropic_api_key")?.provider).toBe("anthropic");
    expect(detectKeyNeed("Missing Gemini Api Key")?.provider).toBe("google");
  });

  it("returns null when no provider is identifiable", () => {
    // Must NOT guess. A wrong provider would store the user's key under the
    // wrong name and still leave the agent broken.
    for (const m of [
      "Authentication required",
      "Please log in to use Autohand", // the real autohand error
      "api key", // too generic to attribute
      "Authentication required. Please run `agent login` first.",
      "",
    ]) {
      expect(detectKeyNeed(m), m).toBeNull();
    }
  });

  it("covers the providers BYOK can actually store", () => {
    // A provider detected here but absent from the BYOK store would save a key
    // that never reaches any agent.
    const cases: Array<[string, string]> = [
      ["OPENROUTER_API_KEY missing", "openrouter"],
      ["needs XAI_API_KEY", "xai"],
      ["MISTRAL_API_KEY not set", "mistral"],
      ["GROQ_API_KEY required", "groq"],
      ["DEEPSEEK_API_KEY required", "deepseek"],
      ["CLAUDE_API_KEY absent", "anthropic"],
    ];
    for (const [msg, provider] of cases) {
      expect(detectKeyNeed(msg)?.provider, msg).toBe(provider);
    }
  });

  it("always supplies a label and a place to get the key", () => {
    const need = detectKeyNeed("GEMINI_API_KEY missing")!;
    expect(need.label).toBeTruthy();
    expect(need.consoleHint).toBeTruthy();
  });
});
