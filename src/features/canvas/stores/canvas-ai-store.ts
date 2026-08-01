// Canvas AI copilot — orchestrates a BYOK generation turn: gather project context
// (memory + codebase), send one combined prompt through the shared model-chat
// streaming engine, accumulate the reply, parse the JSON ops, and apply them to
// the target group (one undo step). Backend-agnostic; the key never leaves Rust.

import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";
import {
  modelchat,
  listenModelChat,
  type WireMsg,
} from "@/features/model-chat/lib/model-chat-api";
import { useCanvasStore } from "./canvas-store";
import { CANVAS_AI_SYSTEM, parseOps, serializeGroup } from "../lib/canvas-ai";
import { canvasCodebaseContext, memoryChatRetrieve } from "../lib/canvas-api";

interface GenerateArgs {
  groupId: string;
  anchor: { x: number; y: number };
  prompt: string;
  provider: string;
  model: string;
  projectPath: string;
}

interface CanvasAiState {
  /** The group id currently generating (null = idle). Drives per-group spinners. */
  streamingGroupId: string | null;
  error: string | null;
  actions: {
    generate: (args: GenerateArgs) => Promise<void>;
    cancel: () => void;
  };
}

// Active stream bookkeeping (module-level; not reactive).
let active: {
  streamId: string;
  groupId: string;
  anchor: { x: number; y: number };
  text: string;
  unlisten: UnlistenFn | null;
} | null = null;

/** Wants codebase structure folded in (architecture/system/dependency asks). */
function wantsCodebase(prompt: string): boolean {
  return /\b(architecture|codebase|system|module|dependenc|repo|structure)\b/i.test(
    prompt,
  );
}

async function buildContext(
  projectPath: string,
  prompt: string,
): Promise<string> {
  const parts: string[] = [];
  try {
    const { prompt: augmented } = await memoryChatRetrieve(projectPath, prompt);
    if (augmented?.trim()) parts.push(augmented.trim());
  } catch {
    /* best-effort */
  }
  if (wantsCodebase(prompt)) {
    try {
      const structure = await canvasCodebaseContext(projectPath, 60);
      if (structure.trim()) parts.push(structure.trim());
    } catch {
      /* best-effort */
    }
  }
  return parts.join("\n\n");
}

export const useCanvasAiStore = createSelectors(
  create<CanvasAiState>((set, get) => ({
    streamingGroupId: null,
    error: null,
    actions: {
      generate: async ({
        groupId,
        anchor,
        prompt,
        provider,
        model,
        projectPath,
      }) => {
        if (get().streamingGroupId) return; // one generation at a time
        const canvas = useCanvasStore.getState().actions;
        const ts = Date.now();
        canvas.appendGroupMessage(groupId, {
          role: "user",
          content: prompt,
          ts,
        });
        set({ streamingGroupId: groupId, error: null });

        const context = await buildContext(projectPath, prompt);
        // Modifying an existing diagram? Include its current nodes/edges as state.
        const cs = useCanvasStore.getState();
        const existing = cs.nodes.some((n) => n.groupId === groupId);
        const currentDiagram = existing
          ? `\n\nCURRENT DIAGRAM (modify these; ids are stable):\n${serializeGroup(cs.nodes, cs.edges, groupId)}`
          : "";

        // One combined user message (robust across every BYOK provider).
        const content =
          `${CANVAS_AI_SYSTEM}\n\n` +
          (context ? `PROJECT CONTEXT:\n${context}\n\n` : "") +
          `${currentDiagram}\n\nREQUEST: ${prompt}`;
        const messages: WireMsg[] = [{ role: "user", content }];

        const streamId = crypto.randomUUID();
        active = { streamId, groupId, anchor, text: "", unlisten: null };

        const finalize = () => {
          const a = active;
          active = null;
          a?.unlisten?.();
          if (!a) return;
          const ops = parseOps(a.text);
          if (ops.length > 0) {
            useCanvasStore
              .getState()
              .actions.applyAiOps(a.groupId, ops, a.anchor);
            useCanvasStore.getState().actions.appendGroupMessage(a.groupId, {
              role: "assistant",
              content: `Applied ${ops.length} change${ops.length === 1 ? "" : "s"} to the diagram.`,
              ts: Date.now(),
            });
          } else {
            useCanvasStore.getState().actions.appendGroupMessage(a.groupId, {
              role: "assistant",
              content: "I couldn't turn that into a diagram — try rephrasing.",
              ts: Date.now(),
            });
          }
          set({ streamingGroupId: null });
        };

        active.unlisten = await listenModelChat((e) => {
          if (!active || e.stream_id !== active.streamId) return;
          if (e.kind === "text_delta") active.text += e.delta;
          else if (e.kind === "done") finalize();
          else if (e.kind === "error") {
            set({ error: e.message });
            finalize();
          }
        });

        try {
          await modelchat.stream(streamId, provider, model, messages);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
          finalize();
        }
      },

      cancel: () => {
        const a = active;
        if (!a) return;
        void modelchat.cancel(a.streamId).catch(() => {});
        a.unlisten?.();
        active = null;
        set({ streamingGroupId: null });
      },
    },
  })),
);
