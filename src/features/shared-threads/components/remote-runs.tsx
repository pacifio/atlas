import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Send, Timer } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { agents, ensureAgent } from "@/features/chat/lib/agents-api";
import { openAgentSession } from "@/features/chat/lib/open-agent-session";
import { agentMeta, useSwitchableAgents } from "@/features/agents/lib/agent-meta";
import { pluginIdForAgent } from "@/types/agent";

import {
  answerRemoteRun,
  executeRemoteRun,
  remoteRunners,
  requestRemoteRun,
  runWorktree,
  setRemoteSettings,
  sharedThreadError,
  type RemoteRun,
  type RemoteRunners,
  type RemoteRunStatus,
  type SharedThreadError,
  type SharedThreadView,
} from "../lib/shared-threads-api";
import { usePeers, useSharedThreadsStore } from "../stores/shared-threads-store";
import { usePersonName } from "../lib/use-person-name";

/**
 * Remote Runs on the desktop (ADR-0023, ATL-417): ask a teammate's agent to
 * run a prompt in the thread, or — as that teammate — see exactly what will
 * run on this machine and on whose bill, and approve or decline it.
 */

const SELECT_CLASS =
  "h-7 min-w-0 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none disabled:opacity-40";

const STATUS: Record<RemoteRunStatus, { label: string; variant: "secondary" | "success" | "outline" | "warning" }> = {
  pending: { label: "Waiting for approval", variant: "secondary" },
  approved: { label: "Approved", variant: "success" },
  executed: { label: "Started", variant: "success" },
  declined: { label: "Declined", variant: "outline" },
  timed_out: { label: "Timed out", variant: "warning" },
};

/** Requests waiting for this person's answer, oldest first, across every joined thread. */
export function pendingForMe(threads: SharedThreadView[]): Array<{ thread: SharedThreadView; request: RemoteRun }> {
  return threads
    .flatMap((thread) => {
      const remote = thread.status.remote;
      if (!remote?.userId) return [];
      return remote.requests
        .filter((r) => r.status === "pending" && r.runnerId === remote.userId)
        .map((request) => ({ thread, request }));
    })
    .sort((a, b) => a.request.requestedAt - b.request.requestedAt);
}

/** Approved requests this person is to run and has not started. */
export function approvedForMe(threads: SharedThreadView[]): Array<{ thread: SharedThreadView; request: RemoteRun }> {
  return threads.flatMap((thread) => {
    const remote = thread.status.remote;
    if (!remote?.userId) return [];
    return remote.requests
      // The server approved it; this machine checks again before it runs an
      // agent on this person's bill (and the backend checks a third time).
      .filter(
        (r) =>
          r.status === "approved" &&
          r.runId === null &&
          r.runnerId === remote.userId &&
          remote.accept &&
          remote.agents.includes(r.agent) &&
          (!r.auto || remote.autoApprove === r.requestedBy),
      )
      .map((request) => ({ thread, request }));
  });
}

/** Whole seconds left before `expiresAt`, never below zero. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * What the Runner is asked (ATL-417): who asks, in which thread, the exact
 * prompt and agent, and that it runs on this machine and bills this person.
 * Approve or Decline; the countdown declines when it reaches zero.
 */
