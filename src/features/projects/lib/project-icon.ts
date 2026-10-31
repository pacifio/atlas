// A project's own icon (its favicon or app icon, found by Rust in
// `commands::project_icon`), and the monogram that stands in when it ships
// none.
//
// The icon is fetched once per project path and shared: the sidebar can
// show a project's badge on dozens of rows, and each row must not ask. The
// cache is module-level and read through `useSyncExternalStore`, so a row
// re-renders when its own project's icon lands and never otherwise.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/** `undefined`: not asked yet or in flight; `null`: the project has none. */
const icons = new Map<string, string | null>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function request(path: string): void {
  if (icons.has(path) || inFlight.has(path)) return;
  inFlight.add(path);
  invoke<string | null>("project_icon", { projectPath: path })
    .catch(() => null)
    .then((icon) => {
      inFlight.delete(path);
      icons.set(path, icon ?? null);
      for (const listener of listeners) listener();
    });
}

/** Forget a project's icon, so the next badge asks again (a clone finished,
 *  a favicon was added). */
export function invalidateProjectIcon(path: string): void {
  if (!icons.delete(path)) return;
  for (const listener of listeners) listener();
}

/** The project's icon as a `data:` URL, `null` when it has none or while it
 *  is being looked up. */
export function useProjectIcon(path: string | null | undefined): string | null {
  return useSyncExternalStore(subscribe, () => {
    if (!path) return null;
    if (!icons.has(path)) request(path);
    return icons.get(path) ?? null;
  });
}

// ── The monogram ─────────────────────────────────────────────────────────

/** The theme's terminal colours: a categorical set every theme restates, so
 *  a monogram recolours with the theme instead of carrying fixed hues. */
export const PROJECT_MONOGRAM_COLORS = [
  "var(--atlas-terminal-ansi-red)",
  "var(--atlas-terminal-ansi-yellow)",
  "var(--atlas-terminal-ansi-green)",
  "var(--atlas-terminal-ansi-cyan)",
  "var(--atlas-terminal-ansi-blue)",
  "var(--atlas-terminal-ansi-magenta)",
  "var(--atlas-terminal-ansi-bright-red)",
  "var(--atlas-terminal-ansi-bright-yellow)",
  "var(--atlas-terminal-ansi-bright-green)",
  "var(--atlas-terminal-ansi-bright-cyan)",
  "var(--atlas-terminal-ansi-bright-blue)",
  "var(--atlas-terminal-ansi-bright-magenta)",
] as const;

function normalizeName(name: string): string {
  return name.normalize("NFKC").trim();
}

/**
 * Two letters for a project name: the first letter, then the first digit of
 * the first word, else the first letter of the last word, else the first
 * word's last letter. "atlas" → "AS", "atlas-work" → "AW", "k8s-tools" → "K8".
 */
export function projectMonogram(name: string): string {
  const words = normalizeName(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0]!;
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words[words.length - 1]!)[0] : glyphs[glyphs.length - 1]) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

/** A stable colour for a project name: the same project reads the same
 *  everywhere, and across launches. */
export function projectMonogramColor(name: string): string {
  const seed = normalizeName(name).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_MONOGRAM_COLORS.length;
  }
  return PROJECT_MONOGRAM_COLORS[index]!;
}
