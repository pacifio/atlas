// What the composer may do right now, per tab: the session's agent, the org's
// AI grant and the lock it drives, a mode a resume could not restore, a
// session another process is still writing, and a remote driver holding the
// seat. Plus the per-session seeds that ride along with the same reads.

import { switchableAgentOf } from "@/features/agents/lib/agent-meta";
import type { SwitchableAgent } from "@/types/agent";
import { useAiGrantBarShown } from "../components/ai-grant-bar";
import { grantLocksComposer, useAiGrantProbe, useNoAiGrant } from "../stores/ai-grant-store";
import { useChatStore } from "../stores/chat-store";
import { useSendHeldForTerminal } from "../stores/live-elsewhere-store";
import { useNativeModelsOrgRefresh } from "../stores/native-models-store";
import { useRcRemoteDriver } from "../stores/rc-store";
import { useComposerModesSelfHeal } from "./use-composer-modes-self-heal";
import { useLiveElsewhereFeed } from "./use-live-elsewhere-feed";
import { useNativeEffortSeed } from "./use-native-effort-seed";

export function useComposerGates({
  tabId,
  running,
  disabledProp,
}: {
  tabId: string;
  running: boolean;
  disabledProp: boolean;
}) {
  // The mode picker's self-heal and hung-boot backstop
  // (`use-composer-modes-self-heal.ts`).
  useComposerModesSelfHeal(tabId);
  // Narrow per-tab selectors — primitives only, no message-array refs. This
  // component otherwise would re-render on every streaming chunk because it
  // sits inside the active chat panel.
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  // `agentType` normalised for the composer sub-components (session scope,
  // agent switcher) + the label lookup. This used to be a hardcoded list of the
  // six first-party agents with everything else falling through to
  // "claude-code" — so every registry-installed agent showed up in the pill as
  // "Claude Code", and the grouped picker's current-agent highlight (and
  // session scope) pointed at the wrong agent. `switchableAgentOf` passes
  // external ids through and collapses only the legacy "custom" placeholder,
  // which is what the transcript and sidebar already did.
  const switchableAgent: SwitchableAgent = switchableAgentOf(agentType);

  // The org's AI grant, and the composer lock it drives.
  //
  // Owned here because this component always renders while a chat is open;
  // `AiGrantBar` (`ComposerNotices`) only reads the result (see
  // `ai-grant-store.ts` for why the two must not probe independently).
  useAiGrantProbe();
  useNativeModelsOrgRefresh();
  const noAiGrant = useNoAiGrant();
  // Scoped to the NATIVE agent, which is the only one that talks to the Atlas
  // gateway. Claude Code, Codex and every registry agent run on the user's own
  // credentials — an org with no AI grant says nothing about them, and locking
  // their composer would break agents that work fine.
  //
  // This is the one thing ADR-0002 permits: the ban is on a composer disabled
  // by an agent's *readiness*, because the agent switcher lives inside it. The
  // `disabled` path below pointer-blocks only the text area and the send
  // button — the toolbar, and with it the switcher, stays live, so the user can
  // always move to an agent that runs. Verified against the escape hatch: this
  // must never disable the toolbar.
  //
  // Never while a turn runs (`grantLocksComposer`): the lock used to disable
  // the Stop button of a turn already admitted when the answer turned to no.
  const blockedByGrant = grantLocksComposer(noAiGrant, agentType, running);
  // While the no-grant strip shows it is the only one: the native agent cannot
  // run at all, and any other notice above a locked input is noise beside it.
  const grantBarShown = useAiGrantBarShown(running) && agentType === "atlas-agent";
  const disabled = disabledProp || blockedByGrant;
  // A resume could not restore the user's mode (`ModeRestoreBar`): no send
  // until they pick one. Only the send — typing and the mode picker stay live.
  const modeUnrestored = useChatStore((s) => !!s.sessions[tabId]?.unrestoredModeId);
  // Another process is still writing this session: sends wait for "Send anyway".
  // The composer feeds the live set itself, so the guard holds whichever view
  // (sidebar, History, another project) the session was opened from.
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  // The same read keeps the session's attached projects current for the
  // project chips' access toggles (`session-projects-store`).
  useLiveElsewhereFeed(!!acpSessionId);
  const heldForTerminal = useSendHeldForTerminal(acpSessionId);
  // Someone else holds the session's remote-control seat (`RcDriverBar`):
  // nothing sends or queues from here until the owner takes over. Rust's
  // steering entry refuses it too; this is what lets the composer say so
  // rather than bounce an error. Stop stays live — it is the owner's.
  const remoteDriving = useRcRemoteDriver(acpSessionId) !== null;
  // The BYOK provider/model bindings for the native agent stood here — the
  // provider pick, the model re-push on bind, the whole BYOK selection path.
  // Gone: the native agent's model comes from the seam's published catalogue
  // through the same `setAcpModel` path every other agent uses, and its
  // "provider" is the Atlas gateway, which is not a choice.
  useNativeEffortSeed(tabId, agentType);
  // The RTK compression toggle was seeded and re-pushed here. It is gone with
  // the runtime that implemented it (#54) — the ported engine has no
  // tool-output compressor, so the control had nothing to switch (D8).

  return {
    agentType,
    switchableAgent,
    grantBarShown,
    disabled,
    modeUnrestored,
    acpSessionId,
    heldForTerminal,
    remoteDriving,
  };
}
