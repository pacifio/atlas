// The strips stacked over the composer's input: sleep / retry pills and the
// bars that explain why the input below cannot send right now.

import type { AgentType } from "@/types/agent";
import { RetryPill } from "./retry-pill";
import { SleepPill } from "./sleep-pill";
import { AiGrantBar } from "./ai-grant-bar";
import { RemovedAgentBar } from "./removed-agent-bar";
import { BranchChangedBar } from "./branch-changed-bar";
import { ModeRestoreBar } from "./mode-restore-bar";
import { LiveElsewhereBar } from "./live-elsewhere-bar";
import { RcDriverBar } from "./rc-driver-bar";

export function ComposerNotices({
  tabId,
  agentType,
  running,
  grantBarShown,
}: {
  tabId: string;
  agentType: AgentType;
  running: boolean;
  grantBarShown: boolean;
}) {
  return (
    <>
      {/* The turn the computer slept through, while it is still going. */}
      <SleepPill tabId={tabId} />
      {/* Transient-failure retry countdown (native agent). */}
      <RetryPill tabId={tabId} />

      {/* The no-grant setup state (D15a), tucked into the top of the
          composer — the explanation for the input being locked below.
          Scoped to the native agent for the same reason the lock is: the
          other agents do not use the Atlas gateway, so an org with no grant
          is not their problem and a bar over a working composer is noise.
          Deferred while a turn runs, with the lock (`grantLocksComposer`). */}
      {agentType === "atlas-agent" && <AiGrantBar turnRunning={running} />}

      {/* The tab's agent was uninstalled — same strip, same reason: the
          input below cannot send until the chat is switched. */}
      {!grantBarShown && <RemovedAgentBar tabId={tabId} />}

      {/* A resume could not restore the user's mode: nothing sends until
          they pick one. */}
      {!grantBarShown && <ModeRestoreBar tabId={tabId} />}

      {/* The last turn moved the checkout to another branch: the next
          message would run there. */}
      {!grantBarShown && <BranchChangedBar tabId={tabId} />}

      {/* Another process is writing this session: sending would fork it. */}
      {!grantBarShown && <LiveElsewhereBar tabId={tabId} />}

      {/* Someone else holds the remote-control seat, or asks for it. */}
      {!grantBarShown && <RcDriverBar tabId={tabId} />}
    </>
  );
}
