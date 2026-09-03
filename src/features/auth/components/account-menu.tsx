import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Keyboard, LayoutTemplate, LogIn, LogOut, Palette, Settings, Zap } from "lucide-react";
import { toast } from "sonner";

import { ActionShortcut } from "@/features/keybindings/components/action-shortcut";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { SettingsSection } from "@/features/settings/stores/settings-nav-store";
import { type AccountUser, type SignedIn, type SignedOut } from "../lib/auth-api";
import { useAuthStore } from "../stores/auth-store";
import { AccountAvatar } from "./account-avatar";

/**
 * The account menu's destinations.
 *
 * `label` is what the user is looking for and `section` is where it lives —
 * "Themes" is the Appearance section, not one of its own.
 *
 * `command` is set only where a keybinding command really exists, so the chord
 * shown beside an item is whatever that command is currently bound to.
 */
const ITEMS: Array<{
  label: string;
  icon: typeof Settings;
  section: SettingsSection;
  command?: ActionId;
}> = [
  { label: "Settings", icon: Settings, section: "general", command: "open-settings" },
  { label: "Keybindings", icon: Keyboard, section: "keybindings" },
  { label: "Themes", icon: Palette, section: "appearance" },
  { label: "Skills", icon: Zap, section: "skills" },
  { label: "Layouts", icon: LayoutTemplate, section: "layouts" },
];

// Same shape as the composer's "+" menu, so every Atlas dropdown reads alike.
// `--z-max` matches the sidebar's add-project menu: the content is portalled to
// `body`, so it is not competing with the title bar, but it does share a
// stacking context with every dialog and overlay in the app.
const CONTENT_CLASS =
  "z-[var(--z-max)] min-w-[228px] max-w-[300px] rounded-md border border-[var(--border-default)] " +
  "bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1";

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

// `cursor-pointer`, not the `cursor-default` a native menu would use: every row
// carrying this class does something when clicked, and the pointer says so.
// It is deliberately on the class the *actionable* rows share — the identity
// header is a `Label` and keeps the arrow, so the cursor distinguishes what you
// can act on from what is only being reported.
const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-pointer outline-none " +
  "text-[var(--text-secondary)] data-[highlighted]:bg-[var(--bg-hover)] " +
  "data-[highlighted]:text-[var(--text-primary)]";

// Hoisted for the same reason as the two above: this menu now has three
// separators, and a rule one of them disagreed with would be visible.
const SEPARATOR_CLASS = "my-1 h-px bg-[var(--border-default)]";

/**
 * The menu behind the title bar's avatar — who you are, the parts of Settings
 * people actually reach for, and the way out.
 *
 * Wraps the account button rather than replacing it, so signed out the button
 * keeps its plain click-to-sign-in behaviour and this component is simply not
 * rendered. Escape, click-away, arrow keys and type-ahead come from Radix, the
 * same primitive every other Atlas menu uses.
 */
export function AccountMenu({
  account,
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
  children: ReactNode;
}) {
  const { signOut, beginSignIn } = useAuthStore.use.actions();
  const signedIn = account.status === "signed-in";
  const user = signedIn ? account.user : null;

  // Not awaited by anything on screen: the title bar has already flipped by the
  // time this promise settles, off the state event Rust emits before it touches
  // the network. All that arrives here is whether a caveat is owed.
  const onSignOut = async () => {
    if (!(await signOut())) toast.warning(RESIDUAL_SESSION);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={CONTENT_CLASS}>
          {/* The account zone is always first, whichever state we are in: the
              identity when there is one, the way to get one when there is not.
              Keeping it in the same place means the destinations below never
              move under the pointer as the user signs in or out. */}
          {user && <Header user={user} />}
          {!signedIn && (
            <>
              <DropdownMenu.Item onSelect={() => void beginSignIn()} className={ITEM_CLASS}>
                <LogIn size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="flex-1 text-left">Sign In</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className={SEPARATOR_CLASS} />
            </>
          )}
          {ITEMS.map((item) => (
            <DropdownMenu.Item
              key={item.section}
              onSelect={() => openSettingsSection(item.section)}
              className={ITEM_CLASS}
            >
              <item.icon size={13} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.command && <ActionShortcut actionId={item.command} />}
            </DropdownMenu.Item>
          ))}
          {/* Separated from the destinations above: everything else in this
              menu navigates, and this one ends the session. Rendered whenever a
              credential is held, with or without a profile — one we cannot put
              a name to is still one the user must be able to disconnect. */}
          {signedIn && (
            <>
              <DropdownMenu.Separator className={SEPARATOR_CLASS} />
              <DropdownMenu.Item onSelect={() => void onSignOut()} className={ITEM_CLASS}>
                <LogOut size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="flex-1 text-left">Sign Out</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
      {/* `Label`, not a bare div: inside `role="menu"` an unlabelled block is
          announced as loose text between the items. This is the menu's title. */}
      <DropdownMenu.Label className="flex items-center gap-2.5 px-3 py-1.5">
        <AccountAvatar user={user} size={28} />
        {/* `flex-1 min-w-0` against the content's max width is what makes a
            long address truncate rather than stretch the whole menu. */}
        <div className="flex-1 min-w-0">
          <div className="truncate text-[11.5px] font-medium text-[var(--text-primary)]">
            {primary}
          </div>
          {email && email !== primary && (
            <div className="truncate text-[10.5px] text-[var(--text-tertiary)]">{email}</div>
          )}
        </div>
      </DropdownMenu.Label>
      <DropdownMenu.Separator className={SEPARATOR_CLASS} />
    </>
  );
}
