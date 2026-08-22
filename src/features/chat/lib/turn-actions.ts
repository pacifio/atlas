// Turn-level action shared by the turn footer (new transcript) and the legacy
// `TurnSummaryCard`. Lifted out of the card so both surfaces stay in step —
// these have non-obvious requirements that were learned the hard way:
//
//   * `save_knowledge_note` does NOT emit a KB-changed event, so the tree won't
//     show the note until entries are reloaded. Every working saver reloads.
//   * The note also needs a `knowledge_meta_patch` title, or the KB tree shows
//     the raw timestamp id instead of a readable name.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
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
