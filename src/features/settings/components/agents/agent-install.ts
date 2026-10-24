// What the Agents page knows about each agent, and the install, update and
// remove actions behind it.
//
// An ACP agent comes to exist one way (ADR-0002): the user installs it. Atlas
// ships none, so there is nothing "built-in" to switch off. An agent is the
// native one, installed, merely detected on the user's PATH, or an offer in
// the registry.
//
// Installs in flight live at MODULE scope behind useSyncExternalStore, so
// leaving the page mid-install doesn't lose the spinner. Binary downloads
// stream progress over `atlas:registry-install:progress`.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { withDeadline } from "@/features/chat/lib/with-deadline";
import {
  acpRegistry,
  type AcpRegistryEntry,
  type RegistryInstallProgress,
} from "@/features/agents/lib/agent-registry-api";
import {
  hydrateAgentRegistry,
  refreshAgentRegistry,
  useAgentRegistryStore,
} from "@/features/agents/stores/agent-registry-store";
import { updateAgent } from "@/features/agents/lib/agent-update";
import { agentConfig, type AgentConfigPatch } from "@/features/agents/lib/agent-config-api";
import { useRemoveAgentConfirmStore } from "@/features/agents/lib/remove-agent-confirm";
import type { AgentCatalogEntry } from "@/types/agent-catalog";

/** Which action an agent offers. Pure and exported so the precedence is tested
 *  rather than re-read out of JSX.
 *
 *  "detected" is the system-first addition: the agent is on the user's PATH and
 *  spawns from there, but Atlas never installed it, so offering "Remove" would
 *  be a lie, and offering "Install" alone would hide that it already works. */
export function cardState(
  entry: AcpRegistryEntry,
  catalog: AgentCatalogEntry | undefined,
): "installed" | "detected" | "install" {
  if (entry.installed) return "installed";
  if (catalog?.source === "detected") return "detected";
  return "install";
}

/** Which install an agent's action performs.
 *
 *  A detection is ACCEPTED: the installed-agents map gets a `custom` entry
 *  pointing at the binary already on the user's machine, so Atlas runs their
 *  copy. Every other install downloads Atlas's own. Both write the same map;
 *  only the entry differs, and that difference is the whole point of a
 *  detection. */
export function installKind(state: ReturnType<typeof cardState>): "detected" | "registry" {
  return state === "detected" ? "detected" : "registry";
}

/** An entry for an agent the registry listing doesn't cover: one found on the
 *  user's PATH, or one they installed that was never published. Deduped by id
 *  against the real listing by [`marketplaceCards`]. */
function syntheticCard(entry: AgentCatalogEntry): AcpRegistryEntry {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version ?? "",
    description: entry.description,
    repository: entry.repository,
    website: entry.website,
    iconDataUrl: entry.iconDataUrl,
    installed: entry.installed,
    // Not a platform claim from a manifest: this agent is on THIS machine, so
    // the only way it is unsupported here is the catalog saying its install
    // resolves to nothing runnable.
    platformSupported: entry.source !== "unavailable",
    distributionKind: entry.distributionKind,
    unverified: entry.unverified,
    unsupportedReason: entry.unsupportedReason,
    installedVersion: null,
    updateAvailable: false,
  };
}

/** Every external agent: the registry's own listing, plus one synthesized
 *  entry per agent Atlas knows about that the listing has never heard of.
 *
 *  That second group is both halves of "off the registry": an agent merely
 *  found on the user's PATH, and one they have already installed from there.
 *  Dropping the installed half is what once made a hand-installed agent
 *  disappear from Settings the moment it was accepted, taking its only
 *  Remove button with it.
 *
 *  The native agent is never here: it is in-process, so there is nothing to
 *  install and nothing to remove. */
export function marketplaceCards(
  listed: AcpRegistryEntry[],
  catalogById: Record<string, AgentCatalogEntry>,
): AcpRegistryEntry[] {
  const listedIds = new Set(listed.map((e) => e.id));
  const offRegistry = Object.values(catalogById)
    .filter((e) => e.kind !== "native" && !listedIds.has(e.id))
    // catalogById is keyed by BOTH id and agentType, so one entry can appear
    // twice. Dedupe before synthesizing.
    .filter((e, i, all) => all.findIndex((o) => o.id === e.id) === i)
    .map(syntheticCard);
  return [...listed, ...offRegistry];
}

