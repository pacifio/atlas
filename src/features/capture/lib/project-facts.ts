// What capture knows about a project — its binding (where it is shared) and
// what the folder is (origin, root commit) — read once and kept.
//
// The Details card's Session section shows these, and the card's body mounts
// on every expand: reading them per mount painted "Reading project…" for a
// frame and then jumped to the rows. None of it changes while you collapse a
// card. So the answer is cached per project and re-read only when something
// that can change it happens:
//
//  * `atlas:capture-changed` with NO session ids — the sync worker and the
//    cloud board. They move sync state: a Project registering gets its server
//    id, a drain changes the gate. (The recording worker's emits name the
//    sessions they wrote; that is per-turn traffic and changes none of this.)
//  * the capture popover finishing an action (connect, switch, pause…), which
//    calls `invalidateProjectFacts` — those commands emit nothing of their own.
//
// A re-read that comes back the same changes nothing: subscribers are told
// only when the facts differ.

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Binding, Detection } from "../types";

export interface ProjectFacts {
  binding: Binding | null;
  detection: Detection | null;
}

/** Sync-worker emits are themselves debounced in Rust; this folds a burst. */
const REFRESH_DEBOUNCE_MS = 500;

const cache = new Map<string, ProjectFacts>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let listening = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function notify(): void {
  for (const l of listeners) l();
}

async function read(projectPath: string): Promise<ProjectFacts> {
  const [binding, detection] = await Promise.all([
    invoke<Binding | null>("capture_binding", { projectPath }).catch(() => null),
    invoke<Detection | null>("capture_detect", { projectPath }).catch(() => null),
  ]);
  return { binding: binding ?? null, detection: detection ?? null };
}

/** Re-read one project's facts; concurrent calls share the read. */
export function refreshProjectFacts(projectPath: string): Promise<void> {
  const pending = inFlight.get(projectPath);
  if (pending) return pending;
  const p = read(projectPath)
    .then((next) => {
      const prev = cache.get(projectPath);
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
      cache.set(projectPath, next);
      notify();
    })
    .finally(() => inFlight.delete(projectPath));
  inFlight.set(projectPath, p);
  return p;
}

/** Something changed a project's capture setup: re-read it (or every cached
 *  project, without a path). */
export function invalidateProjectFacts(projectPath?: string): void {
  const paths = projectPath ? [projectPath] : [...cache.keys()];
  for (const p of paths) void refreshProjectFacts(p);
}

function startListening(): void {
  if (listening) return;
  listening = true;
  void listen<{ sessionIds?: string[] } | null>("atlas:capture-changed", (e) => {
    if (e.payload?.sessionIds?.length) return; // a recording write — per turn
    clearTimeout(timer);
    timer = setTimeout(() => invalidateProjectFacts(), REFRESH_DEBOUNCE_MS);
  });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The cached facts for a project, read on first use. `undefined` only until
 *  the very first read for that project lands. */
export function useProjectFacts(projectPath: string | null): ProjectFacts | undefined {
  const facts = useSyncExternalStore(subscribe, () =>
    projectPath ? cache.get(projectPath) : undefined,
  );
  useEffect(() => {
    startListening();
    if (projectPath && !cache.has(projectPath)) void refreshProjectFacts(projectPath);
  }, [projectPath]);
  return facts;
}

/** Tests only. */
export function resetProjectFactsCache(): void {
  cache.clear();
  inFlight.clear();
}
