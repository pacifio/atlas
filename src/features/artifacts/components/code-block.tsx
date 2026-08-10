/**
 * A tool payload, rendered with the same machinery as the source-control diff.
 *
 * Built on `highlightDiffLine` + the `.diff-syntax` scope rather than on
 * `highlight.js` directly, and that is the whole design:
 *
 * * **It follows the Atlas theme.** `diff-syntax.css` keys every token off the
 *   active editor theme's `--cm-*` variables, so a payload here matches the
 *   diff view, the editor, and whatever theme is selected. A direct
 *   `highlight.js` stylesheet is one fixed palette that ignores all of it.
 * * **It never applies the bare `.hljs` class.** `github-dark.css` is loaded
 *   globally by the markdown pipeline and its root rule carries a background
 *   *and* `padding: 1em` — which, applied per line, boxes every row and blows
 *   the line height apart.
 * * **It is already cached and bounded.** The tokenizer memoises per
 *   (grammar, line), so a payload that repeats a line pays for it once.
 *
 * Structure is recovered from the text because tools do not label their output:
 * a `Read` result arrives as `26:content` and an `Edit` result is a diff. Both
 * probes need a majority of lines to agree before the block is reinterpreted —
 * half-applying either (numbering prose, tinting code that starts with `-`) is
 * worse than not applying it.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, FileCode2 } from "lucide-react";

import { getLanguage } from "@/features/git/lib/diff";
import { highlightDiffLine } from "@/features/git/lib/diff-highlight";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * Lines past which the block renders plain.
 *
 * The tokenizer is per-line and cached, so the cost is linear and modest — but
 * a 20 000-line result is still 20 000 elements, and colour is not worth that.
 * The payload is shown either way; the cap costs highlighting, never content.
 */
const HIGHLIGHT_LIMIT = 2_000;

/**
 * Lines MOUNTED before the block asks. The highlight cap alone was not enough:
 * `Show full` fetches an entire spilled blob and this component then mounted a
 * div per line — tens of thousands of elements built in one synchronous commit
 * inside a 420px scroller, which is a multi-second hitch on the click. The tail
 * button keeps the whole payload one click away; Copy always carries all of it.
 */
const RENDER_LIMIT = 2_000;

/** One rendered row: its own number, its diff sign, and its code. */
interface Line {
  /** The number to print in the gutter, or `null` when the payload has none. */
  number: number | null;
  sign: "add" | "del" | null;
  code: string;
}

function parse(text: string): { lines: Line[]; numbered: boolean; diff: boolean } {
  const raw = text.replace(/\n$/, "").split("\n");

  // `26:content` or `26→content` — the `Read` shape.
  const numberedRe = /^\s*(\d+)[:→\t]/;
  const numberedCount = raw.filter((l) => numberedRe.test(l)).length;
  const numbered = raw.length > 0 && numberedCount >= Math.ceil(raw.length * 0.6);

  if (numbered) {
    return {
      numbered: true,
      diff: false,
      lines: raw.map((l) => {
        const m = l.match(numberedRe);
        if (!m) return { number: null, sign: null, code: l };
        return { number: Number(m[1]), sign: null, code: l.slice(m[0].length) };
      }),
    };
  }

  // A unified diff body. The `+++` / `---` headers are excluded from the vote so
  // a two-line file diff is not read as an all-additions block.
  const signed = raw.filter(
    (l) => (l.startsWith("+") || l.startsWith("-")) && !/^(\+\+\+|---)/.test(l),
  ).length;
  const diff = signed >= 2 && signed >= Math.ceil(raw.length * 0.25);

  if (diff) {
    return {
      numbered: false,
      diff: true,
      lines: raw.map((l) => {
        if (/^(\+\+\+|---)/.test(l)) return { number: null, sign: null, code: l };
        if (l.startsWith("+")) return { number: null, sign: "add" as const, code: l.slice(1) };
        if (l.startsWith("-")) return { number: null, sign: "del" as const, code: l.slice(1) };
        return { number: null, sign: null, code: l.replace(/^ /, "") };
      }),
    };
  }

  return {
    numbered: false,
    diff: false,
    lines: raw.map((l) => ({ number: null, sign: null, code: l })),
  };
}

