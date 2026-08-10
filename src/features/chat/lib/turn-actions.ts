// Turn-level actions shared by the turn footer (new transcript) and the legacy
// `TurnSummaryCard`. Lifted out of the card so both surfaces stay in step —
// these have non-obvious requirements that were learned the hard way:
//
//   * `save_knowledge_note` does NOT emit a KB-changed event, so the tree won't
//     show the note until entries are reloaded. Every working saver reloads.
//   * The note also needs a `knowledge_meta_patch` title, or the KB tree shows
//     the raw timestamp id instead of a readable name.
//   * "Draw diagram" opens the canvas via `requestOpenAiThread(groupId)` so the
//     user lands on the thread that is generating.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { ChatMessage, TurnFile } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useCanvasAiStore } from "@/features/canvas/stores/canvas-ai-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { resolveByok } from "./byok-resolve";
import { stripNextSteps } from "./next-steps";
import { stripInjectedContext } from "./atlas-context";

/** Thread title = the first user message, cleaned and clamped. */
function threadTitle(tabId: string): string {
  const session = useChatStore.getState().sessions[tabId];
  const firstUser = session?.messages.find((m) => m.role === "user");
  const raw = stripNextSteps(
    stripInjectedContext(firstUser?.atlasProse ?? firstUser?.content ?? ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  return raw.slice(0, 80) || "Agent chat";
}

function buildThreadMarkdown(tabId: string): string | null {
  const session = useChatStore.getState().sessions[tabId];
  if (!session) return null;
  const lines: string[] = [`# ${threadTitle(tabId)}`, ""];
  for (const m of session.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = stripNextSteps(m.atlasProse ?? m.content ?? "").trim();
    if (!text) continue;
    lines.push(`## ${m.role === "user" ? "User" : "Assistant"}`, "", text, "");
  }
  return lines.length > 2 ? lines.join("\n") : null;
}

export async function saveThreadToKb(tabId: string): Promise<void> {
  const project = useProjectStore.getState().currentProject;
  if (!project) {
    toast.error("No project open");
    return;
  }
  const md = buildThreadMarkdown(tabId);
  if (!md) {
    toast.error("Nothing to save yet");
    return;
  }
  const title = threadTitle(tabId);
  const id = `chat/${new Date().toISOString().replace(/[:.]/g, "-")}-thread`;
  try {
    await invoke("save_knowledge_note", {
      projectPath: project.path,
      id,
      content: md,
    });
    await invoke("knowledge_meta_patch", {
      projectPath: project.path,
      entryId: id,
      patch: { title },
    }).catch(() => {});
    await useKnowledgeStore.getState().actions.loadEntries(project.path);
    toast.success(`Saved “${title}” to knowledge base`);
  } catch (e) {
    toast.error(`Failed to save: ${e}`);
  }
}

export function canDrawDiagram(files: TurnFile[]): boolean {
  return files.some((f) => f.kind === "edit") && resolveByok() !== null;
}

export function drawDiagram(message: ChatMessage, files: TurnFile[]): void {
  const byok = resolveByok();
  if (!byok) {
    toast.error("Pick a BYOK model in the composer first to draw diagrams");
    return;
  }
  const projectPath = useProjectStore.getState().currentProject?.path ?? "/";
  const editedPaths = files.filter((f) => f.kind === "edit").map((f) => f.path);
  const prompt = [
    "Draw a clear architecture/flow diagram of the changes just made" +
      (editedPaths.length ? " to these files:" : ":"),
    ...editedPaths.map((p) => `- ${p}`),
    "",
    (message.content ?? "").slice(0, 2000),
  ].join("\n");

  const canvas = useCanvasStore.getState().actions;
  canvas.createPage();
  const anchor = { x: 0, y: 0 };
  const groupId = canvas.createAiGroup(anchor, byok.provider, byok.model);
  canvas.requestOpenAiThread(groupId);
  void useCanvasAiStore.getState().actions.generate({
    groupId,
    anchor,
    prompt,
    provider: byok.provider,
    model: byok.model,
    projectPath,
  });

  const layout = useLayoutStore.getState().actions;
  layout.addTab({
    id: "canvas",
    type: "canvas",
    title: "Spaces",
    closable: true,
    dirty: false,
    data: {},
  });
  layout.setActiveTab("canvas");
  toast.success("Drawing a diagram in Spaces…");
}
