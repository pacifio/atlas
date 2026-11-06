import { useEffect, type RefObject } from "react";
import { toast } from "sonner";
import { notifyAgentSignInRequired } from "@/features/notifications/lib/agent-notifier";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { useAppStore } from "@/features/app/stores/app-store";
import { logEvent } from "@/features/log/lib/log";
import {
  agentTypeFromPluginId,
  pluginIdForAgent,
  CLAUDE_PERMISSION_MODES,
  type ChatSession,
} from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { agents, ensureAgent, resetAgent } from "../lib/agents-api";
import { isDeadlineError, progressSince, withDeadline } from "../lib/with-deadline";
import { configOptionPushes, loadConfigOptionPrefs } from "../lib/config-option-prefs";
import { bindFailureAction, errInfo, promptSignIn } from "../lib/agent-signin";
import { projectPathForTab } from "../lib/tab-project";
import { resolveEffectiveMode } from "../lib/resume-mode";

/** Tab+agent pairs whose bind failure has already been surfaced, so the
 *  focus-triggered retry doesn't re-toast the same error on every focus.
 *  Cleared for a pair once its bind finally succeeds. */
const reportedBindFailures = new Set<string>();
/** Tab+agent keys whose automatic bind has already been retried once after a
 *  failure. The mount-time bind is not something the user did, and its first
 *  failure at boot has a known transient cause: every mounted chat panel
 *  binds at once, and the native engine's in-process start is not reentrant —
 *  a second concurrent start on the same engine home failed with "starting
 *  the in-process app-server runtime", which then surfaced as an error toast
 *  on a launch that was otherwise fine (the manager's connect dedupe, ATL-226,
 *  closes the race itself; this is the belt to that brace). One silent retry
 *  absorbs a transient; a failure that repeats is reported as before. */
const retriedBinds = new Set<string>();
const BIND_RETRY_MS = 1500;

/** How long a bind hop (connect, `session/new`) may stay silent before it is
 *  noted as stalled. The soft notice only: the transcript's working indicator
 *  carries its own 30 s clock and shows the persistent Restart / Switch
 *  affordance (`StallNotice`); this just puts the stall in the log. */
const BIND_STALL_MS = 30_000;

/** How long a bind hop may stay silent before the renderer gives up on it.
 *  A hop that never settles used to leave the panel's closure-local `pending`
 *  flag set forever, which silently disabled every retry path (focus, sign-in,
 *  silent) — the "Starting Codex" that never ends. Generous because a first
 *  run legitimately downloads Node and `npm install`s the adapter; PR 1 of the
 *  stalled-start plan makes that a per-version cost rather than per-launch. */
const BIND_DEADLINE_MS = 3 * 60_000;

/** Await a bind hop, logging once if it stalls. The hop itself is untouched —
 *  the deadline that actually ends it is `withDeadline`. */
