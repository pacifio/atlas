import type { ReactElement, ReactNode } from "react";
import { toast } from "sonner";
import { KbdCombo } from "@tryatlas/design";

import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { AppSettings } from "@/features/settings/lib/app-settings";
import { SCALE_PRESETS } from "@/features/settings/lib/ui-scale";
import { UiScalePanel } from "@/features/settings/components/ui-scale-control";
import { type SignedIn, type SignedOut } from "../lib/auth-api";
import { useAuthStore } from "../stores/auth-store";
import { AccountAvatar } from "./account-avatar";
import { AccountMenuView, type ThemeModeOption } from "./views/account-menu-view";

const THEME_MODES: ReadonlyArray<ThemeModeOption<AppSettings["themeMode"]>> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Shown when the background revocation did not land — offline, or an Atlas
 * outage.
 *
 * States the residual risk instead of implying a clean revocation, because the
 * session is a 7-day rolling credential: "may stay active until it expires" is
 * a real window, and only the user can judge whether it matters on the machine
 * they are walking away from.
 */
const RESIDUAL_SESSION =
  "Signed out on this device. Your Atlas session may stay active on the server until it expires.";

/** The account menu's container: the snapshot, settings and actions it needs,
 *  handed to `AccountMenuView` as plain props. */
export function AccountMenu({
  account,
  side = "top",
  extra,
  children,
}: {
  /**
   * The whole signed-in snapshot rather than its pieces, so the menu cannot be
   * handed an identity and a set of organisations that came from different
   * moments. `account.user` may be `null` (see `SignedIn.user`).
   */
  account: SignedIn | SignedOut;
  /** Which way the menu opens from the avatar. */
  side?: "top" | "bottom";
  /** Rows a host folds in after Privacy (the title bar's Help). */
  extra?: ReactNode;
  children: ReactElement;
}) {
  const { signOut, beginSignIn } = useAuthStore.use.actions();
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const settingsKeys = useActionShortcut("app.settings")?.label;
  const signedIn = account.status === "signed-in";
  const user = signedIn ? account.user : null;
  const scale =
    SCALE_PRESETS.find((p) => p.value === settings.uiScale)?.label ??
    `${Math.round(settings.uiScale * 100)}%`;

  // Not awaited by anything on screen: the button has already flipped by the
  // time this promise settles, off the state event Rust emits before it touches
  // the network. All that arrives here is whether a caveat is owed.
  const onSignOut = async () => {
    if (!(await signOut())) toast.warning(RESIDUAL_SESSION);
  };

  return (
    <AccountMenuView
      user={
        user
          ? { name: user.name, email: user.email, avatar: <AccountAvatar user={user} size={28} /> }
          : null
      }
      signedIn={signedIn}
      side={side}
      settingsShortcut={settingsKeys ? <KbdCombo combo={settingsKeys} /> : undefined}
      themeMode={settings.themeMode}
      themeModes={THEME_MODES}
      onThemeModeChange={(themeMode) => void updateSettings({ themeMode })}
      scaleLabel={scale}
      interfaceSizePanel={<UiScalePanel />}
      extra={extra}
      onSignIn={() => void beginSignIn()}
      onOpenSection={openSettingsSection}
      onSignOut={() => void onSignOut()}
    >
      {children}
    </AccountMenuView>
  );
}
