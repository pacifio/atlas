/**
 * `ui_open`: open something and make it the active tab, through the opener
 * the app already uses for it. There is deliberately no project target —
 * UI actions never switch projects.
 */

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { TabType } from "@/lib/constants";
import { openFile, type RevealTarget } from "@/lib/open-file";
import { openGitDiff } from "@/features/git/lib/git-diff-api";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { SETTINGS_SECTIONS } from "@/features/settings/stores/settings-nav-store";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useChatStore, findTabByAcpSession } from "@/features/chat/stores/chat-store";
import { openAgentSession, openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { threadProjects } from "@/features/chat/lib/history-api";
import { resumeAgentFor } from "@/features/chat/lib/sidebar-agents";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { conversationTitle } from "@/features/comms/lib/derive";
import { spacesApi } from "@/features/spaces/lib/spaces-api";
import { openSpaceOnPage } from "@/features/spaces/lib/open-space";
import { readArgs, refuse } from "./args";
import { activeProject, resolvePath, tabInScope } from "./scope";
import type { UiActionRequest } from "./types";

const TARGETS = [
  "file",
  "diff",
  "settings",
  "tab",
  "thread",
  "new_chat",
  "timeline",
  "url",
  "knowledge",
  "space_page",
] as const;

/** Tab types that open with no data of their own, one per column. Files,
 *  diffs, chats and terminals have their own targets and tools. */
const PLAIN_TABS: Record<string, string> = {
  canvas: "Spaces",
  browser: "Browser",
  tasks: "Tasks",
  knowledge: "Knowledge",
  "knowledge-graph": "Knowledge Graph",
  memory: "Memory",
  settings: "Settings",
  log: "Logs",
  usage: "Usage",
  artifacts: "Timeline",
};

const layout = () => useLayoutStore.getState();

/** Open a one-per-column tab and return the id it ended up with (an existing
 *  tab in the focused column wins over the id asked for). */
function openPlainTab(type: string, data: Record<string, unknown> = {}): string {
  layout().actions.addTab({
    id: type,
    type: type as TabType,
    title: PLAIN_TABS[type] ?? type,
    closable: true,
    dirty: false,
    data,
  });
  return layout().activeTabId ?? type;
}

export async function performOpen(request: UiActionRequest): Promise<unknown> {
  const a = readArgs("ui_open", request.args);
  const target = request.args.target;
  if (typeof target !== "string")
    return refuse(`ui_open: target is required; one of ${TARGETS.join(", ")}`);
  switch (target) {
    case "file": {
      const path = await resolvePath(a.str("path"), request.cwd);
      const line = a.optInt("line");
      const reveal: RevealTarget | undefined = line
        ? {
            line,
            column: a.optInt("column"),
            endLine: a.optInt("endLine"),
            endColumn: a.optInt("endColumn"),
          }
        : undefined;
      return { tabId: await openFile(path, reveal ? { reveal } : undefined), path };
    }
    case "diff": {
      const repoPath = a.optStr("repoPath") ?? activeProject().path;
      const abs = await resolvePath(a.str("path"), request.cwd);
      if (!abs.startsWith(`${repoPath}/`))
        return refuse(`${abs} is outside the repository ${repoPath}`);
      const file = abs.slice(repoPath.length + 1);
      openGitDiff(repoPath, file, a.optBool("staged") ?? false, a.optStr("commit"));
      return { tabId: layout().activeTabId, repoPath, file };
    }
    case "settings": {
      openSettingsSection(a.optOneOf("section", SETTINGS_SECTIONS) ?? "general");
      return { tabId: layout().activeTabId };
    }
    case "tab": {
      const type = a.str("type");
      if (!(type in PLAIN_TABS)) {
        return refuse(
          `ui_open: type must be one of ${Object.keys(PLAIN_TABS).join(", ")}; open a file with target "file", a diff with "diff", a chat with "new_chat" or "thread"`,
        );
      }
      return { tabId: openPlainTab(type) };
    }
    case "thread":
      return { tabId: await openThread(a.str("sessionId")) };
    case "new_chat": {
      openNewAgentChat(a.optStr("agent"));
      return { tabId: layout().activeTabId };
    }
    case "timeline": {
      const tabId = openPlainTab("artifacts");
      const sessionId = a.optStr("sessionId");
      if (sessionId)
        useArtifactsStore
          .getState()
          .actions.openSession({ sessionId, projectPath: activeProject().path });
      return { tabId };
    }
    case "url": {
      const url = a.str("url");
      const { focusedGroupId, tabs } = layout();
      const existing = tabs.find(
        (t) => t.type === "browser" && (t.groupId ?? "main") === focusedGroupId,
      );
      const tabId = openPlainTab("browser", { url });
      // A mounted browser tab read its URL once, when it mounted.
      if (existing)
        window.dispatchEvent(new CustomEvent("atlas:browser-navigate", { detail: { tabId, url } }));
      return { tabId, url };
    }
    case "knowledge": {
      const noteId = a.str("noteId");
      const tabId = openPlainTab("knowledge");
      useKnowledgeStore.getState().actions.requestOpen(noteId);
      return { tabId, noteId };
    }
    case "space_page":
      return openSpacePage(a.str("conversationId"), a.str("pageId"));
    default:
      return refuse(`ui_open: unknown target "${target}"; one of ${TARGETS.join(", ")}`);
  }
}

/** Open a conversation's Space on one of its pages — the way the
 *  conversation's own Space button opens it, landed on the page. The
 *  conversation must be one this window's chat holds, and the page a page
 *  (not a folder) in its Space's tree, read afresh. Spaces are the
 *  organisation's, not a project's, so no project is involved. */
async function openSpacePage(convId: string, pageId: string) {
  const comms = useCommsStore.getState();
  const conv = comms.conversations.find((c) => c.id === convId);
  if (!conv)
    return refuse(
      `no conversation ${convId} in this window's organisation chat; you may not be in it`,
    );
  let pages;
  try {
    pages = (await spacesApi.summary(convId)).pages;
  } catch (e) {
    return refuse(
      `the conversation's Space could not be read: ${typeof e === "string" ? e : String(e)}`,
    );
  }
  const page = pages.find((p) => p.id === pageId);
  if (!page) return refuse(`the conversation's Space has no page ${pageId}`);
  if (page.kind !== "page") return refuse(`"${page.name}" is a folder, not a page`);
  const members = new Map(comms.members.map((m) => [m.id, m]));
  const tabId = openSpaceOnPage(convId, conversationTitle(conv, members, comms.me), pageId);
  return { tabId, conversationId: convId, pageId, page: page.name };
}

/** Focus a thread's chat if it is open here, else resume it from the active
 *  project's history — the same path as clicking it in the sidebar. */
async function openThread(sessionId: string): Promise<string | null> {
  const open = findTabByAcpSession(useChatStore.getState().sessions, sessionId);
  if (open) {
    tabInScope(open);
    layout().actions.setActiveTab(open);
    return open;
  }
  const project = activeProject();
  const projects = await threadProjects(project.path);
  const row = projects
    .filter((p) => p.isCurrent)
    .flatMap((p) => p.threads)
    .find((t) => t.sessionId === sessionId);
  if (!row) return refuse(`no thread ${sessionId} in project "${project.name}"`);
  await openAgentSession({
    acpSessionId: sessionId,
    title: row.title,
    cwd: row.folderPaths[0] ?? project.path,
    agentType: resumeAgentFor(row.agentId),
  });
  return findTabByAcpSession(useChatStore.getState().sessions, sessionId) ?? layout().activeTabId;
}
