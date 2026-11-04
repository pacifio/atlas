import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { updater, type UpdateAvailable } from "./updater-api";

/**
 * The Linux side of "an update exists". macOS and Windows download and stage
 * the update and then show the restart modal; Linux never does (its packages
 * belong to the package manager), so `commands::updater` on Linux only emits
 * `atlas:update-available` with the release page, and this turns it into a
 * notice that stays until the user acts on it.
 *
 * The URL has already been limited to the project's own release page and site
 * in Rust (`updater_linux.rs`); an event without one is not announced.
 */
export function announceLinuxRelease(event: UpdateAvailable): void {
  const url = event.url;
  if (!url) return;
  toast(`Atlas ${event.version} is available`, {
    // One notice per version, however many checks find it.
    id: `linux-release:${event.version}`,
    description: "Update with your package manager, or download it from the release page.",
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Release page",
      onClick: () => {
        void openUrl(url).catch(() => window.open(url, "_blank"));
      },
    },
    cancel: {
      label: "Skip this version",
      onClick: () => {
        void updater.ignore(event.version);
      },
    },
  });
}
