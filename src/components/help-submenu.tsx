// The account menu's Help submenu: docs, feedback, shortcuts, the community
// links, the update check and the running version. It used to be its own
// button in the sidebar footer; the account (the avatar at the title bar's
// right end) holds it now.

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDownToLine,
  BookOpen,
  Globe,
  HelpCircle,
  Info,
  Keyboard,
  MessageCircle,
  MessageCircleQuestion,
} from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { DISCORD_URL, DOCS_URL, GITHUB_URL, SITE_URL, X_URL } from "@/lib/atlas-links";
import { GithubIcon } from "@/components/github-icon";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/ui/dropdown-menu";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { updater } from "@/features/updater/lib/updater-api";

/** Help, community and the app's own links — and, at the foot, the update
 *  check and the running version. A submenu of the account menu. */
export function HelpSubmenu() {
  const version = useAppVersion();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <HelpCircle />
        Help
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        <DropdownMenuItem onClick={() => void openUrl(DOCS_URL)}>
          <BookOpen />
          Docs
        </DropdownMenuItem>
        <DropdownMenuItem
          // The panel is non-modal and anchored bottom-right; `toggle` is what
          // the status-bar button uses, and the source tags the report.
          onClick={() => useFeedbackStore.getState().actions.toggle("status-bar")}
        >
          <MessageCircleQuestion />
          Send feedback
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openSettingsSection("keybindings")}>
          <Keyboard />
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void openUrl(GITHUB_URL)}>
          <GithubIcon className="size-3.5" />
          GitHub repo
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void openUrl(DISCORD_URL)}>
          <MessageCircle />
          Discord community
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void openUrl(X_URL)}>
          <XIcon />
          Follow on X
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void openUrl(SITE_URL)}>
          <Globe />
          Our website
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={checkForUpdates}>
          <ArrowDownToLine />
          Check for updates
        </DropdownMenuItem>
        {version && (
          <DropdownMenuItem
            // The bare number is what a version field or a release tag wants;
            // the toast repeats it so there is no doubt about what was copied.
            // `copyText` RESOLVES false on failure rather than rejecting, so
            // the result has to be read.
            onClick={() =>
              void copyText(version).then((ok) => {
                if (ok) toast.success(`Copied ${version}`);
                else toast.error("Could not copy the version.");
              })
            }
          >
            <Info />
            Atlas {version}
            <DropdownMenuShortcut>Copy</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** X's mark. Not in lucide (it ships the pre-rebrand bird), and `currentColor`
 *  on a `fill` so it tracks the row's hover step like every other icon here. */
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** The running build's version. Read from Tauri rather than `package.json`:
 *  the bundle carries its own version, and a stale import would claim the
 *  wrong one after an update. Renders nothing until it resolves. */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void getVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {
        // Not worth surfacing: the help menu simply leaves the row out.
      });
    return () => {
      live = false;
    };
  }, []);
  return version;
}

/** The manual update check the window bar's update icon used to offer when
 *  idle; that icon now appears only once there is an update to show. */
function checkForUpdates(): void {
  void updater
    .checkNow()
    .then((status) => {
      if (!status.available) {
        toast.success(`You're on the latest version (${status.currentVersion}).`);
      }
    })
    .catch((e) =>
      toast.error(`Update check failed: ${e instanceof Error ? e.message : String(e)}`),
    );
}
