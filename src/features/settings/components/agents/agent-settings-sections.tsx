// The settings on the Agents page that are registry keys: Atlas Agent's
// permissions in its editor, and the ones that apply to every agent under
// the card.

import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { useSettingsStore } from "../../stores/settings-store";
import { useModelPricingStore } from "../../stores/model-pricing-store";
import { SettingSwitch } from "../layout/setting-controls";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";

/** In Atlas Agent's editor: what it may do beyond chatting. */
export function AtlasAgentPermissions() {
  return (
    <SettingsSection
      title="Permissions"
      description="Every action shows in the chat and in the Logs panel."
    >
      <SettingsGroup>
        <SettingsRow
          setting="agentUiNavigation"
          description="Open files at a line, switch tabs and panels, fill in a message or a command for you. It never switches projects, sends for you, or presses Enter."
          control={<SettingSwitch setting="agentUiNavigation" />}
        />
        <SettingsRow
          setting="agentOrgAccess"
          description="In a cloud-bound project, read your organization's sessions, comments and conversations, and act there as you. Anything that reaches another person asks first."
          control={<SettingSwitch setting="agentOrgAccess" />}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** Under the card: what applies to every agent. */
export function AllAgentsSection() {
  const favorites = useSettingsStore((s) => s.settings.favoriteModels);
  const { updateSettings } = useSettingsStore.use.actions();
  return (
    <SettingsSection title="All agents">
      <SettingsGroup>
        <SettingsRow
          setting="agentCodeTools"
          description="Grep, find files, symbols, callers and search by meaning, in-process, respecting .gitignore and never reading secrets such as .env. Off: agents use their own tools."
          control={<SettingSwitch setting="agentCodeTools" />}
        />
        <SettingsRow
          setting="favoriteModels"
          status={
            favorites.length === 0
              ? "None starred yet. Star a model in the composer's model picker."
              : `${favorites.length} starred. Each agent's own are listed in its settings above.`
          }
          noReset
          control={
            favorites.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void updateSettings({ favoriteModels: [] })}
              >
                Clear all
              </Button>
            ) : undefined
          }
        />
        <ModelPricingRow />
      </SettingsGroup>
    </SettingsSection>
  );
}

function ModelPricingRow() {
  const prices = useModelPricingStore.use.prices();
  const loading = useModelPricingStore.use.loading();
  const { load, refresh } = useModelPricingStore.use.actions();
  useEffect(() => {
    void load();
  }, [load]);
  const count = Object.keys(prices).filter((key) => key.includes("/")).length;
  const update = async () => {
    await refresh();
    const n = Object.keys(useModelPricingStore.getState().prices).filter((key) =>
      key.includes("/"),
    ).length;
    toast.success(`Model pricing updated: ${n} models`);
  };
  return (
    <SettingsRow
      anchor="model-pricing"
      title="Model pricing"
      description="Per-model prices from models.dev, shown in the model picker. Refreshed on launch."
      status={count > 0 ? `${count} models priced.` : "Not fetched yet."}
      control={
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void update()}>
          {loading ? "Updating…" : "Update"}
        </Button>
      }
    />
  );
}