async function watchStall<T>(hop: Promise<T>, label: string, tabId: string): Promise<T> {
  const timer = window.setTimeout(() => {
    logEvent({
      source: "atlas",
      kind: "agent-bind",
      summary: `${label}: bind stalled (no answer after ${BIND_STALL_MS / 1000}s)`,
      status: "failure",
      payload: { tabId },
    });
  }, BIND_STALL_MS);
  try {
    return await hop;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Tab+agent pairs we have ALREADY walked through sign-in once.
 *
 *  Without this the sign-in flow loops forever: the retry callback clears
 *  `reportedBindFailures` so the rebind can report afresh, so a rebind that
 *  fails on auth AGAIN re-opens the dialog, and completing it retries, and so
 *  on. That is not hypothetical — plenty of registry agents advertise an auth
 *  method that does not actually authenticate them (`autohand`'s only method is
 *  `npm install -g autohand-cli`, which installs a CLI and leaves the agent
 *  still demanding a login). Offering the dialog once and then showing the
 *  agent's own message is the honest end state.
 *
 *  Cleared alongside `reportedBindFailures` when a bind finally succeeds, so a
 *  genuine re-auth later in the session still gets the dialog. */
const signInAttempted = new Set<string>();

/** Handle on the bind effect's in-flight attempt — see `epoch` inside it.
 *  Null whenever no bind effect is mounted (tab already bound). */
export interface BindControl {
  retry: () => void;
  abandon: () => void;
  kick: () => void;
}

export function useAgentBind(
  tabId: string,
  session: ChatSession | undefined,
  bindControlRef: RefObject<BindControl | null>,
): void {
  // Bind an ACP agent + session to this tab as soon as the panel mounts.
  // The agent spawn takes 1–3 s warm and up to 30 s on a cold `npx` cache,
  // so kicking it off in parallel with the user reading the empty chat
  // hides the latency. If the user hits Send before the bind lands, the
  // submit handler queues the message and the drain effect below flushes
  // it once `acpSessionId` is set. Skipped when a session is already bound
  // (sidebar resume, or a tab re-mount).
  useEffect(() => {
    if (!session) return;
    if (session.acpSessionId) return;
    let cancelled = false;
    let pending = false;
    // Attempt generation. `retry`/`abandon` (below) bump it, which makes the
    // in-flight attempt stale: its later steps bail, and its `finally` no
    // longer owns `pending`. That is what lets a Restart start a NEW attempt
    // while the hung one is still parked on the backend, and what lets Stop
    // free the tab so the next send binds again.
    let epoch = 0;
    const ensureBound = async () => {
      if (cancelled || pending) return;
      pending = true;
      const myEpoch = ++epoch;
      const stale = () => cancelled || myEpoch !== epoch;
      try {
        // Bind to THIS session's chosen agent (Claude by default, or Codex),
        // not a single global default — so per-tab agents run in parallel.
        const at = useChatStore.getState().sessions[tabId]?.agentType;
        const pluginId = pluginIdForAgent(at);
        const label = agentMeta(at).label;
        const agent = await watchStall(
          withDeadline(
            ensureAgent(pluginId),
            BIND_DEADLINE_MS,
            `${label} has not finished connecting`,
            // A first run downloads Node and `npm install`s the adapter, which
            // can outlast the deadline on a slow disk or connection (Defender
            // scanning node_modules on Windows). While the install keeps
            // restating its status (it ticks with the elapsed time) the job
            // is alive and the deadline re-arms; a status that stops moving
            // is a hang, and the deadline fires. Either way the install
            // itself is a backend job that outlives this connect, so a
            // retry joins it rather than restarting it.
            progressSince(() => useChatStore.getState().agentStartingStatus[pluginId]),
          ),
          label,
          tabId,
        );
        if (stale()) return;
        // Resolve cwd from THIS tab's project, not the global currentProject:
        // background projects keep their chat panels mounted, so a bind that
        // fires after a project switch (failed-bind retry, agent change)
        // would otherwise create the session against the WRONG repo — and a
        // "/" fallback would dodge the running-project eviction guard. A tab
        // asked to start in a worktree (`bindCwd`) starts there.
        const cwd =
          useChatStore.getState().sessions[tabId]?.bindCwd ||
          (projectPathForTab(tabId) ?? useAppStore.getState().currentProject?.path ?? "/");
        const init = await watchStall(
          withDeadline(
            agents.newSession(agent.agent_id, cwd),
            BIND_DEADLINE_MS,
            `${label} has not answered \`session/new\``,
          ),
          label,
          tabId,
        );
        const key = init.key;
        if (stale()) return;
        // Guard against an agent switch that landed mid-bind: if the tab's
        // agentType changed since we picked `pluginId`, this binding is for the
        // wrong agent — abandon it so we don't clobber the tab with a stale
        // (e.g. Codex) session under the newly-chosen agent. The deps now watch
        // agentType, so the effect re-runs and binds the right agent.
        const nowAt = useChatStore.getState().sessions[tabId]?.agentType;
        if (pluginIdForAgent(nowAt) !== pluginId) return;
        // Apply the tab's permission mode BEFORE exposing the binding.
        // `setAcpBinding` is what flushes any queued send, so if we set the
        // mode after it the first turn can race ahead of (e.g.)
        // bypassPermissions and still trigger a stray prompt on turn one.
        // Awaiting here guarantees the agent is in the right mode first.
        const session = useChatStore.getState().sessions[tabId];
        const selectedMode = session?.claudePermissionMode ?? "default";
        // `default` means the user has not overridden the agent. Preserve the
        // mode resolved by Claude/Codex from their own user-level config.
        const requestedClaudeMode = session?.claudePermissionModeExplicit
          ? selectedMode
          : undefined;
        const requestedAcpMode = session?.acpModeExplicit ? session.acpCurrentMode : undefined;
        const requestedMode = nowAt === "claude-code" ? requestedClaudeMode : requestedAcpMode;
        // Same rule as the resume path, so a mode means the same thing
        // whether a session is new or reopened (`resume-mode.ts`).
        const effectiveMode = resolveEffectiveMode(
          requestedMode ?? undefined,
          init.current_mode,
          init.available_modes,
        );
        if (effectiveMode && effectiveMode !== init.current_mode) {
          try {
            await agents.setMode(key, effectiveMode);
          } catch (err) {
            console.warn("setMode at session create failed:", err);
          }
          if (stale()) return;
        }
        // Seed the store before binding: binding is the point at which queued
        // sends become eligible, so the first prompt sees the agent's actual
        // default instead of a hard-coded Atlas fallback.
        if (!stale()) {
          const actions = useChatStore.getState().actions;
          if (
            nowAt === "claude-code" &&
            (effectiveMode ?? init.current_mode) &&
            CLAUDE_PERMISSION_MODES.includes(
              (effectiveMode ?? init.current_mode) as (typeof CLAUDE_PERMISSION_MODES)[number],
            )
          ) {
            actions.hydrateClaudePermissionMode(
              tabId,
              (effectiveMode ?? init.current_mode) as (typeof CLAUDE_PERMISSION_MODES)[number],
            );
          } else if (nowAt !== "claude-code" && init.available_modes.length > 0) {
            actions.setAcpModes(tabId, effectiveMode, init.available_modes, nowAt);
          }
        }
        // A model picked before there was a session — the composer's agent +
        // model picker switches agent and model in one pick — is applied here,
        // for the same reason as the mode: the first prompt must run on it.
        // `switchChatAgent` clears the model, so a set one is a pick — or, on
        // a rebind, the model the conversation was already on.
        const pickedModel = useChatStore.getState().sessions[tabId]?.acpCurrentModel;
        if (pickedModel) {
          try {
            await agents.setModel(key, pickedModel);
          } catch (err) {
            console.warn("setModel at session create failed:", err);
          }
          if (stale()) return;
        }
        useChatStore.getState().actions.setAcpBinding(tabId, agent.agent_id, key.session_id, cwd);
        // Bound successfully — re-arm the failure toast so a LATER breakage
        // (agent crashes, gets uninstalled) is reported again rather than
        // swallowed by the earlier dedupe. Same for the sign-in offer: a token
        // that expires later in the session deserves the dialog again.
        reportedBindFailures.delete(`${tabId}:${pluginId}`);
        signInAttempted.delete(`${tabId}:${pluginId}`);
        retriedBinds.delete(`${tabId}:${pluginId}`);
        // Seed the composer mode picker from the freshly-created session's
        // advertised modes (Codex: read-only / auto / full-access). The modes
        // are seeded into the Rust SessionState by `new_session`, so the
        // snapshot here already carries them. Claude ignores these in favour
        // of its own permission pill.
        try {
          const snap = await agents.snapshotMeta(key);
          if (!stale()) {
            // Defensive `?.` — a snapshot from an older agent build may omit
            // these arrays; a throw here used to silently skip ALL seeding.
            const modes = snap.available_modes ?? [];
            const models = snap.available_models ?? [];
            // Only seed when the agent actually advertised modes, so we never
            // clobber the optimistic cached modes with an empty set.
            if (modes.length > 0) {
              useChatStore
                .getState()
                .actions.setAcpModes(
                  tabId,
                  snap.current_mode,
                  modes,
                  agentTypeFromPluginId(snap.plugin_id),
                );
            }
            // Seed the ACP model picker (Claude Code / Codex) from the snapshot's
            // advertised models. Empty when the agent exposes no model selection.
            if (models.length > 0) {
              useChatStore.getState().actions.setAcpModels(tabId, snap.current_model, models);
            }
            // Seed the slash-command list the same way. An
            // `available_commands_update` fired between `session/new` and the
            // binding is dropped by the delta router (no tab matches yet), and
            // nothing re-emits it — the snapshot is the recovery path, exactly
            // as for modes/models. Rust buffers pre-install notifications, so
            // by the time this snapshot lands the commands are in state.
            // The source agent rides along so a snapshot that raced an agent
            // switch is dropped instead of landing the OLD agent's commands
            // (Claude's skills, most visibly) under the new agent's picker.
            useChatStore
              .getState()
              .actions.setAcpAvailableCommands(
                tabId,
                snap.available_commands ?? [],
                agentTypeFromPluginId(snap.plugin_id),
              );
            // And the config-option knobs (#32). The `session/new`
            // advertisement lives only in the backend cell — a follow-up
            // notification is optional and most agents never send one, so
            // without this the effort pill and every other knob simply never
            // appeared. This also heals the early-delta drop: any
            // `config_options_updated` emitted before the tab was bound is
            // re-covered by this snapshot, which is fetched after bind.
            useChatStore
              .getState()
              .actions.setAcpConfigOptions(
                tabId,
                snap.config_options ?? [],
                agentTypeFromPluginId(snap.plugin_id),
              );
            // Re-apply the user's remembered knob picks (#33) — the mode
            // pref's discipline: only knobs this session advertises, only
            // values it offers, nothing when it already sits there. Each push
            // answers with the confirmed list as a delta, so the pills follow.
            const at = useChatStore.getState().sessions[tabId]?.agentType;
            if (at) {
              for (const push of configOptionPushes(
                snap.config_options ?? [],
                loadConfigOptionPrefs(at),
              )) {
                try {
                  await agents.setConfigOption(key, push.configId, push.value);
                } catch (err) {
                  console.warn("re-applying a config-option pref failed:", err);
                }
                if (stale()) return;
              }
            }
            // Boot finished (with or without modes) — drop the loading state.
            useChatStore.getState().actions.setAcpModesPending(tabId, false);
          }
        } catch (err) {
          console.warn("snapshot for modes failed:", err);
          if (!stale()) useChatStore.getState().actions.setAcpModesPending(tabId, false);
        }
      } catch (err) {
        console.warn("Agent session creation failed:", err);
        // Bind failed (couldn't set the agent up / spawn error). This used to
        // be console-only, so a user whose agent wouldn't start just saw a dead
        // composer with no reason given. The backend's message is the useful
        // one — `explain_spawn_failure` names the agent and the fix (check your
        // connection, or sign in with `cursor-agent login`). Deduped per
        // tab+agent because the focus handler retries this bind.
        if (!stale()) {
          useChatStore.getState().actions.setAcpModesPending(tabId, false);
          const at = useChatStore.getState().sessions[tabId]?.agentType;
          const key = `${tabId}:${pluginIdForAgent(at)}`;
          // The attempt is over, so is its "Installing …" text. A connect that
          // was killed (deadline, Stop) is aborted mid-install and never sends
          // the backend's own clear, which left the label stuck.
          useChatStore.getState().actions.setAgentStartingStatus(pluginIdForAgent(at), null);
          // The log panel gets every failure, deduped or not: the dedupe below
          // is about not re-toasting, and a failure that reaches neither the
          // toast nor the log is one nobody can diagnose.
          logEvent({
            source: "atlas",
            kind: "agent-bind",
            summary: `${agentMeta(at).label}: bind failed — ${errInfo(err).message.slice(0, 200)}`,
            status: "failure",
            payload: { tabId, agent: at, kind: errInfo(err).kind },
          });
          // The hop outlived the client deadline. The backend future is still
          // parked, so a retry would only join it: kill the plugin's
          // connection (by plugin id — there is no session to kill by) and
          // forget the cached agent, so the next attempt is a fresh connect.
          // A three-minute hang is not the boot transient the silent retry
          // exists for either, so that is spent too and the failure reports.
          if (isDeadlineError(err)) {
            const timedOutPlugin = pluginIdForAgent(at);
            agents
              .killPlugin(timedOutPlugin)
              .catch((e) => console.warn("killPlugin after bind timeout failed:", e));
            resetAgent(timedOutPlugin);
            retriedBinds.add(key);
          }
          // First failure of an automatic bind: try once more, quietly, before
          // telling anyone. `pending` is released in `finally` below, so the
          // delayed call is not coalesced away.
          if (!retriedBinds.has(key)) {
            retriedBinds.add(key);
            window.setTimeout(() => {
              if (!stale()) void ensureBound();
            }, BIND_RETRY_MS);
            return;
          }
          // The first message held for this bind cannot go out: drop the
          // "starting" state and park the text in the queue instead, where
          // it stays visible (and retryable) beside the failure reported
          // below. Its bubble stays in the transcript.
          const held = useChatStore.getState().sessions[tabId]?.pendingSend;
          if (held) {
            const actions = useChatStore.getState().actions;
            actions.setPendingSend(tabId, undefined);
            actions.updateSessionStatus(tabId, "idle");
            actions.enqueueMessage(tabId, held.content, held.mentions ?? []);
          }
          // A message is sitting in the queue waiting on this bind: the user
          // is watching, so the failure is reported even if an earlier one
          // for this tab+agent already was. The dedupe exists to stop the
          // focus-retry re-toasting into the void, not to hide the reason a
          // send never went out.
          const waiting = (useChatStore.getState().queues[tabId]?.length ?? 0) > 0;
          if (waiting || !reportedBindFailures.has(key)) {
            reportedBindFailures.add(key);
            // Cursor (and friends) reject `session/new` when signed out, so the
            // "you need to sign in" case lands HERE, not on the turn-failure
            // route that raises `atlas:auth-required`. Offer the one-click fix
            // instead of dumping a raw protocol error, and rebind once it lands.
            // Only ONCE per tab+agent — see `signInAttempted`.
            const action = bindFailureAction({
              agentType: at,
              err,
              alreadyAttempted: signInAttempted.has(key),
            });
            if (action === "sign-in" && at) {
              signInAttempted.add(key);
              // `reason` is what lets the dialog offer in-app key entry rather
              // than the agent's own (often unusable) auth methods.
              promptSignIn(at, {
                reason: errInfo(err).message,
                onSignedIn: () => {
                  reportedBindFailures.delete(key);
                  void ensureBound();
                },
                // Dismissed without signing in: re-arm reporting only. The
                // dedupe key used to stay set forever, silently swallowing
                // every subsequent bind failure for this tab+agent.
                onDismissed: () => reportedBindFailures.delete(key),
              });
              // The dialog is up; if the user is away it is also a banner.
              notifyAgentSignInRequired(tabId, at);
            } else if (action === "silent") {
              // The composer is already showing why (`AiGrantBar`, and "No
              // models" in the picker). A toast would be a third copy of a
              // setup problem, re-raised on every rebind.
            } else if (action === "signed-in-but-refused" && at) {
              // Signed in already and STILL refused. Say so, and surface the
              // agent's own words — it is the only thing that can explain what
              // else it wants.
              toast.error(
                `${agentMeta(at).label} still reports no credentials after signing in. ` +
                  `It said: ${errInfo(err).message}`,
              );
            } else {
              // `errInfo`, not String(err): these commands reject with a
              // structured `{message, kind}`, which stringifies to
              // "[object Object]".
              toast.error(errInfo(err).message);
            }
          }
        }
      } finally {
        // A superseded attempt does not release the flag: the attempt that
        // replaced it owns `pending` now.
        if (myEpoch === epoch) pending = false;
      }
    };
    bindControlRef.current = {
      retry: () => {
        epoch += 1;
        pending = false;
        const at = useChatStore.getState().sessions[tabId]?.agentType;
        const key = `${tabId}:${pluginIdForAgent(at)}`;
        reportedBindFailures.delete(key);
        signInAttempted.delete(key);
        retriedBinds.delete(key);
        void ensureBound();
      },
      abandon: () => {
        epoch += 1;
        pending = false;
      },
      kick: () => void ensureBound(),
    };
    // Eager bind on mount.
    void ensureBound();
    // Focus event acts as a retry — if the initial bind threw (e.g. the
    // agent process couldn't spawn yet because Claude Code finished
    // installing mid-session), refocusing the composer will try again.
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId?: string }>).detail;
      if (!detail || detail.tabId !== tabId) return;
      if (useChatStore.getState().sessions[tabId]?.acpSessionId) return;
      void ensureBound();
    };
    window.addEventListener("atlas:chat-input-focused", handler);
    return () => {
      cancelled = true;
      bindControlRef.current = null;
      window.removeEventListener("atlas:chat-input-focused", handler);
    };
    // `!!session` is in the dep list so the bind effect actually
    // fires after the parallel `createSession` effect (chat-panel) flips
    // `session` from null → defined. Without it, deps stay
    // `[tabId, undefined]` across both renders (acpSessionId is
    // still undefined on the newly-created session) so React skips
    // the effect, the bind never starts, and every send sits in
    // the queue forever — the exact "messages get queued on a
    // brand-new project" symptom.
    // `agentType` is in the deps so switching the tab's agent (⌥/) re-runs the
    // bind — its cleanup cancels any in-flight bind for the previous agent (the
    // `cancelled` guard), preventing a stale bind from clobbering the tab. This
    // matters even when acpSessionId was already undefined (switch during the
    // first bind), where acpSessionId alone wouldn't change.
  }, [tabId, !!session, session?.acpSessionId, session?.agentType]);
}
