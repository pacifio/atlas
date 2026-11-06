import { useState, useRef, useEffect, useMemo } from "react";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useChatStore } from "../stores/chat-store";
import { useNativeModelsStore } from "../stores/native-models-store";
import type { SwitchableAgent } from "@/types/agent";
import { agentMeta, useSwitchableAgents } from "@/features/agents/lib/agent-meta";
import { loadCachedAcpModels } from "../lib/acp-models-cache";
import { onModelPickerRequest } from "../lib/model-picker-events";
import { GROUP_ORDER, type ComposerGroup } from "../lib/composer-modes";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { PickerAgent } from "./model-picker";
import { OPEN_MODE_PICKER_EVENT } from "./mode-restore-bar";
import { ComposerGroupsPanel } from "./views/composer-groups-panel";

/**
 * The composer's grouped, animated picker — coding agent / permission mode /
 * model unified into one expanding menu. The pill row doubles as
 * the tab strip: clicking a pill expands a shared panel above it with that
 * group's items; clicking another tab slides the content toward it
 * (direction-aware); outside click / Esc / re-click closes. While open, the
 * unselected pills collapse to icon-only (the reference's tab behaviour).
 * Keyboard cycling (⌥/ agents, ⇧⇥ modes) is unchanged — this is the
 * "just let me pick" surface.
 *
 * Animation is CSS-only and cheap: the expand is a grid-rows 0fr→1fr
 * transition (no measuring, no library), group switches are one-shot keyed
 * slide-ins that end at identity (no fill-mode — the standing rule).
 */
