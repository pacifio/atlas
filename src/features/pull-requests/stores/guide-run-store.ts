// Guide runs in flight: one background agent session per pull request,
// writing its review guide.
//
// A run, start to finish (`writeGuide`):
//
//   1. `pr_guide_prepare` — a detached worktree at the head commit, and the
//      change it makes (files and hunk ranges);
//   2. a session on the guide's agent (`guideAgentFor`: the
//      `pullRequestGuideAgent` setting, else the default agent) in that
//      worktree, on the `pullRequestGuideModel` model when one is set, sent
//      the guide prompt (`buildGuidePrompt`, with the user's
//      `pullRequestGuideInstructions`). No tab shows it; the Guide tab shows
//      its progress, and any permission it asks for, inline;
//   3. once the agent is idle again, its last answer is read as a guide,
//      fitted to the change (`normalizeGuide`) and kept for the head commit
//      (`pr_guide_write`);
//   4. the session is dropped and its history row deleted, and the worktree
//      removed, whatever happened;
//   5. the user is told it is ready, or failed (`notifyGuideRun`): a toast
//      with Open while they are elsewhere in Atlas, an OS banner while away,
//      nothing while that pull request's Guide is on screen (`shownKey`).
//      Open asks the tab for its Guide (`requestOpen`).
//
// The run belongs to the window, not the tab: closing the pull request tab
// does not stop it, and opening the tab again shows it still running. It is
// in memory only; an app quit ends it, and the next run prunes what it left.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { agents, ensureAgent } from "@/features/chat/lib/agents-api";
import { defaultAgentForNewSession } from "@/features/chat/lib/default-agent";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { projectSettingNow } from "@/features/settings/lib/use-scoped-setting";
import { deleteThread, threadHistory } from "@/features/chat/lib/history-api";
import { NATIVE_AGENT_ID, pluginIdForAgent, type SwitchableAgent } from "@/types/agent";
import type { SessionKey, SessionMessage } from "@/types/agents";
import { normalizeGuide } from "../lib/pull-request-guide-normalize";
import { buildGuidePrompt, guidePromptInput } from "../lib/pull-request-guide-prompt";
import { parseGeneratedGuide, type PullRequestGuide } from "../lib/pull-request-guide-types";
import { notifyGuideRun } from "../lib/guide-notifier";
import { prGuideFinish, prGuidePrepare, prGuideWrite } from "../lib/pull-requests-api";
import type { PrActivity, PrDetail } from "../lib/pull-requests-types";

/** The reference's ceiling on one investigation. */
const RUN_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 1_500;
/** A turn that never reported running is read anyway after this long. */
const QUIET_START_MS = 20_000;

export type GuideRunPhase = "checkout" | "reading" | "saving";

export type GuideRun =
  | {
      status: "running";
      phase: GuideRunPhase;
      headSha: string;
      startedAt: number;
      agentLabel: string;
      /** The background session, once it exists: the tab reads its pending
       *  permission requests by `session_id`. */
      session: SessionKey | null;
    }
  | { status: "failed"; headSha: string; failedAt: number; detail: string };

interface GuideRunState {
  runs: Record<string, GuideRun>;
  setRun: (key: string, run: GuideRun | null) => void;
  /** The pull request (`guideRunKey`) whose Guide is on screen, if any: its
   *  run ending there needs no notification. */
  shownKey: string | null;
  setShown: (key: string | null) => void;
  /** Asks a pull request's tab to show its Guide (a notification's Open).
   *  The tab takes the ask once it is mounted (`takeOpenRequest`). */
  openRequests: Record<string, number>;
  requestOpen: (key: string) => void;
  takeOpenRequest: (key: string) => void;
}

export function guideRunKey(repoPath: string, number: number): string {
  return `${repoPath}:${number}`;
}

const useGuideRunStoreBase = create<GuideRunState>()((set) => ({
  runs: {},
  setRun: (key, run) =>
    set((state) => {
      const runs = { ...state.runs };
      if (run === null) delete runs[key];
      else runs[key] = run;
      return { runs };
    }),
  shownKey: null,
  setShown: (key) => set({ shownKey: key }),
  openRequests: {},
  requestOpen: (key) =>
    set((state) => ({
      openRequests: { ...state.openRequests, [key]: (state.openRequests[key] ?? 0) + 1 },
    })),
  takeOpenRequest: (key) =>
    set((state) => {
      if (!(key in state.openRequests)) return state;
      const { [key]: _taken, ...rest } = state.openRequests;
      return { openRequests: rest };
    }),
}));

export const useGuideRunStore = createSelectors(useGuideRunStoreBase);

/**
 * The agent that writes `projectPath`'s guides: `pullRequestGuideAgent` when
 * it names an installed agent (or Atlas Agent), the default agent for new
 * sessions when it is empty, Atlas Agent when it names one not installed.
 */
