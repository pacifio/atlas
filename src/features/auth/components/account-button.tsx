import { CircleUser, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuthStore } from "../stores/auth-store";
import { AccountAvatar } from "./account-avatar";
import { AccountMenu } from "./account-menu";

/**
 * The account control at the right of the title bar.
 *
 * Rendered unconditionally — deliberately **outside** the title bar's
 * "a project is open" guard, so a fresh install can connect an account from the
 * empty state rather than having to open a folder first.
 *
 * Signed in, it is the user's face and the trigger for the account menu.
 * Signed out or mid-grant it is a plain button that starts (or reopens)
 * sign-in — the menu has nothing to say in either state.
 */
export function AccountButton() {
  const snapshot = useAuthStore.use.snapshot();
  const starting = useAuthStore.use.starting();
  const { beginSignIn, closeDialog } = useAuthStore.use.actions();
  const dialogOpen = useAuthStore.use.dialogOpen();

  const connecting = snapshot.status === "connecting";
  const signedIn = snapshot.status === "signed-in";
  const user = snapshot.status === "signed-in" ? snapshot.user : null;

  // Only reachable while connecting — every other state opens the menu. Toggles
  // the dialog rather than starting anything, since the grant is already
  // running; reopening it resumes that grant and reopens the browser.
  const toggleDialog = () => {
    if (dialogOpen) closeDialog();
    else void beginSignIn();
  };

  const title = user
    ? `${user.name} (${user.email})`
    : signedIn
      ? "Atlas account — connected"
      : connecting
        ? "Waiting for approval in your browser…"
        : "Account and settings";

  const button = (
    // Only the connecting state keeps a click of its own. In the other two the
    // click is Radix's to handle, and one that also ran would fight the trigger
    // it is wrapped in.
    <button
      onClick={connecting ? toggleDialog : undefined}
      title={title}
      aria-label={title}
      className={cn(
        "relative flex items-center justify-center w-6 h-6 rounded transition-all duration-150",
        // A `<button>` still gets the arrow by default, and this one carries no
        // label or border — the pointer is most of what says it is pressable.
        // Matches the title bar's project-name button beside it.
        "cursor-pointer hover:bg-[#ffffff08] outline-none focus:outline-none",
        signedIn || connecting
          ? "text-[#ccc]"
          : "text-[#555] hover:text-[#aaa]",
      )}
    >
      {starting || connecting ? (
        <Loader2 size={14} className="animate-spin" />
      ) : user ? (
        <AccountAvatar user={user} size={18} />
      ) : (
        <CircleUser size={14} />
      )}
    </button>
  );

  // The menu opens signed out as well as signed in. Settings, Keybindings,
  // Themes, Skills and Layouts live behind this avatar and are not account
  // features — gating them on having an account contradicts the rule that
  // authentication is additive and nothing becomes gated. Signing in is simply
  // the first item when there is no account yet.
  //
  // `connecting` is the exception and keeps its plain click: a grant is already
  // running, the only thing the user wants is the dialog they closed, and
  // putting that behind a menu adds a step to a state that lasts seconds.
  if (snapshot.status === "connecting") return button;
  return <AccountMenu account={snapshot}>{button}</AccountMenu>;
}
