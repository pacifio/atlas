/** The smaller registry pages: Source Control, Privacy, Updates, About. */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";
import { isLinux, isWindows } from "@/lib/platform";
import { useAppProfile } from "@/lib/app-profile";
import { AtlasIcon } from "@/components/brand-marks";
import { updater } from "@/features/updater/lib/updater-api";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { SettingStepper, SettingSwitch } from "../layout/setting-controls";

import { ConfigFileSection } from "./config-file";
import { confirmAppDataReset } from "@/features/app/lib/app-data-reset";
import { Button } from "@tryatlas/design";

export function SourceControlPage() {
  return (
    <SettingsPage
      title="Source Control"
      description="Git in the editor, diffs, and in the background."
      scopeable
    >
      <SettingsSection title="Editor">
        <SettingsGroup>
          <SettingsRow
            setting="gitBlameInline"
            description="Who last changed the line under your cursor, when, and the commit summary, as a dim note at the end of the line."
            control={<SettingSwitch setting="gitBlameInline" />}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Repositories">
        <SettingsGroup>
          <SettingsRow
            setting="gitAutoFetch"
            description="Fetch the open project when it opens, when Atlas regains focus, and every few minutes, so the Pull badge shows what the remote has. It never pulls, merges or touches your files."
            control={<SettingSwitch setting="gitAutoFetch" />}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Diffs">
        <SettingsGroup>
          <SettingsRow
            setting="diffIgnoreWhitespace"
            description="In a file's diff, a commit and a chat's changes. Your changes list keeps every change, so what you stage still applies."
            control={<SettingSwitch setting="diffIgnoreWhitespace" />}
          />
          <SettingsRow
            setting="diffFilesCollapsed"
            control={<SettingSwitch setting="diffFilesCollapsed" />}
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}

export function PrivacyPage() {
  const shareTelemetry = useSettingsStore((s) => s.settings.shareTelemetry);
  return (
    <SettingsPage
      title="Privacy"
      description="Usage data, Atlas's own logs, the settings file, and local data."
    >
      <SettingsSection
        title="Usage data"
        description="Never your prompts, code, file paths or keys. See TELEMETRY.md."
      >
        <SettingsGroup>
          <SettingsRow
            setting="shareTelemetry"
            description="App launches, which agents and tools you use, how many files a turn touched, token counts and crashes, to help improve Atlas."
            control={<SettingSwitch setting="shareTelemetry" />}
          />
          <SettingsRow
            setting="linkTelemetryToAccount"
            description="While signed in, attribute usage data to your account instead of an anonymous device id. History already linked stays linked."
            disabled={!shareTelemetry}
            disabledReason="Usage data is off."
            control={<SettingSwitch setting="linkTelemetryToAccount" />}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <SettingsGroup>
          <SettingsRow
            setting="enableAtlasLogs"
            description="Atlas's own events (sign-in, agents starting and finishing, files and pages opened) in the Logs panel under the atlas source, so you can share a timeline when something goes wrong."
            control={<SettingSwitch setting="enableAtlasLogs" />}
          />
          <SettingsRow
            setting="logRetentionDays"
            status="Applies the next time Atlas starts."
            control={<SettingStepper setting="logRetentionDays" unit="d" />}
          />
        </SettingsGroup>
      </SettingsSection>
      <ConfigFileSection />
      <LocalDataSection />
    </SettingsPage>
  );
}

/** Privacy › Local data: the in-app `bun run clean:app`. */
function LocalDataSection() {
  return (
    <SettingsSection
      title="Local data"
      description="Each asks first, then applies on a restart. Your projects, your agent CLIs' own sign-ins and agent variables in the system keychain are never touched."
    >
      <SettingsGroup>
        <SettingsRow
          anchor="clear-cache"
          title="Clear cache"
          description="Delete cached images, icons and web content. Sessions, settings and sign-ins stay."
          control={
            <Button variant="outline" size="sm" onClick={() => void confirmAppDataReset("cache")}>
              Clear cache
            </Button>
          }
        />
        <SettingsRow
          anchor="reset-atlas"
          title="Reset Atlas"
          description="Delete every session, setting and sign-in on this computer and start again from first-run setup."
          control={
            <Button variant="destructive" size="sm" onClick={() => void confirmAppDataReset("all")}>
              Reset
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

export function UpdatesPage() {
  const phase = useUpdaterStore.use.phase();
  const version = useUpdaterStore.use.version();
  const progress = useUpdaterStore.use.progress();
  const { beginApply, setError } = useUpdaterStore.use.actions();
  const [checking, setChecking] = useState(false);
  // A dev-profile build (`bun run dev:app`) never fetches or installs a
  // release: the backend refuses both, since the release would replace the
  // installed Atlas. Say so instead of offering a button that can only fail.
  const { dev: devProfile, productName } = useAppProfile();
  const downloading = phase === "downloading";
  const ready = phase === "ready" || phase === "applying";

  const checkNow = async () => {
    setChecking(true);
    try {
      const status = await updater.checkNow();
      // When an update exists the background download starts and the store
      // shows it; only the "up to date" case needs saying here.
      if (!status.available)
        toast.success(`You're on the latest version (${status.currentVersion}).`);
    } catch (e) {
      toast.error(`Update check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };
  const restart = () => {
    beginApply();
    void updater.apply().catch((e) => setError(String(e)));
  };

  const control = devProfile ? (
    <span className="caption">Off in {productName}</span>
  ) : ready ? (
    <Button size="sm" onClick={restart}>
      Restart to update
    </Button>
  ) : downloading ? (
    <span className="caption tabular-nums">
      {progress != null ? `Downloading ${Math.round(progress * 100)}%` : "Preparing…"}
    </span>
  ) : (
    <Button variant="outline" size="sm" disabled={checking} onClick={() => void checkNow()}>
      {checking ? "Checking…" : "Check now"}
    </Button>
  );

  return (
    <SettingsPage title="Updates" description="Atlas releases and Atlas Agent's plugin catalog.">
      <SettingsSection title="Atlas">
        <SettingsGroup>
          <SettingsRow
            setting="autoUpdate"
            description={
              isWindows
                ? "Check for a new version in the background and download the installer. Windows asks before it installs."
                : isLinux
                  ? "Check for a new version in the background. On Linux, update through your package manager or the release page."
                  : "Check for a new version in the background and download it. Updates are signed and notarized, and Atlas verifies them before installing."
            }
            control={<SettingSwitch setting="autoUpdate" />}
          />
          <SettingsRow
            anchor="check-updates"
            title={ready ? `Update ready${version ? ` (${version})` : ""}` : "Check for updates"}
            description={
              devProfile
                ? "A source build never installs a release, because that would replace your installed Atlas."
                : ready
                  ? "Downloaded and verified. Restart now, or it applies the next time you quit."
                  : "Check now, whatever the automatic setting. You're asked to restart once it's ready."
            }
            control={control}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Atlas Agent">
        <SettingsGroup>
          <SettingsRow
            setting="curatedPluginSync"
            status="Applies the next time Atlas Agent starts."
            control={<SettingSwitch setting="curatedPluginSync" />}
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}

export function AboutPage() {
  // Read from the bundle, not hardcoded: `bun run bump` doesn't touch this file.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void getVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <SettingsPage title="About">
      <SettingsGroup>
        <div className="flex items-center gap-3 px-4 py-4">
          <AtlasIcon size={40} className="rounded-xl" />
          <div className="flex flex-col gap-0.5">
            <p className="label">Atlas{version ? ` ${version}` : ""}</p>
            <p className="caption">Multiplayer AI development</p>
          </div>
        </div>
        <p className="px-4 py-3 text-2xs text-secondary-foreground">
          Built with Tauri, React and Rust. Atlas records the work your team's coding agents do,
          links it to the commits it produced, and shares it with the whole team.
        </p>
      </SettingsGroup>
    </SettingsPage>
  );
}
