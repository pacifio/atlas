import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

interface UsageState {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  requestCount: number;
  sessionStart: number; // timestamp
  history: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    timestamp: number;
  }>;
  actions: {
    trackUsage: (
      provider: string,
      model: string,
      inputTokens: number,
      outputTokens: number,
    ) => void;
    reset: () => void;
  };
}

// Approximate cost per 1M tokens (input/output)
const COST_TABLE: Record<string, [number, number]> = {
  "claude-sonnet-4-6-20250514": [3, 15],
  "claude-opus-4-6-20250514": [15, 75],
  "claude-haiku-4-5-20251001": [0.8, 4],
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  o3: [10, 40],
  "gemini-2.5-pro-preview-06-05": [1.25, 10],
  "gemini-2.5-flash-preview-05-20": [0.15, 0.6],
  // BYOK model-chat — common direct-API models.
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "o4-mini": [1.1, 4.4],
  "claude-opus-4-1": [15, 75],
  "claude-sonnet-4-5": [3, 15],
  "claude-3-5-haiku-latest": [0.8, 4],
  "deepseek-chat": [0.27, 1.1],
  "deepseek-reasoner": [0.55, 2.19],
  "grok-4": [3, 15],
  "llama-3.3-70b-versatile": [0.59, 0.79],
  sonar: [1, 1],
  "sonar-pro": [3, 15],
};

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = COST_TABLE[model] ?? [1, 3]; // fallback
  return (
    (inputTokens / 1_000_000) * rates[0] + (outputTokens / 1_000_000) * rates[1]
  );
}

export const useUsageStore = createSelectors(
  create<UsageState>()((set) => ({
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    requestCount: 0,
    sessionStart: Date.now(),
    history: [],
    actions: {
      trackUsage: (provider, model, inputTokens, outputTokens) => {
        const cost = estimateCost(model, inputTokens, outputTokens);
        set((s) => ({
          inputTokens: s.inputTokens + inputTokens,
          outputTokens: s.outputTokens + outputTokens,
          totalCost: s.totalCost + cost,
          requestCount: s.requestCount + 1,
          history: [
            ...s.history,
            {
              provider,
              model,
              inputTokens,
              outputTokens,
              cost,
              timestamp: Date.now(),
            },
          ].slice(-500),
        }));
      },
      reset: () =>
        set({
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          requestCount: 0,
          sessionStart: Date.now(),
          history: [],
        }),
    },
  })),
);
