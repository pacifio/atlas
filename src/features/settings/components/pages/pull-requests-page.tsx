/**
 * Settings → Pull Requests: how a pull request merges, what happens to the
 * session it belongs to, where its links open, and the review guide.
 *
 * Scopeable: the merge method, credit removal and the guide's settings can be
 * set per project (`.atlas/config.toml`); the rest apply everywhere, since
 * what reads them (the watch, the link handler) acts across projects.
 */

import { Select } from "@/ui/select";
import { NATIVE_AGENT_ID } from "@/types/agent";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useScopedSetting } from "../../lib/use-scoped-setting";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { SettingSelect, SettingSwitch, SettingTextarea } from "../layout/setting-controls";

const MERGE_METHODS = [
  {
    value: "last",
    label: "Last used",
    description: "Whichever you picked most recently on this device.",
  },
  { value: "merge", label: "Merge commit" },
  { value: "squash", label: "Squash and merge" },
  { value: "rebase", label: "Rebase and merge" },
] as const;

/** The longest instructions `config.toml` accepts (`MAX_GUIDE_INSTRUCTIONS`). */
const MAX_GUIDE_INSTRUCTIONS = 4_000;

export function PullRequestsPage() {
  const guideEnabled = useScopedSetting("pullRequestGuideEnabled").value;
  return (
    <SettingsPage
      scopeable
      title="Pull Requests"
      description="Merging, sessions with a pull request, links, and review guides."
    >
      <SettingsSection title="Merging">
        <SettingsGroup>
          <SettingsRow
            setting="pullRequestMergeMethod"
            control={<SettingSelect setting="pullRequestMergeMethod" options={MERGE_METHODS} />}
          />
          <SettingsRow
            setting="removeAgentCreditsOnMerge"
            description="Drops an agent's Co-Authored-By trailer and attribution footer from the message of a merge or squash Atlas performs, auto-merge included. Human co-authors stay. Commits already on the branch are not rewritten."
            control={<SettingSwitch setting="removeAgentCreditsOnMerge" />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Sessions"
        description="A session that opened or linked a pull request follows it."
      >
        <SettingsGroup>
          <SettingsRow
            setting="autoSettleOnMerge"
            description="When the merge came after you last worked in the session. A pull request closed without merging always settles its session."
            control={<SettingSwitch setting="autoSettleOnMerge" />}
          />
          <SettingsRow
            setting="autoSettleKeepPullRequests"
            description="Settling idle sessions (Sessions › Layout) skips a session while it has a linked pull request."
            control={<SettingSwitch setting="autoSettleKeepPullRequests" />}
          />
          <SettingsRow
            setting="pullRequestWatchWakes"
            description="A session watching its pull request sends its agent an update when a check fails, a review or comment arrives, or it conflicts with its base. Off: watches still track, but never prompt an agent."
            control={<SettingSwitch setting="pullRequestWatchWakes" />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Links">
        <SettingsGroup>
          <SettingsRow
            setting="pullRequestLinksOpenInApp"
            description="A pull request link in a session, the sidebar or a transcript opens in a tab when it belongs to the project's repository. Another repository's pull request always opens in the browser."
            control={<SettingSwitch setting="pullRequestLinksOpenInApp" />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Review guide"
        description="An agent reads a checkout of the pull request's head and writes a tour of the change, stop by stop. It changes nothing."
      >
        <SettingsGroup>
          <SettingsRow
            setting="pullRequestGuideEnabled"
            control={<SettingSwitch setting="pullRequestGuideEnabled" />}
          />
          <SettingsRow
            setting="pullRequestGuideAgent"
            disabled={!guideEnabled}
            disabledReason="Turn review guides on first."
            control={<GuideAgentSelect />}
          />
          <SettingsRow
            setting="pullRequestGuideModel"
            description="The guide reads the change over many steps, so a stronger model helps. Models you star in the composer's model picker are listed here."
            disabled={!guideEnabled}
            disabledReason="Turn review guides on first."
            control={<GuideModelSelect />}
          />
          <SettingsRow
            setting="pullRequestGuideInstructions"
            description="What to show first, dwell on or skip. The guide's format and its coverage of every changed file stay the same."
            disabled={!guideEnabled}
            disabledReason="Turn review guides on first."
          >
            <div className="pt-2 pb-1">
              <SettingTextarea
                setting="pullRequestGuideInstructions"
                maxLength={MAX_GUIDE_INSTRUCTIONS}
                placeholder="Show contracts before implementations. Skip test files unless they change behaviour. Keep summaries to two sentences."
              />
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}

/** The agent the guide's writer is, in the page's scope: its own setting, or
 *  the default agent for new sessions when that is empty. */
function useGuideAgentId(): string {
  const own = useScopedSetting("pullRequestGuideAgent").value.trim();
  const fallback = useScopedSetting("defaultAgent").value.trim();
  return own || fallback || NATIVE_AGENT_ID;
}

function GuideAgentSelect() {
  const scoped = useScopedSetting("pullRequestGuideAgent");
  const defaultAgent = useScopedSetting("defaultAgent").value;
  // The primitive signature, not the arrays: see the store's header.
  useAgentRegistryStore((s) => s.signature);
  const catalog = useAgentRegistryStore.getState().catalog;
  const name = (id: string) =>
    id === NATIVE_AGENT_ID
      ? "Atlas Agent"
      : (catalog.find((entry) => entry.agentType === id)?.name ?? id);
  const options = [
    { value: "", label: `Default agent (${name(defaultAgent || NATIVE_AGENT_ID)})` },
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
      aria-label="Review guide: Guide agent"
      onValueChange={(next) => {
        if (next === scoped.value) return;
        scoped.set(next);
      }}
    />
  );
}

/** Models starred for the guide's agent (`favoriteModels`), plus the agent's
 *  own default. A saved id that is not starred stays listed, so the select
 *  still shows what the file says. */
function GuideModelSelect() {
  const scoped = useScopedSetting("pullRequestGuideModel");
  const agentId = useGuideAgentId();
  const favorites = useSettingsStore((s) => s.settings.favoriteModels);
  const prefix = `${agentId}:`;
  const starred = favorites
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter((id) => id !== "");
  const options = [
    { value: "", label: "Agent's default" },
    ...starred.map((id) => ({ value: id, label: id })),
  ];
  if (!options.some((option) => option.value === scoped.value)) {
    options.push({ value: scoped.value, label: scoped.value });
  }
  return (
    <Select
      value={scoped.value}
      options={options}
      disabled={scoped.globalOnly}
      aria-label="Review guide: Guide model"
      onValueChange={(next) => scoped.set(next)}
    />
  );
}
