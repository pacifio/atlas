import { ProviderLogo } from "atlas";

/** Brand logo by BYOK provider id, centred in a fixed box so rows align. */
export const Single = () => <ProviderLogo id="anthropic" />;

export const ProviderGrid = () => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 260 }}>
    {[
      "anthropic",
      "openai",
      "google",
      "mistral",
      "cohere",
      "xai",
      "deepseek",
      "groq",
      "together",
      "fireworks",
      "perplexity",
      "openrouter",
    ].map((id) => (
      <ProviderLogo key={id} id={id} />
    ))}
  </div>
);

export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <ProviderLogo id="anthropic" size={14} />
    <ProviderLogo id="anthropic" size={18} />
    <ProviderLogo id="anthropic" size={28} />
  </div>
);

export const UnknownFallback = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <ProviderLogo id="litellm" />
    <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
      no brand icon → neutral glyph
    </span>
  </div>
);

export const InAKeyRow = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 240 }}>
    {[
      ["anthropic", "ANTHROPIC_API_KEY"],
      ["openai", "OPENAI_API_KEY"],
      ["google", "GEMINI_API_KEY"],
    ].map(([id, env]) => (
      <div key={id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ProviderLogo id={id} size={16} />
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{env}</span>
      </div>
    ))}
  </div>
);
