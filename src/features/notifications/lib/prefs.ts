/**
 * Settings → decision prefs, in one place. `prefsFromSettings` turns the
 * Rust-owned `AppSettings` into the per-kind `NotificationPrefs`
 * `decideNotification` takes, for every kind in the catalog:
 *
 *  - `enabled` — the master switch AND the kind not being listed in
 *    `notifyDisabledKinds` (its own switch in Settings; unknown ids there are
 *    ignored);
 *  - `native` / `sound` — the switches of the kind's urgency tier.
 *
 * A kind the catalog marks `locked` gets no entry (the defaults apply), so
 * nothing in Settings can silence it. Adding a catalog kind needs no change
 * here. Pure — no store, Tauri or DOM imports.
 */
import type { AppSettings, BooleanSettingKey } from "@/features/settings/lib/app-settings";
import {
  NOTIFICATION_CATALOG,
  type CatalogEntry,
  type NotificationKind,
  type NotificationTier,
} from "./catalog";
import type { KindPrefs, NotificationPrefs } from "./decide";

/** The two switches each tier owns, and how Settings titles the group. */
export const TIER_SETTINGS: Readonly<
  Record<
    NotificationTier,
    {
      title: string;
      description: string;
      native: BooleanSettingKey;
      sound: BooleanSettingKey;
    }
  >
> = {
  "needs-you": {
    title: "Needs you",
    description: "Something is blocked until you act.",
    native: "notifyNeedsYouNative",
    sound: "notifyNeedsYouSound",
  },
  outcome: {
    title: "Outcomes",
    description: "Work finished or failed.",
    native: "notifyOutcomeNative",
    sound: "notifyOutcomeSound",
  },
  warning: {
    title: "Warnings",
    description: "Something is degraded but still running.",
    native: "notifyWarningNative",
    sound: "notifyWarningSound",
  },
  team: {
    title: "Team",
    description: "Messages from people in your organization.",
    native: "notifyTeamNative",
    sound: "notifyTeamSound",
  },
};

/** Group order in Settings. */
export const TIER_ORDER: readonly NotificationTier[] = ["needs-you", "outcome", "warning", "team"];

/** The catalog's kinds in one tier, in catalog order. */
export function kindsInTier(
  tier: NotificationTier,
): { kind: NotificationKind; entry: CatalogEntry }[] {
  return (Object.entries(NOTIFICATION_CATALOG) as [NotificationKind, CatalogEntry][])
    .filter(([, entry]) => entry.tier === tier)
    .map(([kind, entry]) => ({ kind, entry }));
}

export function prefsFromSettings(s: AppSettings): NotificationPrefs {
  const prefs: NotificationPrefs = {};
  const disabled = new Set(s.notifyDisabledKinds);
  for (const [kind, entry] of Object.entries(NOTIFICATION_CATALOG) as [
    NotificationKind,
    CatalogEntry,
  ][]) {
    if (entry.locked) continue;
    const tier = TIER_SETTINGS[entry.tier];
    const kindPrefs: KindPrefs = {
      enabled: s.notificationsEnabled && !disabled.has(kind),
      native: s[tier.native],
      sound: s[tier.sound],
    };
    prefs[kind] = kindPrefs;
  }
  return prefs;
}
