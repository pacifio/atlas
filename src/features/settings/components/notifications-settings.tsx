import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { TIER_ORDER, TIER_SETTINGS, kindsInTier } from "@/features/notifications/lib/prefs";
import type { NotificationTier } from "@/features/notifications/lib/catalog";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "./layout/settings-layout";
import { SettingSwitch } from "./layout/setting-controls";
import { Select, Switch } from "@tryatlas/design";

const DURATION_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Always" },
  { value: 5_000, label: "5 seconds" },
  { value: 10_000, label: "10 seconds" },
  { value: 30_000, label: "30 seconds" },
  { value: 60_000, label: "1 minute" },
  { value: 300_000, label: "5 minutes" },
];

/** A minimum-duration picker; a value set by hand in `config.toml` that is not
 *  one of the presets still shows (rather than a blank select). */
function DurationSelect({
  value,
  label,
  allowAlways,
  onChange,
}: {
  value: number;
  label: string;
  allowAlways: boolean;
  onChange: (ms: number) => void;
}) {
  const options = DURATION_OPTIONS.filter((o) => allowAlways || o.value > 0);
  if (!options.some((o) => o.value === value)) {
    options.push({ value, label: `${Math.round(value / 1000)} seconds` });
    options.sort((a, b) => a.value - b.value);
  }
  return (
    <Select
      value={String(value)}
      aria-label={label}
      options={options.map((o) => ({ value: String(o.value), label: o.label }))}
      onValueChange={(next) => onChange(Number(next))}
    />
  );
}

/** One urgency tier: its banner and sound switches, and the catalog's kinds in
 *  it, each with its own switch (`notifyDisabledKinds`). Everything here is
 *  derived from the catalog — a new kind appears with no change to this file. */
function TierSection({ tier, masterOn }: { tier: NotificationTier; masterOn: boolean }) {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const group = TIER_SETTINGS[tier];
  const kinds = kindsInTier(tier);
  const disabled = new Set(settings.notifyDisabledKinds);
  /** The disabled list with `kind` switched on or off. Ids this catalog does
   *  not know are kept as they are. */
  const withKind = (kind: string, on: boolean) =>
    on
      ? settings.notifyDisabledKinds.filter((k) => k !== kind)
      : [...settings.notifyDisabledKinds.filter((k) => k !== kind), kind];
  const off = !masterOn;
  const offReason = "Notifications are off.";
  return (
    <SettingsSection title={group.title} description={group.description}>
      <SettingsGroup>
        <SettingsRow
          setting={group.native}
          description="A banner from the operating system, only while you are away."
          disabled={off}
          disabledReason={offReason}
          control={<SettingSwitch setting={group.native} />}
        />
        <SettingsRow
          setting={group.sound}
          description="A short sound with the banner."
          disabled={off}
          disabledReason={offReason}
          control={<SettingSwitch setting={group.sound} />}
        />
        {tier === "needs-you" && (
          <SettingsRow
            setting="notifyPermissionActions"
            disabled={off}
            disabledReason={offReason}
            control={<SettingSwitch setting="notifyPermissionActions" />}
          />
        )}
        <SettingsRow
          title="Kinds"
          description="Each kind of notification in this group, on its own switch."
          disabled={off}
        >
          <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
            {kinds.map(({ kind, entry }) => (
              <li
                key={kind}
                className="flex min-h-9 items-center justify-between gap-4 px-3 py-1.5"
              >
                <span className="text-2xs text-secondary-foreground">{entry.label}</span>
                {entry.locked ? (
                  <span className="caption">Always on</span>
                ) : (
                  <Switch
                    size="sm"
                    checked={!disabled.has(kind)}
                    disabled={off}
                    aria-label={entry.label}
                    onCheckedChange={(next) =>
                      void updateSettings({ notifyDisabledKinds: withKind(kind, next) })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

export function NotificationsSettings() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const masterOn = settings.notificationsEnabled;
  return (
    <SettingsPage
      title="Notifications"
      description="What Atlas tells you, and how loudly. Nothing fires while you are looking at the thing it is about."
    >
      <SettingsSection title="Notifications">
        <SettingsGroup>
          <SettingsRow
            setting="notificationsEnabled"
            description="Everything on this page. Sign-in problems always show, so an agent is never silently stopped."
            control={<SettingSwitch setting="notificationsEnabled" />}
          />
          <SettingsRow
            setting="notifyAgentMinDurationMs"
            disabled={!masterOn}
            disabledReason="Notifications are off."
            control={
              <DurationSelect
                value={settings.notifyAgentMinDurationMs}
                label="Notify on agent finish after"
                allowAlways
                onChange={(ms) => void updateSettings({ notifyAgentMinDurationMs: ms })}
              />
            }
          />
          <SettingsRow
            setting="terminalNotifyMinDurationMs"
            disabled={!masterOn}
            disabledReason="Notifications are off."
            control={
              <DurationSelect
                value={settings.terminalNotifyMinDurationMs}
                label="Notify on command success after"
                allowAlways={false}
                onChange={(ms) => void updateSettings({ terminalNotifyMinDurationMs: ms })}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>
      {TIER_ORDER.map((tier) => (
        <TierSection key={tier} tier={tier} masterOn={masterOn} />
      ))}
    </SettingsPage>
  );
}