/** One agent as the page lists it. */
export interface AgentItem {
  id: string;
  /** The agentType-shaped identity `AgentMark` resolves. */
  agentType: string;
  name: string;
  state: "native" | "installed" | "detected" | "install";
  entry: AcpRegistryEntry | null;
  catalog: AgentCatalogEntry | undefined;
}

/** The agents the page lists on the left: the native agent first, then what
 *  the user has (installed, then detected), each alphabetical. Registry offers
 *  are left to the Add agent dialog. */
export function libraryItems(
  listed: AcpRegistryEntry[],
  catalogById: Record<string, AgentCatalogEntry>,
): AgentItem[] {
  const native = Object.values(catalogById).find((e) => e.kind === "native");
  const externals = marketplaceCards(listed, catalogById)
    .map((entry): AgentItem => {
      const catalog = catalogById[entry.id];
      return {
        id: entry.id,
        agentType: catalog?.agentType ?? entry.id,
        name: entry.name,
        state: cardState(entry, catalog),
        entry,
        catalog,
      };
    })
    .filter((item) => item.state !== "install")
    .sort(
      (a, b) =>
        Number(a.state === "detected") - Number(b.state === "detected") ||
        a.name.localeCompare(b.name),
    );
  return native
    ? [
        {
          id: native.id,
          agentType: native.agentType,
          name: native.name,
          state: "native",
          entry: null,
          catalog: native,
        },
        ...externals,
      ]
    : externals;
}

// ── Module-scope install tracking (survives unmount) ─────────────────────────

const installingIds = new Set<string>();
/** Latest download progress per agent id (binary distributions only). */
const progressById = new Map<string, RegistryInstallProgress>();
let installVersion = 0;
const installSubs = new Set<() => void>();
function notifyInstalling() {
  installVersion++;
  installSubs.forEach((f) => f());
}
function subscribeInstalling(cb: () => void) {
  installSubs.add(cb);
  return () => installSubs.delete(cb);
}

/** Re-renders on every install start, tick and finish. */
export function useInstalls() {
  useSyncExternalStore(subscribeInstalling, () => installVersion);
  return {
    installing: (id: string) => installingIds.has(id),
    /** Download percentage, or null before the first tick or for npx. */
    percent: (id: string): number | null => {
      const p = progressById.get(id);
      return installingIds.has(id) && p?.total
        ? Math.min(100, Math.round((p.received / p.total) * 100))
        : null;
    },
  };
}

