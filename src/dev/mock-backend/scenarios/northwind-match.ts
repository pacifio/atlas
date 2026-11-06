// Which scripted run a typed prompt plays. Matching is deliberately loose:
// the prompts are typed live on camera, and a hyphen, a plural or one slipped
// key must not drop the take into the fallback answer.
//
// A run's `match` entries are phrases. Every word of every phrase has to turn
// up somewhere in the prompt, in any order. Case, punctuation and a trailing
// plural `s` never matter; a word of five letters or more also survives one
// typo (a wrong, missing, extra or swapped letter), and a phrase word of five
// or more letters matches any prompt word it begins (`normali` → normalized).
// Short words stay exact, so `code` never matches `mode`.

import type { AgentKey, ScriptedRun } from "./northwind-content-types";

/** Lower-case words with punctuation dropped and a plural `s` trimmed. */
export function promptWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** At most one insertion, deletion, substitution or adjacent swap apart. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    const swapped = a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    return swapped || a.slice(i + 1) === b.slice(i + 1);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function wordMatches(wanted: string, typed: string): boolean {
  if (wanted === typed) return true;
  if (wanted.length < 5) return false;
  return typed.startsWith(wanted) || withinOneEdit(wanted, typed);
}

/**
 * How specific a run's match is, in letters, or 0 if a word is missing. So a
 * draft that says "discount pricing" and happens to say "do" and "this" plays
 * the pricing run, not "do this".
 */
function score(run: ScriptedRun, typed: string[]): number {
  const wanted = run.match.flatMap(promptWords);
  if (!wanted.every((w) => typed.some((t) => wordMatches(w, t)))) return 0;
  return wanted.reduce((sum, w) => sum + w.length, 0);
}

/**
 * The run a prompt plays: the most specific one that matches, preferring a
 * run meant for this agent; the earlier run on a tie.
 */
export function matchRun(
  runs: readonly ScriptedRun[],
  prompt: string,
  agent: AgentKey,
): ScriptedRun | undefined {
  const typed = promptWords(prompt);
  const best = (candidates: readonly ScriptedRun[]) => {
    let pick: ScriptedRun | undefined;
    let top = 0;
    for (const run of candidates) {
      const s = score(run, typed);
      if (s > top) [pick, top] = [run, s];
    }
    return pick;
  };
  return best(runs.filter((run) => !run.agent || run.agent === agent)) ?? best(runs);
}