export function guideAgentFor(projectPath: string): SwitchableAgent {
  const wanted = projectSettingNow(projectPath, "pullRequestGuideAgent").trim();
  if (!wanted) return defaultAgentForNewSession(projectPath);
  if (wanted === NATIVE_AGENT_ID) return NATIVE_AGENT_ID;
  const entry = useAgentRegistryStore.getState().catalogById[wanted];
  return entry?.installed ? entry.agentType : NATIVE_AGENT_ID;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The agent's answer: its last non-empty text message after the prompt, or
 *  every text message after it joined when that one does not parse. */
export function answerCandidates(messages: readonly SessionMessage[]): string[] {
  let lastUser = -1;
  messages.forEach((m, index) => {
    if (m.role === "user") lastUser = index;
  });
  const replies = messages
    .slice(lastUser + 1)
    .filter((m) => m.role === "assistant" && m.mode === "text" && m.content.trim() !== "");
  const last = replies[replies.length - 1]?.content;
  return last === undefined ? [] : [last, replies.map((m) => m.content).join("\n")];
}

async function waitForAnswer(key: SessionKey): Promise<SessionMessage[]> {
  const started = Date.now();
  let seenBusy = false;
  for (;;) {
    if (Date.now() - started > RUN_TIMEOUT_MS) {
      await agents.cancel(key).catch(() => undefined);
      throw new Error("The agent took longer than 15 minutes, so the run was stopped.");
    }
    await sleep(POLL_MS);
    const meta = await agents.snapshotMeta(key);
    if (meta.status === "running" || meta.status === "waiting") {
      seenBusy = true;
      continue;
    }
    if (meta.status === "error") throw new Error("The agent stopped with an error.");
    if (seenBusy || Date.now() - started > QUIET_START_MS) {
      return (await agents.snapshot(key)).messages;
    }
  }
}

async function forgetSession(key: SessionKey): Promise<void> {
  await agents.dropSession(key.agent_id, key.session_id).catch(() => undefined);
  // The run's session was never the user's: its history row goes too.
  const rows = await threadHistory().catch(() => []);
  const row = rows.find((r) => r.sessionId === key.session_id);
  if (row) await deleteThread(row.threadId).catch(() => undefined);
}

function describe(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = String((err as { message: unknown }).message);
    if (message) return message;
  }
  return typeof err === "string" && err ? err : "The guide could not be written.";
}

/**
 * Write a guide for the pull request's current head with `agent`. Resolves
 * once the run has ended; a second call while one is running is a no-op.
 * `onSaved` is told when a new guide has been kept.
 */
export async function writeGuide(opts: {
  repoPath: string;
  detail: PrDetail;
  activity: PrActivity | null;
  agent: SwitchableAgent;
  agentLabel: string;
  onSaved: () => void;
}): Promise<void> {
  const { repoPath, detail, activity, agent, agentLabel, onSaved } = opts;
  const key = guideRunKey(repoPath, detail.number);
  const store = useGuideRunStoreBase.getState();
  if (store.runs[key]?.status === "running") return;
  const headSha = detail.headSha;
  if (!headSha) {
    store.setRun(key, {
      status: "failed",
      headSha: "",
      failedAt: Date.now(),
      detail: "GitHub did not report the pull request's head commit.",
    });
    return;
  }
  const running = (phase: GuideRunPhase, session: SessionKey | null) =>
    useGuideRunStoreBase.getState().setRun(key, {
      status: "running",
      phase,
      headSha,
      startedAt: Date.now(),
      agentLabel,
      session,
    });
  running("checkout", null);

  let runId: string | null = null;
  let session: SessionKey | null = null;
  try {
    const checkout = await prGuidePrepare(repoPath, detail);
    runId = checkout.runId;
    const info = await ensureAgent(pluginIdForAgent(agent));
    session = (await agents.newSession(info.agent_id, checkout.path)).key;
    running("reading", session);
    // A model the agent does not offer is refused; the agent's default stays.
    const model = projectSettingNow(repoPath, "pullRequestGuideModel").trim();
    if (model) await agents.setModel(session, model).catch(() => undefined);
    const instructions = projectSettingNow(repoPath, "pullRequestGuideInstructions");
    await agents.send(
      session,
      buildGuidePrompt(guidePromptInput(detail, activity, checkout.baseCommit, instructions)),
    );
    const messages = await waitForAnswer(session);
    running("saving", session);
    const generated = answerCandidates(messages)
      .map(parseGeneratedGuide)
      .find((g) => g !== null && g.stops.length > 0);
    if (!generated) {
      throw new Error(`${agentLabel} did not answer with a guide. Try again, or another agent.`);
    }
    const guide: PullRequestGuide = {
      headSha,
      generatedAt: new Date().toISOString(),
      agent,
      ...normalizeGuide(generated, checkout.change),
    };
    await prGuideWrite(detail.repository, detail.number, guide);
    useGuideRunStoreBase.getState().setRun(key, null);
    onSaved();
    notifyGuideRun({ repoPath, number: detail.number, title: detail.title, failure: null });
  } catch (err) {
    const failure = describe(err);
    useGuideRunStoreBase.getState().setRun(key, {
      status: "failed",
      headSha,
      failedAt: Date.now(),
      detail: failure,
    });
    notifyGuideRun({ repoPath, number: detail.number, title: detail.title, failure });
  } finally {
    if (session) await forgetSession(session);
    if (runId) await prGuideFinish(repoPath, runId);
  }
}
