// The gateway's models for the Atlas Agent in the Northwind scenario
// (ADR-0007) — one list for both the session snapshot and the picker's
// Refresh, so the two never disagree on camera.
//
// Shaped to put every model-picker state on screen: stated providers (the
// rail), a "New" badge, several legacy models in one provider (the Legacy
// fold reads "N models"), and one model whose provider was not stated, which
// the picker files under the agent itself.

import type { SessionModeInfo } from "@/types/agents";

export const NORTHWIND_NATIVE_MODELS: SessionModeInfo[] = [
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    description: "The default for new sessions.",
    provider: "anthropic",
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    description: "For the hardest problems.",
    provider: "anthropic",
    is_new: true,
  },
  { id: "claude-haiku-4", name: "Claude Haiku 4", description: null, provider: "anthropic" },
  {
    id: "claude-opus-4",
    name: "Claude Opus 4",
    description: null,
    provider: "anthropic",
    legacy: true,
  },
  {
    id: "claude-sonnet-3-7",
    name: "Claude Sonnet 3.7",
    description: null,
    provider: "anthropic",
    legacy: true,
  },
  { id: "gpt-5", name: "GPT-5", description: null, provider: "openai" },
  { id: "gpt-5-mini", name: "GPT-5 mini", description: null, provider: "openai" },
  { id: "o3", name: "o3", description: null, provider: "openai", legacy: true },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", description: null, provider: "google" },
  {
    id: "qwen3-coder-local",
    name: "Qwen3 Coder (local)",
    description: "Served from the team's own box.",
  },
];
