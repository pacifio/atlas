import { isMac, isWindows } from "@/lib/platform";
import { useAppProfile } from "@/lib/app-profile";
import { Button } from "@/ui/button";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { SettingSelect, SettingSwitch } from "../layout/setting-controls";
import { PreferredEditorSelect } from "@/features/external-editor/components/preferred-editor-select";

const TIME_FORMATS = [
  { value: "system", label: "System" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
] as const;

import { ConfigErrorBanner } from "./config-file";

export function GeneralPage() {
  // `.atlas` in the released app, `.atlas-dev` in a dev-profile build, which
  // also keeps it out of git through `.git/info/exclude` rather than editing
  // the project's own `.gitignore`.
  const { dev: devProfile, dirName: atlasDir, productName } = useAppProfile();

  return (
    <SettingsPage
      title="General"
      description="Confirmations, the clock, and how Atlas treats your project's files."
    >
      <ConfigErrorBanner />

      <SettingsSection title="System">
        <SettingsGroup>
          <SettingsRow
            setting="keepAwakeWhileRunning"
            description={`Keep your ${isMac ? "Mac" : "computer"} from sleeping while an agent is working. The display can still turn off.`}
            disabled={isWindows}
            disabledReason="Not available on Windows yet."
            control={<SettingSwitch setting="keepAwakeWhileRunning" />}
          />
          <SettingsRow
            setting="timeFormat"
            control={<SettingSelect setting="timeFormat" options={TIME_FORMATS} />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Confirmations">
        <SettingsGroup>
          <SettingsRow
            setting="confirmDeleteChat"
            control={<SettingSwitch setting="confirmDeleteChat" />}
          />
          <SettingsRow
            setting="confirmQuitWhileRunning"
            control={<SettingSwitch setting="confirmQuitWhileRunning" />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Files">
        <SettingsGroup>
          <SettingsRow
            setting="autoAddAtlasGitignore"
            title={devProfile ? `Keep ${atlasDir} out of git` : `Add ${atlasDir} to .gitignore`}
            description={
              devProfile
                ? `${productName} lists ${atlasDir}/ in each git project's .git/info/exclude, so its caches stay out of version control without editing your .gitignore.`
                : `Atlas adds ${atlasDir}/, where it keeps its caches and state, to each git project's .gitignore when it opens.`
            }
            control={<SettingSwitch setting="autoAddAtlasGitignore" />}
          />
          <SettingsRow
            setting="showHiddenFiles"
            control={<SettingSwitch setting="showHiddenFiles" />}
          />
          <SettingsRow setting="preferredEditor" control={<PreferredEditorSelect />} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Help">
        <SettingsGroup>
          <SettingsRow
            anchor="send-feedback"
            title="Send feedback"
            description="Report a bug, request a feature, or tell us what feels clumsy, with an optional screenshot."
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => useFeedbackStore.getState().actions.openPanel("settings")}
              >
                Send feedback
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
