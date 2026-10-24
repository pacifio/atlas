import { Switch } from "@/ui/switch";
import { useSettingsStore } from "../../stores/settings-store";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { Select } from "@/ui/select";
import { NATIVE_AGENT_ID } from "@/types/agent";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { SettingSelect, SettingStepper, SettingSwitch } from "../layout/setting-controls";
import { useScopedSetting } from "../../lib/use-scoped-setting";

const SIDEBAR_SORTS = [
  { value: "recent", label: "Latest activity" },
  { value: "created", label: "Date started" },
] as const;

const SWITCH_OPTIONS = [
  {
    value: "reset",
    label: "Start over",
    description: "Switch in place with a clean chat.",
  },
  {
    value: "new-tab",
    label: "New tab",
    description: "Keep the conversation and open the new agent beside it.",
  },
  {
    value: "handoff",
    label: "Hand off",
    description: "Switch in place and pass the conversation along with your next message.",
  },
] as const;

export function ChatPage() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();

  return (
    <SettingsPage
      scopeable
      title="Sessions"
      description="New sessions, the composer, layout, and switching agents."
    >
      <SettingsSection title="New sessions">
        <SettingsGroup>
          <SettingsRow
            setting="defaultAgent"
            description="The agent a new chat starts with. Until it's installed, chats start with Atlas Agent."
            control={<DefaultAgentSelect />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Layout">
        <SettingsGroup>
          <SettingsRow
            setting="sidebarSort"
            control={<SettingSelect setting="sidebarSort" options={SIDEBAR_SORTS} />}
          />
          <SettingsRow
            setting="autoSettleAfterDays"
            control={<SettingStepper setting="autoSettleAfterDays" unit="d" zeroLabel="Off" />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Composer">
        <SettingsGroup>
          <SettingsRow setting="enterToSend" control={<SettingSwitch setting="enterToSend" />} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Conversation">
        <SettingsGroup>
          <SettingsRow
            setting="adaptiveSuggestions"
            description="After each turn, the agent suggests two or three follow-ups as chips. They come from its own session, with no extra API key."
            control={
              <Switch
                checked={settings.adaptiveSuggestions !== "off"}
                aria-label="Next-step suggestions"
                onCheckedChange={(on) =>
                  void updateSettings({ adaptiveSuggestions: on ? "agent" : "off" })
                }
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Switching agents"
        description="Every conversation stays in your history, whichever you pick."
      >
        <SettingsGroup>
          <SettingsRow
            setting="agentSwitchBehavior"
            control={<SettingSelect setting="agentSwitchBehavior" options={SWITCH_OPTIONS} />}
          />
          <SettingsRow
            setting="rememberBeforeSwitch"
            description="The agent you leave is sent /remember and saves what it learned to shared memory first. Costs one turn; you can switch right away from the notice."
            control={<SettingSwitch setting="rememberBeforeSwitch" />}
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}

/** Atlas Agent and every installed agent. A saved id that is no longer
 *  installed stays listed, marked, so the select still shows what the file says. */
function DefaultAgentSelect() {
  const scoped = useScopedSetting("defaultAgent");
  // The primitive signature, not the arrays: see the store's header.
  useAgentRegistryStore((s) => s.signature);
  const catalog = useAgentRegistryStore.getState().catalog;
  const options = [
    { value: NATIVE_AGENT_ID, label: "Atlas Agent" },
    ...catalog
      .filter((entry) => entry.installed && entry.agentType !== NATIVE_AGENT_ID)
      .map((entry) => ({ value: entry.agentType, label: entry.name })),
  ];
  if (!options.some((option) => option.value === scoped.value)) {
    options.push({ value: scoped.value, label: `${scoped.value} (not installed)` });
  }
  return (
    <Select
      value={scoped.value}
      options={options}
      disabled={scoped.globalOnly}
      aria-label="New sessions: Default agent"
      onValueChange={(next) => scoped.set(next)}
    />
  );
}
