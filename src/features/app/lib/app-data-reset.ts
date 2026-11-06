// "Clear cache" and "Reset Atlas", asked the same way from Settings › Privacy
// and from the ⌘K palette.

import { toast } from "sonner";
import { confirm } from "@/lib/confirm";
import { loadAppProfile, type AppProfile } from "@/lib/app-profile";
import { resetAppData, type AppDataResetScope } from "./app-data-api";

function prompt(scope: AppDataResetScope, { dev, productName, dirName }: AppProfile) {
  // Atlas Dev quits rather than restarting: its dev server stops with it
  // (`commands::app_data_reset`).
  const when = dev
    ? `${productName} quits, and the next time you start it`
    : `${productName} restarts, and`;
  return scope === "cache"
    ? {
        title: "Clear cache?",
        body: `${when} its cache is deleted: downloaded media and shared sessions (fetched again when needed), notification icons, pasted files and the web view's cache. Your sessions, settings and sign-ins stay. Running agents are stopped.`,
        confirmLabel: dev ? "Clear and quit" : "Clear and restart",
      }
    : {
        title: `Reset ${productName}?`,
        body: `${when} it starts from first-run setup. Every session, setting and sign-in on this computer is deleted, along with its cache and preferences. Running agents are stopped. Not touched: your projects, the memory and logs in ~/${dirName}, your agent CLIs' own sign-ins, and agent variables kept in the system keychain.`,
        confirmLabel: `Reset ${productName}`,
      };
}

export async function confirmAppDataReset(scope: AppDataResetScope): Promise<void> {
  const profile = await loadAppProfile();
  const ok = await confirm({ ...prompt(scope, profile), destructive: true });
  if (!ok) return;
  try {
    await resetAppData(scope);
  } catch (e) {
    toast.error(
      `Couldn't ${scope === "cache" ? "clear the cache" : `reset ${profile.productName}`}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