export function ComposerGroupsMenu({
  tabId,
  currentAgent,
  onSwitchAgent,
}: {
  tabId: string;
  currentAgent: SwitchableAgent;
  onSwitchAgent: (agent: SwitchableAgent, model?: string) => void;
}) {
  const cycleAgentHint = useActionShortcut("chat.cycleAgent")?.label;
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  const permissionMode = useChatStore((s) => s.sessions[tabId]?.claudePermissionMode ?? "default");
  const currentMode = useChatStore((s) => s.sessions[tabId]?.acpCurrentMode);
  const availableModes = useChatStore((s) => s.sessions[tabId]?.acpAvailableModes);
  // The agent's own knobs are NOT here: they render as <ComposerOptionsPill/>
  // on the right of the footer, next to the plan pill.
  const modesPending = useChatStore((s) => s.sessions[tabId]?.acpModesPending ?? false);
  const currentModel = useChatStore((s) => s.sessions[tabId]?.acpCurrentModel);
  const availableModels = useChatStore((s) => s.sessions[tabId]?.acpAvailableModels);
  const { setAcpMode, setAcpModel, setClaudePermissionMode } = useChatStore.use.actions();
  const switchableAgents = useSwitchableAgents();

  const [openGroup, setOpenGroup] = useState<ComposerGroup | null>(null);
  const [dir, setDir] = useState(1);
  const ref = useRef<HTMLDivElement>(null);
  // Measured content height driving the shared panel's height tween — group
  // switches (and async rows landing) morph the container instead of snapping.
  const contentRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelHeight(el.offsetHeight));
    ro.observe(el);
    setPanelHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [openGroup]);

  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenGroup(null);
    };
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== "groups") setOpenGroup(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("atlas:composer-menu-open", onOther);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("atlas:composer-menu-open", onOther);
    };
  }, [openGroup]);

  // "Choose mode" on the mode-restore bar opens the mode group from outside.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ tabId?: string }>).detail?.tabId !== tabId) return;
      setOpenGroup("mode");
      // Mutual exclusion with the + menu — see atlas:composer-menu-open.
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "groups" }));
    };
    window.addEventListener(OPEN_MODE_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_MODE_PICKER_EVENT, onOpen);
  }, [tabId]);

  // ⌘⇧M (`chat.toggleModelPicker`, dispatched by the chat panel) toggles the
  // model group, as the reference's model-picker chord does.
  useEffect(
    () =>
      onModelPickerRequest(tabId, () =>
        setOpenGroup((cur) => {
          if (cur === "model") return null;
          window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "groups" }));
          return "model";
        }),
      ),
    [tabId],
  );

  const isNative = agentType === "atlas-agent";
  const refreshingModels = useNativeModelsStore.use.refreshing();
  const refreshNativeModels = useNativeModelsStore.use.actions().refresh;

  // Self-heal: the store is fed by the bind-time snapshot and the
  // `config_options_updated` delta, and a tab can render before either has
  // landed. Fall back to the persisted per-agent cache so the pill does not
  // flicker away in that gap.
  //
  // Not for the native agent. Its list is the gateway's, fetched and cached
  // by the seam (ADR-0007), and it arrives with the bind-time snapshot; when
  // it does NOT arrive that is the failure the user must see — an empty
  // picker with the refresh hint — and a localStorage pre-fill would paper
  // over it with whatever list some earlier launch saw.
  const models = useMemo(() => {
    if (availableModels && availableModels.length > 0) return availableModels;
    if (isNative) return [];
    return loadCachedAcpModels(agentType)?.availableModels ?? [];
  }, [availableModels, agentType, isNative]);

  // Every switchable agent with the models it can offer: the session's own
  // live list, and for the others what they advertised the last time they
  // were bound. Re-read on open (and after a refresh) — the cache is
  // localStorage, which nothing re-renders on.
  const pickerAgents = useMemo((): PickerAgent[] => {
    if (openGroup !== "model") return [];
    const ids = switchableAgents.includes(agentType)
      ? switchableAgents
      : [agentType, ...switchableAgents];
    return ids.map((a) => ({
      agentType: a,
      label: agentMeta(a).label,
      models: a === agentType ? models : (loadCachedAcpModels(a)?.availableModels ?? []),
    }));
  }, [openGroup, switchableAgents, agentType, models, refreshingModels]);

  const isClaude = agentType === "claude-code";
  const hasAcpModes = !!availableModes && availableModes.length > 0;
  const showMode = isClaude || hasAcpModes || modesPending;
  const toggle = (g: ComposerGroup) => {
    setOpenGroup((cur) => {
      if (cur === g) return null;
      if (cur) setDir(GROUP_ORDER.indexOf(g) > GROUP_ORDER.indexOf(cur) ? 1 : -1);
      // Mutual exclusion with the + menu — see atlas:composer-menu-open.
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "groups" }));
      return g;
    });
  };
  const close = () => setOpenGroup(null);

  const currentAcpMode = availableModes?.find((m) => m.id === currentMode);
  const currentModelInfo = models.find((m) => m.id === currentModel);

  return (
    <ComposerGroupsPanel
      rootRef={ref}
      contentRef={contentRef}
      openGroup={openGroup}
      dir={dir}
      panelHeight={panelHeight}
      agentType={agentType}
      currentAgentLabel={agentMeta(currentAgent).label}
      cycleAgentHint={cycleAgentHint}
      isClaude={isClaude}
      showMode={showMode}
      permissionMode={permissionMode}
      hasAcpModes={hasAcpModes}
      availableModes={availableModes}
      currentMode={currentMode}
      currentAcpMode={currentAcpMode}
      modesPending={modesPending}
      pickerAgents={pickerAgents}
      currentModel={currentModel}
      currentModelInfo={currentModelInfo}
      refreshingModels={refreshingModels}
      onToggle={toggle}
      onPickClaudeMode={(m) => {
        setClaudePermissionMode(tabId, m);
        close();
      }}
      onPickAcpMode={(id) => {
        setAcpMode(tabId, id);
        close();
      }}
      onPickModel={(a, id) => {
        if (a === agentType) {
          if (id) setAcpModel(tabId, id);
        } else {
          onSwitchAgent(a as SwitchableAgent, id ?? undefined);
        }
        close();
      }}
      onRefreshModels={refreshNativeModels}
      onAgentInstalled={(installed) => {
        onSwitchAgent(installed as SwitchableAgent);
        close();
      }}
      onAddMoreAgents={() => {
        close();
        openSettingsSection("agents");
      }}
    />
  );
}
