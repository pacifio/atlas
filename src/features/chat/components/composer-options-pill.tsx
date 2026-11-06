import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useChatStore } from "../stores/chat-store";
import { parseConfigOptions } from "../lib/acp-config-options";
import { loadCachedAcpConfigOptions } from "../lib/acp-config-options-cache";
import { ComposerDropup, useComposerDropup } from "./composer-dropup";
import {
  ComposerOptionsPanelView,
  ComposerOptionsTriggerView,
  type ComposerOptionsState,
} from "./views/composer-options-pill-view";

/**
 * The agent-options pill — the knobs an agent advertises beyond mode and model
 * (a thinking-level select, a persona picker, a web-search toggle).
 *
 * Lives on the RIGHT of the composer footer, immediately left of the plan pill,
 * as its own right-anchored dropup. It used to sit in `ComposerGroupsMenu` with
 * the agent/mode/model pills, which put it in the middle of the left cluster
 * and made its width changes shove those pills sideways as it loaded.
 *
 * # It is always rendered
 *
 * The old pill was gated on `configOptions.length > 0`, so on a cold start it
 * was simply absent for the three or four seconds an agent takes to spawn,
 * handshake and answer `session/new` — the composer visibly re-flowed when it
 * popped in. There are only three honest things to show, and all three are a
 * pill:
 *
 * - **knobs known** (from cache or live) → "Options", opens the picker
 * - **nothing known yet** → "Options" with a spinner, disabled
 * - **agent advertises none** → "Default", opens a one-line explanation
 *
 * The cache carries the first and third across restarts (see
 * `acp-config-options-cache`), so the spinner is reserved for an agent this
 * install has genuinely never heard from. It is also backstopped: an agent that
 * never answers settles to "Default" rather than spinning forever.
 */

/** How long to wait for a first-ever answer before calling it "Default".
 *
 *  A first boot of a freshly installed agent is slow (npx fetch, node spawn), so
 *  this is deliberately generous — it exists to stop an agent that will NEVER
 *  answer from spinning for the life of the tab, not to race a slow one. A late
 *  answer still lands: this only decides what is shown meanwhile. */
const SETTLE_AFTER_MS = 30_000;

export const ComposerOptionsPill = memo(function ComposerOptionsPill({ tabId }: { tabId: string }) {
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  // `undefined` = no live session has spoken for this tab yet. An explicit `[]`
  // is a live session saying "no knobs", and the cache must not override it.
  const rawConfigOptions = useChatStore((s) => s.sessions[tabId]?.acpConfigOptions);
  const { setAcpConfigOption } = useChatStore.use.actions();

  // Cache read is keyed by agent and re-run when the live value changes, so a
  // tab that switches agents picks up the new agent's remembered knobs at once.
  const cached = useMemo(() => loadCachedAcpConfigOptions(agentType), [agentType]);
  const known = rawConfigOptions ?? cached;
  const configOptions = useMemo(() => parseConfigOptions(known), [known]);

  // Backstop for an agent that never answers. Keyed on the tab+agent so a switch
  // restarts the wait rather than inheriting a already-elapsed one.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (known !== null) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [tabId, agentType, known]);

  const loading = known === null && !settled;
  // Knobs exist, but every one of them is owned by another pill (mode/model) —
  // `parseConfigOptions` filters those out. There is nothing left to offer, so
  // this reads as "default" exactly like an empty advertisement does.
  const hasOptions = configOptions.length > 0;

  // A loading pill has nothing to open yet; the hook closes it if it got there.
  const { open, toggle, close, ref, contentRef, panelHeight } = useComposerDropup("options", {
    disabled: loading,
    measureKey: configOptions.length,
  });

  const state: ComposerOptionsState = loading ? "loading" : hasOptions ? "options" : "default";
  const onPick = useCallback(
    (optionId: string, value: string | boolean) => {
      void setAcpConfigOption(tabId, optionId, value);
      close();
    },
    [setAcpConfigOption, tabId, close],
  );

  return (
    <div ref={ref} data-slot="composer-options-pill" className="relative">
      {/* Morphing panel — right-anchored dropup, shared with the plan and
          usage pills. */}
      <ComposerDropup open={open} panelHeight={panelHeight} contentRef={contentRef}>
        <ComposerOptionsPanelView options={configOptions} onPick={onPick} />
      </ComposerDropup>
      <ComposerOptionsTriggerView state={state} open={open} onToggle={toggle} />
    </div>
  );
});