export function CodeBlock({
  text,
  /** Shown in the header, and the source of the language guess. */
  path,
  /** Overrides the guess. `getLanguage`'s display names — `"JSON"`, not `"json"`. */
  language,
  label,
  className,
}: {
  text: string;
  path?: string | null;
  language?: string;
  /** Header text when there is no path — `Result`, `Arguments`. */
  label?: string;
  className?: string;
}) {
  const parsed = useMemo(() => parse(text), [text]);
  const lang = language ?? (path ? getLanguage(path) : "");
  const [showAll, setShowAll] = useState(false);
  // A different payload is a different block — restart capped.
  useEffect(() => setShowAll(false), [text]);

  const added = parsed.lines.filter((l) => l.sign === "add").length;
  const removed = parsed.lines.filter((l) => l.sign === "del").length;
  const gutter = parsed.numbered || parsed.diff;
  const colour = parsed.lines.length <= HIGHLIGHT_LIMIT;
  const lines =
    showAll || parsed.lines.length <= RENDER_LIMIT
      ? parsed.lines
      : parsed.lines.slice(0, RENDER_LIMIT);
  const capped = parsed.lines.length - lines.length;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-raised)]",
        className,
      )}
    >
      <div className="group/head flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5">
        <FileCode2 size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">
          {path ?? label ?? "Payload"}
        </span>
        {added > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--stat-added)]">
            +{added}
          </span>
        )}
        {removed > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--stat-removed)]">
            −{removed}
          </span>
        )}
        {/* The *original* text, not the parsed lines: a `Read` result is worth
         *  copying with its line numbers, and a diff with its signs. Stripping
         *  what the block renders would hand back something that was never in
         *  the transcript. */}
        <CopyButton text={text} />
      </div>

      <div className="hide-scrollbar max-h-[420px] overflow-auto py-1">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "relative flex min-w-max font-mono text-[11.5px] leading-[1.6]",
              line.sign === "add" && "bg-[var(--stat-added)]/[0.07]",
              line.sign === "del" && "bg-[var(--stat-removed)]/[0.07]",
            )}
          >
            {/* The 2px marker: at a 7% tint the row colour alone is not reliable
             *  on every display, and which way round a change went is the one
             *  signal that must not be missed. */}
            {line.sign && (
              <span
                aria-hidden
                className={cn(
                  "absolute inset-y-0 left-0 w-[2px]",
                  line.sign === "add" ? "bg-[var(--stat-added)]" : "bg-[var(--stat-removed)]",
                )}
              />
            )}
            {gutter && (
              <span
                aria-hidden
                className="sticky left-0 z-10 w-[52px] shrink-0 select-none bg-[var(--bg-raised)] pr-3 text-right text-[var(--text-ghost)]"
              >
                {line.number ?? (line.sign === "add" ? "+" : line.sign === "del" ? "−" : "")}
              </span>
            )}
            <Code content={line.code} language={lang} colour={colour} />
          </div>
        ))}
        {capped > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex h-8 w-full cursor-pointer items-center justify-center font-mono text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            Show remaining {capped.toLocaleString()} lines
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Copy something, with the confirmation on the button itself.
 *
 * Shared with the timeline rows, which copy a prompt or a response off the same
 * hover affordance. `className` carries the reveal rule, because the hover group
 * differs per host — the block header names its own (`group/head`) so a nested
 * block cannot un-hide its parent's button.
 *
 * `copyText` rather than `navigator.clipboard` directly: WKWebView drops the
 * user activation across an `await`, and the helper falls back to the Rust
 * pasteboard command when it does.
 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(timer);
  }, [done]);

  return (
    <button
      type="button"
      title="Copy"
      aria-label="Copy"
      onClick={() => void copyText(text).then((ok) => setDone(ok))}
      className={cn(
        "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-ghost)] opacity-0 transition-all duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100",
        className ?? "group-hover/head:opacity-100",
      )}
    >
      {done ? (
        <Check size={11} className="text-[var(--capture-live)]" />
      ) : (
        <Copy size={11} strokeWidth={1.7} />
      )}
    </button>
  );
}

/**
 * One line of code, themed.
 *
 * Note the absence of a `.hljs` class — only `.diff-syntax` plus the token
 * classes. That is deliberate and load-bearing; see the module comment.
 */
function Code({
  content,
  language,
  colour,
}: {
  content: string;
  language: string;
  colour: boolean;
}) {
  const tokens = colour ? highlightDiffLine(language, content) : null;
  const base = "min-w-0 flex-1 whitespace-pre px-3 text-[var(--text-secondary)]";
  if (!tokens) return <span className={base}>{content}</span>;
  return (
    <span className={cn("diff-syntax", base)}>
      {tokens.map((t, i) => (
        <span key={i} className={t.cls ?? undefined}>
          {t.text}
        </span>
      ))}
    </span>
  );
}

/**
 * Pretty-print a tool's arguments.
 *
 * They arrive as one line of JSON, which is how a machine sends them and not how
 * anyone reads a nested object — and the interesting field is routinely a shell
 * command buried at the end of it. Indented by **two** spaces, not four: these
 * render in a 340px-narrower column than an editor and every level of nesting
 * is width the value does not get.
 *
 * Non-JSON passes through untouched. Some tools send a bare path or a query, and
 * mangling that to force it into a shape would be worse than leaving it alone.
 */
export function prettyJson(text: string): { text: string; json: boolean } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { text, json: false };
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
  } catch {
    return { text, json: false };
  }
}
