// Node runtime state machine. The ACP coding agents launch via `npx`, which
// needs a working Node. `atlas_acp::sanitize_host_env` already enriches PATH so
// an installed-but-not-on-the-GUI-PATH Node is found; this store handles the
// two cases that can't fix:
//   - no Node anywhere → auto-install the latest LTS via the bundled nvm
//   - a Node that's present but too old → same install (the managed copy then
//     wins over the system one for agent spawns)
//
// Non-blocking: the install runs in the background with a pill above the chat
// composer; the rest of the app stays usable. When Node becomes ready we drop
// any cached/failed agent spawns and re-probe Claude so ACP discovery re-runs.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { resetAgent } from "@/features/chat/lib/agents-api";
import { logEvent } from "@/features/log/lib/log";
import {
  nodeSetup,
  listenNodeInstallDone,
  listenNodeInstallProgress,
  type NodeStatus,
} from "../lib/node-setup-api";

export type NodeSetupPhase =
  | "idle" // not checked yet
  | "checking" // probing node_check
  | "ok" // a compatible Node is available (banner hidden)
  | "installing" // bundled-nvm install in flight
  | "installed" // brief success flash before → ok
  | "failed"; // install failed (retry offered)

/** Why we're installing — surfaced in the pill copy. */
export type NodeInstallReason = "missing" | "incompatible" | null;

const LOG_LINE_CAP = 50;
const SUCCESS_FLASH_MS = 1000;

interface NodeSetupState {
  phase: NodeSetupPhase;
  reason: NodeInstallReason;
  /** Version that was found (for the "Node X is too old" message). */
  foundVersion: string | null;
  minMajor: number;
  installLog: string[];
  installError: string | null;
  actions: {
    /** Probe Node; auto-install via bundled nvm if missing/incompatible. */
    check: () => Promise<void>;
    /** Start (or retry) the bundled-nvm install. */
    install: () => Promise<void>;
  };
}

export const useNodeSetupStore = createSelectors(
  create<NodeSetupState>((set, get) => {
    let installUnlistens: Array<() => void> = [];
    const clearInstallListeners = () => {
      for (const u of installUnlistens) {
        try {
          u();
        } catch {
          // ignore
        }
      }
      installUnlistens = [];
    };

    function reasonFromStatus(s: NodeStatus): NodeInstallReason {
      if (s.status === "missing") return "missing";
      if (s.status === "incompatible") return "incompatible";
      return null;
    }

    async function check(): Promise<void> {
      const cur = get().phase;
      if (cur === "installing" || cur === "installed") return;
      set({ phase: "checking" });
      let status: NodeStatus;
      try {
        status = await nodeSetup.check();
      } catch (e) {
        console.warn("node_check invoke failed:", e);
        // If we can't even probe, don't block the app — assume PATH enrichment
        // covers it and let the agent spawn surface a real error if not.
        set({ phase: "ok" });
        return;
      }
      set({ minMajor: status.minMajor, foundVersion: status.version });
      logEvent({
        source: "atlas",
        kind: "node-status",
        summary: `node status: ${status.status}${status.version ? ` (${status.version})` : ""}${status.managed ? " [managed]" : ""}`,
        status: status.status === "ok" ? "success" : "pending",
        payload: { ...status },
      });
      if (status.status === "ok") {
        set({ phase: "ok", reason: null });
        return;
      }
      // Missing or incompatible → auto-install the bundled LTS.
      set({ reason: reasonFromStatus(status) });
      await install();
    }

    async function install(): Promise<void> {
      clearInstallListeners();
      set({ phase: "installing", installLog: [], installError: null });
      logEvent({
        source: "atlas",
        kind: "node-install-started",
        summary: `Installing Node via bundled nvm (reason: ${get().reason ?? "manual"})`,
        status: "pending",
      });

      const progressUnlisten = await listenNodeInstallProgress((p) => {
        set((s) => {
          const next = [...s.installLog, p.line];
          if (next.length > LOG_LINE_CAP) next.splice(0, next.length - LOG_LINE_CAP);
          return { installLog: next };
        });
      });
      const doneUnlisten = await listenNodeInstallDone((p) => {
        clearInstallListeners();
        if (p.success) {
          logEvent({
            source: "atlas",
            kind: "node-install-done",
            summary: `Node ready: ${p.version ?? "(unknown)"} at ${p.path ?? "(unknown)"}`,
            status: "success",
            payload: { version: p.version, path: p.path },
          });
          set({ phase: "installed", foundVersion: p.version });
          // Node now resolvable (registered as managed bin in Rust). Drop any
          // cached/failed agent spawns and re-run ACP discovery.
          resetAgent();
          setTimeout(() => set({ phase: "ok", reason: null }), SUCCESS_FLASH_MS);
        } else {
          logEvent({
            source: "atlas",
            kind: "node-install-failed",
            summary: p.error ?? "Node install failed",
            status: "failure",
            payload: { error: p.error },
          });
          set({
            phase: "failed",
            installError: p.error ?? "Node install failed. See the log for details.",
          });
        }
      });
      installUnlistens = [progressUnlisten, doneUnlisten];

      try {
        await nodeSetup.install();
      } catch (e) {
        clearInstallListeners();
        set({
          phase: "failed",
          installError: `Failed to start Node install: ${String(e)}`,
        });
      }
    }

    return {
      phase: "idle",
      reason: null,
      foundVersion: null,
      minMajor: 18,
      installLog: [],
      installError: null,
      actions: { check, install },
    };
  }),
);
