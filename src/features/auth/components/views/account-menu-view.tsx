import type { ReactElement, ReactNode } from "react";
import { LogIn, LogOut, Moon, Settings, Shield, Type } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
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
} from "@tryatlas/design";

/** Who the header names. `avatar` is rendered by the container. */
export interface AccountMenuUser {
  name: string;
  email: string;
  avatar: ReactNode;
}

export interface ThemeModeOption<T extends string> {
  value: T;
  label: string;
}

/**
 * The menu behind the title bar's avatar, laid out as the Atlas web app's:
 * who you are, Settings and Privacy, the two appearance choices people change
 * most (theme and interface size, each a submenu showing its current value),
 * and the way out.
 *
 * Wraps the account button (`children`) rather than replacing it. Escape,
 * click-away, arrow keys and type-ahead come from Base UI, the same primitive
 * every other Atlas menu uses.
 */
export function AccountMenuView<T extends string>({
  user,
  signedIn,
  side = "top",
  settingsShortcut,
  themeMode,
  themeModes,
  onThemeModeChange,
  scaleLabel,
  interfaceSizePanel,
  extra,
  onSignIn,
  onOpenSection,
  onSignOut,
  children,
}: {
  /**
   * `null` signed out, and also in the narrow window between holding a
   * credential and the first successful profile fetch. The menu still opens,
   * and Sign Out still works — neither depends on identity, and a credential
   * we cannot put a name to is still one the user must be able to disconnect.
   * There is simply no header to render, and inventing a placeholder name
   * would be worse than the gap it fills.
   */
  user: AccountMenuUser | null;
  signedIn: boolean;
  /** Which way the menu opens from the avatar. */
  side?: "top" | "bottom";
  settingsShortcut?: ReactNode;
  themeMode: T;
  themeModes: readonly ThemeModeOption<T>[];
  onThemeModeChange: (mode: T) => void;
  /** The interface size's current value, shown on its submenu row. */
  scaleLabel: string;
  /** The interface-size control, folded in whole (stepper, presets, Reset). */
  interfaceSizePanel: ReactNode;
  /** Rows a host folds in after Privacy (the title bar's Help), so they sit
   *  with the other places this menu goes. */
  extra?: ReactNode;
  onSignIn: () => void;
  onOpenSection: (section: "general" | "privacy") => void;
  onSignOut: () => void;
  children: ReactElement;
}) {
  const themeLabel = themeModes.find((m) => m.value === themeMode)?.label ?? "System";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={children} />
      <DropdownMenuContent side={side} align="end" sideOffset={6} className="w-60">
        {/* The account zone is always first, whichever state we are in: the
            identity when there is one, the way to get one when there is not. */}
        {user && <Header user={user} />}
        {!signedIn && (
          <>
            <DropdownMenuItem onClick={onSignIn}>
              <LogIn />
              Sign in
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => onOpenSection("general")}>
          <Settings />
          Settings
          {settingsShortcut && <DropdownMenuShortcut>{settingsShortcut}</DropdownMenuShortcut>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpenSection("privacy")}>
          <Shield />
          Privacy
        </DropdownMenuItem>
        {extra}

        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Moon />
            Theme
            <span className="ml-auto text-muted-foreground">{themeLabel}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={themeMode}
              onValueChange={(value) => onThemeModeChange(value as T)}
            >
              {themeModes.map((m) => (
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
            <span className="ml-auto text-muted-foreground">{scaleLabel}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-58">{interfaceSizePanel}</DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Separated from the rows above: everything else here navigates or
            sets a preference, and this one ends the session. Rendered whenever
            a credential is held, with or without a profile. */}
        {signedIn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onSignOut}>
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
function Header({ user }: { user: AccountMenuUser }) {
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
          {user.avatar}
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
