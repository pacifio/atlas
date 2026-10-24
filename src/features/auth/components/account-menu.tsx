import type { ReactElement, ReactNode } from "react";
import { LogIn, LogOut, Moon, Settings, Shield, Type } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { toast } from "sonner";

import { KbdCombo } from "@/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { AppSettings } from "@/features/settings/lib/app-settings";
import { SCALE_PRESETS } from "@/features/settings/lib/ui-scale";
import { UiScalePanel } from "@/features/settings/components/ui-scale-control";
import { type AccountUser, type SignedIn, type SignedOut } from "../lib/auth-api";
import { useAuthStore } from "../stores/auth-store";
import { AccountAvatar } from "./account-avatar";

const THEME_MODES: Array<{ value: AppSettings["themeMode"]; label: string }> = [
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

/**
 * The menu behind the sidebar footer's avatar, laid out as the Atlas web app's:
 * who you are, Settings and Privacy, the two appearance choices people change
 * most (theme and interface size, each a submenu showing its current value),
 * and the way out.
 *
 * Wraps the account button rather than replacing it, so signed out the button
 * keeps its plain click-to-sign-in behaviour and this component is simply not
 * rendered. Escape, click-away, arrow keys and type-ahead come from Base UI,
 * the same primitive every other Atlas menu uses.
 */
export function AccountMenu({
  account,
  side = "top",
  extra,
  children,
}: {
  /**
   * The whole signed-in snapshot rather than its pieces, so the menu cannot be
   * handed an identity and a set of organisations that came from different
   * moments.
   *
   * `account.user` is `null` in the narrow window between holding a credential
   * and the first successful profile fetch (see `SignedIn.user`). The menu still
   * opens, and Sign Out still works — neither depends on identity, and a
   * credential we cannot put a name to is still one the user must be able to
   * disconnect. There is simply no header to render, and inventing a placeholder
   * name would be worse than the gap it fills.
   */
  account: SignedIn | SignedOut;
  /** Which way the menu opens from the avatar. */
  side?: "top" | "bottom";
  /** Rows a host folds in after Privacy (the title bar's Help), so they sit
   *  with the other places this menu goes. */
  extra?: ReactNode;
  children: ReactElement;
}) {
  const { signOut, beginSignIn } = useAuthStore.use.actions();
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const settingsKeys = useActionShortcut("app.settings")?.label;
  const signedIn = account.status === "signed-in";
  const user = signedIn ? account.user : null;
  const theme = THEME_MODES.find((m) => m.value === settings.themeMode)?.label ?? "System";
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
    <DropdownMenu>
      <DropdownMenuTrigger render={children} />
      <DropdownMenuContent side={side} align="end" sideOffset={6} className="w-60">
        {/* The account zone is always first, whichever state we are in: the
            identity when there is one, the way to get one when there is not. */}
        {user && <Header user={user} />}
        {!signedIn && (
          <>
            <DropdownMenuItem onClick={() => void beginSignIn()}>
              <LogIn />
              Sign in
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => openSettingsSection("general")}>
          <Settings />
          Settings
          {settingsKeys && (
            <DropdownMenuShortcut>
              <KbdCombo combo={settingsKeys} />
            </DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openSettingsSection("privacy")}>
          <Shield />
          Privacy
        </DropdownMenuItem>
        {extra}

        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Moon />
            Theme
            <span className="ml-auto text-muted-foreground">{theme}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={settings.themeMode}
              onValueChange={(value) =>
                void updateSettings({ themeMode: value as AppSettings["themeMode"] })
              }
            >
              {THEME_MODES.map((m) => (
                <DropdownMenuRadioItem key={m.value} value={m.value}>
                  {m.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {/* The interface size lives here, as on the web: it is a personal
            preference about how Atlas looks, the same kind as the theme. The
            whole control is folded in — stepper, presets, Reset — not a
            reduced list. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Type />
            Interface size
            <span className="ml-auto text-muted-foreground">{scale}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-58">
            <UiScalePanel />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Separated from the rows above: everything else here navigates or
            sets a preference, and this one ends the session. Rendered whenever
            a credential is held, with or without a profile. */}
        {signedIn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void onSignOut()}>
              <LogOut />
              Log out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Avatar, name and email — the "who am I signed in as" answer. */
function Header({ user }: { user: AccountUser }) {
  // A name is not guaranteed: some providers give us only an address. Falling
  // back to the email keeps the primary line filled rather than showing a blank
  // row above the address, and the second line is dropped when it would just
  // repeat the first.
  const name = user.name.trim();
  const email = user.email.trim();
  const primary = name || email;

  return (
    <>
      {/* A labelled group, not a bare div: inside `role="menu"` an unlabelled
          block is announced as loose text between the items. Base UI reads the
          label's group from context and throws without one. The raw primitive,
          not `DropdownMenuLabel`: that one is the small-caps section eyebrow. */}
      <DropdownMenuGroup>
        <MenuPrimitive.GroupLabel className="flex items-center gap-2.5 px-2 py-1.5">
          <AccountAvatar user={user} size={28} />
          {/* `min-w-0` against the content's width is what makes a long
              address truncate rather than stretch the whole menu. */}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{primary}</div>
            {email && email !== primary && (
              <div className="truncate text-xs text-muted-foreground">{email}</div>
            )}
          </div>
        </MenuPrimitive.GroupLabel>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}
