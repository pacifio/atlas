import type { ReactNode } from "react";
import { Sparkles, Search, ArrowRight, GitCompare, FlaskConical } from "lucide-react";

const WELCOME_SUGGESTIONS = [
  { text: "Analyze this codebase", Icon: Search },
  { text: "Create a new feature", Icon: Sparkles },
  { text: "Review recent changes", Icon: GitCompare },
  { text: "Write tests for...", Icon: FlaskConical },
] as const;

/** The empty session: a greeting and four starter prompts. `backdrop` is the
 *  glow behind it; `onPick` receives a starter's text. */
export function WelcomeStateView({
  greeting,
  backdrop,
  onPick,
}: {
  greeting: string;
  backdrop: ReactNode;
  onPick: (text: string) => void;
}) {
  return (
    // No entrance animations here, deliberately. Every `atlas-fade-in` element
    // is `animation-fill-mode: both`, and a filled accelerated opacity
    // animation leaves the element on its own compositing layer for good. This
    // panel stays MOUNTED behind whichever tab is showing (see the chat wrapper
    // in `center-panel.tsx`), and WebKit took ~100ms to drop those stale layers
    // when the wrapper turned `visibility:hidden` — so the suggestion cards kept
    // painting on top of the tab you had just switched to.
    <div className="relative h-full flex items-center justify-center overflow-hidden px-6">
      {backdrop}
      <div className="relative w-full max-w-[440px] flex flex-col items-start">
        <p className="text-lg text-[var(--muted-foreground)]">{greeting}</p>
        {/* ratchet-allow: the one-off welcome headline sits between text-xl (20px) and text-2xl (24px) */}
        <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-[var(--foreground)]">
          What are we building?
        </h2>

        <div className="mt-6 grid w-full grid-cols-2 gap-2.5">
          {WELCOME_SUGGESTIONS.map(({ text, Icon }) => (
            <button
              key={text}
              onClick={() => onPick(text)}
              // Hover lifts onto `--muted`, the next surface step up from the
              // card, with a soft negatively-spread shadow under it. `shadow-md`
              // is the menu elevation and turned a 2px lift into a floating slab.
              // ratchet-allow: a hover lift halo, deliberately softer than any elevation step
              className="group relative flex flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-left transition-[translate,background-color,border-color,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-border-strong hover:bg-[var(--muted)] hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)] cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <span className="grid h-7 w-7 place-items-center rounded-lg border border-border-subtle bg-[var(--card)] text-[var(--muted-foreground)] transition-colors group-hover:text-[var(--foreground)]">
                  <Icon size={13} />
                </span>
                <ArrowRight
                  size={13}
                  className="-translate-x-1 text-disabled opacity-0 transition-[translate,color,opacity] group-hover:translate-x-0 group-hover:text-[var(--secondary-foreground)] group-hover:opacity-100"
                />
              </div>
              <span className="text-sm font-medium leading-snug text-[var(--secondary-foreground)] transition-colors group-hover:text-[var(--foreground)]">
                {text}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