/** Feed binary-download progress into the installs while the page is open. */
export function useInstallProgress() {
  useEffect(() => {
    const unlisten = listen<RegistryInstallProgress>("atlas:registry-install:progress", (event) => {
      progressById.set(event.payload.agentId, event.payload);
      notifyInstalling();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);
}

/** The install command writes a map entry; only a stale-registry refresh (30 s) can precede it. */
const INSTALL_DEADLINE_MS = 60_000;

export async function installAgent(entry: AcpRegistryEntry, kind: "detected" | "registry") {
  if (installingIds.has(entry.id)) return;
  installingIds.add(entry.id);
  notifyInstalling();
  try {
    // A settings write plus, at most, one registry refresh (30 s in Rust).
    // Without the deadline a stuck install said "Installing…" forever.
    const request =
      kind === "detected" ? acpRegistry.installDetected(entry.id) : acpRegistry.install(entry.id);
    await withDeadline(request, INSTALL_DEADLINE_MS, `Installing ${entry.name} has not finished`);
    toast.success(`${entry.name} added`);
  } catch (e) {
    toast.error(`Couldn't install ${entry.name}: ${String(e)}`);
  } finally {
    installingIds.delete(entry.id);
    progressById.delete(entry.id);
    notifyInstalling();
  }
  // One re-read now that the installed map moved: it refreshes this page and
  // every other agent surface at once.
  await hydrateAgentRegistry();
}

export function updateAgentTo(entry: AcpRegistryEntry) {
  void updateAgent(entry.id, entry.name, entry.version);
}

/** Asks first. Not `window.confirm`: WebView2 answers it `true` with no
 *  dialog, so on Windows Remove fired unconfirmed. Resolves true on removal. */
export async function removeAgent(entry: { id: string; name: string }): Promise<boolean> {
  const ok = await useRemoveAgentConfirmStore.getState().actions.ask({ name: entry.name });
  if (!ok) return false;
  try {
    await acpRegistry.uninstall(entry.id);
    toast.success(`${entry.name} removed`);
  } catch (e) {
    toast.error(`Couldn't remove ${entry.name}: ${String(e)}`);
    return false;
  } finally {
    await hydrateAgentRegistry();
  }
  return true;
}

// ── The registry listing ─────────────────────────────────────────────────────

/** How long a listing stays good enough to show without going back out to the
 *  network. Matches the backend's own refresh throttle, so a revalidate inside
 *  this window would be a no-op round trip anyway. */
const STALE_AFTER_MS = 60 * 60 * 1000;

export async function refreshListing() {
  await refreshAgentRegistry();
  const { registryError, registryEntries } = useAgentRegistryStore.getState();
  // Only shout when there is nothing to fall back on. With cached entries on
  // screen the inline note says it without a toast.
  if (registryError && registryEntries.length === 0) {
    toast.error(`Couldn't load the ACP registry: ${registryError}`);
  }
}

/** Stale-while-revalidate: paint the cache now, confirm it in the background,
 *  and only reach for the network when what we hold is actually old.
 *
 *  The local re-read is unconditional: it is what re-measures each installed
 *  agent's copy on disk against the registry, and an agent that installed
 *  since the last listing (a first chat, a version bump) emits nothing. */
export function useRevalidatedListing() {
  useEffect(() => {
    const { registryRefreshedAt } = useAgentRegistryStore.getState();
    void hydrateAgentRegistry();
    const age = registryRefreshedAt ? Date.now() - Date.parse(registryRefreshedAt) : Infinity;
    if (!Number.isFinite(age) || age > STALE_AFTER_MS) void refreshListing();
  }, []);
}

/** The listing and catalog, re-read whenever the store's signature moves.
 *  The arrays are read via getState(): a Record-of-objects selector
 *  infinite-loops under useShallow (the store's documented trap). */
export function useAgentListing() {
  const signature = useAgentRegistryStore((s) => s.signature);
  return useMemo(() => {
    const { registryEntries, catalogById } = useAgentRegistryStore.getState();
    return { registryEntries, catalogById, signature };
  }, [signature]);
}

// ── Configuring an agent ─────────────────────────────────────────────────────

/** Write one agent's settings, then re-read the catalog so every surface (the
 *  picker, labels, this page) sees it. Resolves false when it failed, after
 *  saying so. */
export async function configureAgent(
  item: { id: string; name: string },
  patch: AgentConfigPatch,
): Promise<boolean> {
  try {
    await agentConfig.configure(item.id, patch);
    return true;
  } catch (e) {
    toast.error(`Couldn't save ${item.name}'s settings: ${String(e)}`);
    return false;
  } finally {
    await hydrateAgentRegistry();
  }
}

/** Split an arguments field the way a shell would split simple input:
 *  whitespace separates, and single or double quotes keep a space inside one
 *  argument. No escapes or expansion: this is a list, not a script. */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** The inverse of [`parseArgs`]: one line, quoting what needs it. */
export function formatArgs(args: string[]): string {
  return args
    .map((arg) =>
      arg === "" || /[\s"']/.test(arg) ? (arg.includes('"') ? `'${arg}'` : `"${arg}"`) : arg,
    )
    .join(" ");
}

/** The line under an agent's name, in the list and the editor: how it stands. */
export function agentStatus(
  item: AgentItem,
  installing: boolean,
): { text: string; tone?: "warning" } {
  if (installing) return { text: "Adding…" };
  if (item.state === "native") return { text: "Built in" };
  if (item.state === "detected") return { text: "On your PATH · not added" };
  if (item.catalog && !item.catalog.enabled) return { text: "Disabled" };
  if (item.catalog?.source === "unavailable") return { text: "Can't start", tone: "warning" };
  if (item.entry?.updateAvailable) return { text: `Update available · v${item.entry.version}` };
  if (item.catalog?.source === "npx") return { text: "Installed · runs through npx" };
  return { text: "Installed" };
}
