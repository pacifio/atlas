/**
 * Security scan results the Timeline shows (ATL-985), mirrored from Rust.
 *
 * Rust owns the results in each Project's session store; this keeps what the
 * open board and session detail have read, keyed by Project, and applies a
 * "Not useful" mark locally at once so the badge and card update before the
 * write returns.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import {
  securityProjectSessions,
  securitySessionCheckpoints,
  securitySetNotUseful,
} from "../lib/security-api";
import { recount, summarize } from "../lib/security-levels";
import type { CheckpointSecurity, SecurityFinding, SessionSecurity } from "../types";

const sessionKey = (projectPath: string, sessionId: string) => `${projectPath}\u0000${sessionId}`;

/**
 * `next`, with every row equal to the one it replaces kept as the previous
 * object — and the previous array itself when no row changed.
 *
 * A stored scan re-reads the Project's badges and every open session's
 * checkpoints, and nearly all of what comes back is what was already here.
 * Swapping in fresh objects anyway re-rendered every Checkpoint card and
 * every finding in the open session on each scan pass: a ~65ms hitch per pass
 * on an 800-row session, mid-scroll. Rows are small, so comparing their JSON
 * is cheap next to the render it saves.
 */
function keepUnchanged<T>(prev: readonly T[] | undefined, next: T[], key: (row: T) => string): T[] {
  if (!prev) return next;
  const before = new Map(prev.map((row) => [key(row), row] as const));
  let changed = prev.length !== next.length;
  const out = next.map((row, i) => {
    const old = before.get(key(row));
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(row)) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return row;
  });
  return changed ? out : (prev as T[]);
}

interface SecurityState {
  /** Badges, by Project then session. */
  sessions: Record<string, Record<string, SessionSecurity>>;
  /** Checkpoint results, by Project + session. */
  checkpoints: Record<string, CheckpointSecurity[]>;
  actions: {
    loadProject: (projectPath: string) => Promise<void>;
    loadSession: (projectPath: string, sessionId: string) => Promise<CheckpointSecurity[]>;
    /** A scan landed: re-read the badges and every session already read. */
    refreshProject: (projectPath: string) => Promise<void>;
    setNotUseful: (
      projectPath: string,
      sessionId: string,
      finding: SecurityFinding,
      notUseful: boolean,
    ) => Promise<void>;
  };
}

export const useSecurityStore = createSelectors(
  create<SecurityState>()(
    immer((set, get) => ({
      sessions: {},
      checkpoints: {},
      actions: {
        loadProject: async (projectPath) => {
          if (!projectPath) return;
          const rows = await securityProjectSessions(projectPath).catch(() => null);
          if (!rows) return;
          const prevMap = get().sessions[projectPath];
          const kept = keepUnchanged(
            prevMap ? Object.values(prevMap) : undefined,
            rows,
            (r) => r.sessionId,
          );
          if (
            prevMap &&
            Object.keys(prevMap).length === kept.length &&
            kept.every((r) => prevMap[r.sessionId] === r)
          )
            return;
          set((s) => {
            s.sessions[projectPath] = Object.fromEntries(kept.map((r) => [r.sessionId, r]));
          });
        },
        loadSession: async (projectPath, sessionId) => {
          if (!projectPath) return [];
          const key = sessionKey(projectPath, sessionId);
          const fresh = await securitySessionCheckpoints(projectPath, sessionId).catch(() => null);
          const prev = get().checkpoints[key];
          if (!fresh) return prev ?? [];
          const cps = keepUnchanged(prev, fresh, (c) => c.commitSha);
          if (cps !== prev)
            set((s) => {
              s.checkpoints[key] = cps;
            });
          return cps;
        },
        refreshProject: async (projectPath) => {
          const prefix = sessionKey(projectPath, "");
          const open = Object.keys(get().checkpoints)
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length));
          const { loadProject, loadSession } = get().actions;
          await Promise.all([
            loadProject(projectPath),
            ...open.map((id) => loadSession(projectPath, id)),
          ]);
        },
        setNotUseful: async (projectPath, sessionId, finding, notUseful) => {
          const key = sessionKey(projectPath, sessionId);
          const apply = (value: boolean) =>
            set((s) => {
              const cps = (s.checkpoints[key] ?? []).map((cp) =>
                recount({
                  ...cp,
                  findings: cp.findings.map((f) =>
                    f.fingerprint === finding.fingerprint ? { ...f, notUseful: value } : f,
                  ),
                }),
              );
              s.checkpoints[key] = cps;
              (s.sessions[projectPath] ??= {})[sessionId] = summarize(sessionId, cps);
            });
          apply(notUseful);
          try {
            await securitySetNotUseful(projectPath, finding.fingerprint, finding.ruleId, notUseful);
          } catch {
            apply(!notUseful);
          }
        },
      },
    })),
  ),
);

/** A session's checkpoint results, as last read. */
export function selectCheckpoints(
  state: { checkpoints: Record<string, CheckpointSecurity[]> },
  projectPath: string,
  sessionId: string,
): CheckpointSecurity[] | undefined {
  return state.checkpoints[sessionKey(projectPath, sessionId)];
}