export function RemoteRunApproval({
  request,
  threadTitle,
  nameOf,
  now,
  onAnswer,
}: {
  request: RemoteRun;
  threadTitle: string;
  nameOf: (userId: string) => string;
  now: number;
  onAnswer: (approve: boolean, alwaysApprove: boolean) => void;
}) {
  const [always, setAlways] = useState(false);
  const left = secondsLeft(request.expiresAt, now);
  const answered = useRef(false);
  const answer = (approve: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(approve, approve && always);
  };
  useEffect(() => {
    if (left === 0) answer(false);
    // `answer` is stable enough: it only reads refs and the checkbox.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);
  const asker = nameOf(request.requestedBy);
  return (
    <div className="flex flex-col gap-3 text-xs">
      <DialogHeader>
        <DialogTitle>{asker} wants to run an agent on your machine</DialogTitle>
        <DialogDescription>
          In <span className="font-medium text-[var(--foreground)]">{threadTitle}</span>. It runs here, with
          your agent and on your bill, exactly as written below.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-1.5 text-[var(--secondary-foreground)]">
        <Bot size={12} className="shrink-0 text-[var(--muted-foreground)]" />
        <span>{agentMeta(request.agent).label}</span>
        {request.model && <span className="font-mono text-[var(--muted-foreground)]">{request.model}</span>}
      </div>
      <pre
        aria-label="Prompt"
        className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-[var(--atlas-border-subtle)] bg-[var(--background)] p-2 font-mono text-[var(--foreground)]"
      >
        {request.prompt}
      </pre>
      <label className="flex cursor-pointer items-center gap-2 text-[var(--secondary-foreground)]">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          className="size-3 cursor-pointer accent-[var(--primary)]"
        />
        Always approve {asker} in this thread
      </label>
      <DialogFooter className="items-center">
        <span className="mr-auto flex items-center gap-1 tabular-nums text-[var(--muted-foreground)]">
          <Timer size={11} /> Declines in {left}s
        </span>
        <Button size="sm" variant="outline" onClick={() => answer(false)}>
          Decline
        </Button>
        <Button size="sm" onClick={() => answer(true)}>
          Approve and run
        </Button>
      </DialogFooter>
    </div>
  );
}

/** The current second, ticking while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/**
 * Lives at the app root: asks the Runner about each pending request, one at
 * a time, and executes approved ones — by hand or by auto-approve — as a Run
 * in the thread's Run worktree with the exact prompt asked for.
 */
export function RemoteRunHost() {
  const threads = useSharedThreadsStore.use.threads();
  const load = useSharedThreadsStore.use.load();
  const nameOf = usePersonName();
  useEffect(() => {
    void load();
  }, [load]);

  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const asking = pendingForMe(threads).find(({ request }) => !answered.has(request.requestId)) ?? null;
  const now = useNow(asking !== null);

  async function answer(thread: SharedThreadView, request: RemoteRun, approve: boolean, always: boolean) {
    setAnswered((s) => new Set(s).add(request.requestId));
    try {
      await answerRemoteRun(thread.sharedThreadId, request.requestId, approve);
    } catch (e) {
      toast.error(sharedThreadError(e).message);
      return;
    }
    // The answer stands whether or not the auto-approve could be saved.
    if (always) {
      await setRemoteSettings(thread.sharedThreadId, { autoApprove: request.requestedBy }).catch((e) =>
        toast.error(`Could not turn on auto-approve: ${sharedThreadError(e).message}`),
      );
    }
  }

  // Approved: run it, once.
  const started = useRef(new Set<string>());
  const toRun = approvedForMe(threads);
  useEffect(() => {
    for (const { thread, request } of toRun) {
      if (started.current.has(request.requestId)) continue;
      started.current.add(request.requestId);
      void execute(thread, request, nameOf).catch((e) =>
        toast.error(`Could not start the Remote Run: ${sharedThreadError(e).message}`),
      );
    }
  }, [toRun, nameOf]);

  return (
    <Dialog open={asking !== null}>
      <DialogContent showCloseButton={false}>
        {asking && (
          <RemoteRunApproval
            key={asking.request.requestId}
            request={asking.request}
            threadTitle={asking.thread.title}
            nameOf={nameOf}
            now={now}
            onAnswer={(approve, always) => void answer(asking.thread, asking.request, approve, always)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Open the request's agent in the thread's Run worktree, tie that session to
 * the request, and send it the prompt.
 */
async function execute(thread: SharedThreadView, request: RemoteRun, nameOf: (userId: string) => string) {
  const cwd = await runWorktree(thread.sharedThreadId);
  const agent = await ensureAgent(pluginIdForAgent(request.agent));
  const { key } = await agents.newSession(agent.agent_id, cwd);
  const prompt = await executeRemoteRun(thread.sharedThreadId, request.requestId, key.session_id);
  await openAgentSession({
    acpSessionId: key.session_id,
    title: `${thread.title} · Remote Run for ${nameOf(request.requestedBy)}`,
    cwd,
    agentType: request.agent,
  });
  await agents.send(key, prompt);
}

/**
 * The panel's Remote Runs: "Accept Remote Runs" for this machine, who is
 * auto-approved, asking a teammate's agent, and where this person's asks
 * stand — pending, approved, declined or timed out.
 */
export function RemoteRunsSection({ thread, mayRun }: { thread: SharedThreadView; mayRun: boolean }) {
  const remote = thread.status.remote;
  const nameOf = usePersonName();
  const offered = useSwitchableAgents();
  const peers = usePeers(thread.sharedThreadId);
  const [error, setError] = useState<SharedThreadError | null>(null);
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<RemoteRunners | null>(null);

  // Who may be asked changes with presence: read it again whenever it does.
  const presence = useMemo(() => peers.map((p) => `${p.peerId}:${p.role}`).join(","), [peers]);
  useEffect(() => {
    if (!mayRun || !thread.status.connected) return;
    let live = true;
    remoteRunners(thread.sharedThreadId)
      .then((r) => live && setTargets(r))
      .catch(() => live && setTargets(null));
    return () => {
      live = false;
    };
  }, [thread.sharedThreadId, mayRun, thread.status.connected, presence]);

  if (!remote || !mayRun) return null;
  const me = remote.userId;
  const mine = remote.requests.filter((r) => r.requestedBy === me).slice(0, 5);

  async function act(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(sharedThreadError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-1.5" aria-label="Remote Runs">
      <span className="text-2xs uppercase tracking-wide text-[var(--muted-foreground)]">Remote Runs</span>
      <label className="flex cursor-pointer items-center gap-2 text-[var(--secondary-foreground)]">
        <input
          type="checkbox"
          checked={remote.accept}
          disabled={busy || !thread.status.connected}
          onChange={(e) =>
            void act(() =>
              setRemoteSettings(thread.sharedThreadId, {
                accept: e.target.checked,
                ...(e.target.checked ? { agents: offered } : {}),
              }),
            )
          }
          className="size-3 cursor-pointer accent-[var(--primary)]"
        />
        Accept Remote Runs — teammates may ask your agents to run here, on your bill
      </label>
      {remote.accept && remote.autoApprove && (
        <span className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
          Auto-approving {nameOf(remote.autoApprove)}
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(() => setRemoteSettings(thread.sharedThreadId, { autoApprove: null }))}
          >
            Stop
          </Button>
        </span>
      )}
      {targets && targets.gate === null && targets.runners.length > 0 && (
        <AskTeammate
          runners={targets.runners}
          nameOf={nameOf}
          busy={busy}
          onAsk={(runner, agent, prompt) =>
            act(() => requestRemoteRun(thread.sharedThreadId, runner, agent, prompt))
          }
        />
      )}
      {mine.map((r) => (
        <div
          key={r.requestId}
          className="flex items-center gap-1.5 rounded border border-[var(--atlas-border-subtle)] px-2 py-1"
        >
          <span className="min-w-0 flex-1 truncate text-[var(--secondary-foreground)]" title={r.prompt}>
            {nameOf(r.runnerId)}&apos;s {agentMeta(r.agent).label}: {r.prompt}
          </span>
          <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
        </div>
      ))}
      {error && <p className="text-error">{error.message}</p>}
    </section>
  );
}

/** The run-target picker: a teammate's agent, and the prompt to send it. */
export function AskTeammate({
  runners,
  nameOf,
  busy,
  onAsk,
}: {
  runners: RemoteRunners["runners"];
  nameOf: (userId: string) => string;
  busy: boolean;
  onAsk: (runner: string, agent: string, prompt: string) => Promise<unknown>;
}) {
  const options = runners.flatMap((r) => r.agents.map((agent) => ({ runner: r.userId, agent })));
  // Keyed by who and which agent, not by position: the list is read again on
  // every presence change, and an index would then point at somebody else.
  const keyOf = (o: { runner: string; agent: string }) => `${o.runner}|${o.agent}`;
  const [choice, setChoice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const target = options.find((o) => keyOf(o) === choice) ?? options[0];
  if (!target) return null;
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (prompt.trim() === "") return;
        void onAsk(target.runner, target.agent, prompt.trim()).then(() => setPrompt(""));
      }}
    >
      <select
        aria-label="Run on"
        value={keyOf(target)}
        onChange={(e) => setChoice(e.target.value)}
        className={SELECT_CLASS}
      >
        {options.map((o) => (
          <option key={keyOf(o)} value={keyOf(o)}>
            Ask {nameOf(o.runner)}&apos;s {agentMeta(o.agent).label}
          </option>
        ))}
      </select>
      <textarea
        aria-label="Prompt for a teammate's agent"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        placeholder="What should their agent do?"
        className="w-full resize-y rounded border border-[var(--atlas-border-subtle)] bg-[var(--background)] p-1.5 text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
      />
      <Button size="xs" variant="outline" className="self-start" type="submit" disabled={busy || prompt.trim() === ""}>
        <Send size={11} /> Ask
      </Button>
    </form>
  );
}
