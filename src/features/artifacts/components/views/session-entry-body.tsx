import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { AtlasIcon } from "@/components/brand-marks";
import { extractInjectedContext, type InjectedBlock } from "@/features/chat/lib/atlas-context";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { cn } from "@/lib/utils";

import type { TimelineEntry } from "../../types";
import { RemoteSourceContext } from "../../lib/session-detail-context";
import { compact, type PayloadPart } from "../../lib/session-timeline";
import { observeSize } from "../../lib/shared-resize-observer";
import { CodeBlock, prettyJson } from "../code-block";
import { ShowFull } from "../session-show-full";

/** Height past which a body collapses behind a "Show more". */
const CLAMP_MAX_PX = 340;
/** Slack — a body barely over the limit is not worth a control. */
const CLAMP_SLACK_PX = 60;

export function Clamp({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Still observed rather than read once at mount — a body that arrives late
  // (a spilled payload fetched by `Show full`, markdown resolving off the
  // worker) changes height after the first measurement, and a one-shot read
  // would leave the clamp control missing on exactly the longest bodies.
  //
  // But through the *shared* observer: one instance for the whole timeline
  // rather than one per row. This measured 1098 constructions in a single
  // browsing session, all asking the same question.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeSize(el, (entry) => {
      const height = (entry.target as HTMLElement).scrollHeight;
      // Zero means "not laid out yet", not "empty" — committing that would flip
      // an already-open clamp shut.
      if (height === 0) return;
      setOverflows(height > CLAMP_MAX_PX + CLAMP_SLACK_PX);
    });
  }, []);

  return (
    <div className="relative">
      <div
        ref={ref}
        className="overflow-hidden"
        style={{ maxHeight: expanded || !overflows ? undefined : CLAMP_MAX_PX }}
      >
        {children}
      </div>
      {overflows && !expanded && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
          style={{
            background: "linear-gradient(to bottom, transparent, var(--background))",
          }}
        />
      )}
      {/* Centred and *on* the fade rather than below it. A bare text link under
       *  a gradient sits at whatever contrast the gradient leaves it — which,
       *  over a mono block, was none. The pill brings its own background. */}
      {overflows && (
        <div
          className={cn(
            "flex justify-center",
            expanded ? "mt-2" : "absolute inset-x-0 bottom-0 translate-y-1/2",
          )}
        >
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--secondary-foreground)] shadow-md transition-colors hover:border-border-strong hover:text-[var(--foreground)]"
          >
            <ChevronDown
              size={12}
              className={cn("transition-transform", expanded && "rotate-180")}
            />
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A prompt, with what Atlas contributed to it shown rather than hidden.
 *
 * Atlas injects its own memory into the wire prompt — shared cross-agent
 * memory, retrieved project memory, a recent-session recap — and the agent
 * echoes the whole thing back into its transcript. The chat renderer strips
 * those blocks because there they are scaffolding around something the person
 * typed. Here they are the opposite: the record of what Atlas *knew* going into
 * the turn, which is the one thing a Session transcript can say that a raw
 * agent log cannot. Same parser as the strip, so the two cannot disagree about
 * where a block ends.
 */
export function Prompt({ entry, projectPath }: { entry: TimelineEntry; projectPath: string }) {
  const split = useMemo(() => extractInjectedContext(entry.text ?? ""), [entry.text]);

  // Nothing injected: the common case, and it must stay exactly as cheap as it
  // was — one block, no wrapper.
  if (split.blocks.length === 0) {
    return (
      <Clamp>
        <Block text={entry.text ?? ""} entry={entry} projectPath={projectPath} />
      </Clamp>
    );
  }

  return (
    <>
      {split.prose && (
        <Clamp>
          <Block text={split.prose} entry={entry} projectPath={projectPath} />
        </Clamp>
      )}
      <div className="mt-2 flex flex-col gap-2">
        {split.blocks.map((block, i) => (
          <MemoryBlock key={`${block.label}-${i}`} block={block} />
        ))}
      </div>
    </>
  );
}

/** How each injected label reads once it is a heading rather than a marker. */
const MEMORY_LABELS: Record<string, string> = {
  "SHARED MEMORY": "Shared memory",
  "RELEVANT PROJECT MEMORY": "Project memory",
  "PROJECT MEMORY": "Project memory",
  "RECENT SESSION": "Recent sessions",
};

/**
 * One block of Atlas-supplied context, under the Atlas mark.
 *
 * Folded by default and small: it is provenance, not the conversation. The mark
 * is the point — it says *Atlas* put this in front of the agent, which is
 * otherwise invisible in a transcript that reads as if the agent knew it all
 * along.
 */
function MemoryBlock({ block }: { block: InjectedBlock }) {
  const [open, setOpen] = useState(false);
  const lines = block.body ? block.body.split("\n").length : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-[var(--card)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-element-hover"
      >
        <AtlasIcon size={12} className="shrink-0 rounded-sm" />
        <span className="text-sm text-[var(--secondary-foreground)]">
          {MEMORY_LABELS[block.label] ?? block.label.toLowerCase()}
        </span>
        <span className="font-mono text-xs text-disabled">from Atlas memory</span>
        <span className="flex-1" />
        {lines > 0 && (
          <span className="font-mono text-xs text-disabled">
            {lines} line{lines === 1 ? "" : "s"}
          </span>
        )}
        <ChevronRight
          size={12}
          className={cn("text-border-strong transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="hide-scrollbar max-h-[320px] overflow-auto whitespace-pre-wrap break-words border-t border-border-subtle px-3.5 py-2.5 font-mono text-xs leading-[1.7] text-[var(--muted-foreground)]">
          {block.body || "(empty)"}
        </div>
      )}
    </div>
  );
}

/** A prompt or any verbatim payload: mono, boxed, never re-interpreted. */
function Block({
  text,
  entry,
  projectPath,
}: {
  text: string;
  entry: TimelineEntry;
  projectPath: string;
}) {
  return (
    <div className="mt-2.5 whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-[var(--card)] px-3.5 py-3 font-mono text-sm leading-[1.75] text-[var(--secondary-foreground)]">
      <Body entry={entry} projectPath={projectPath} raw={text} />
    </div>
  );
}

export function Pre({
  label,
  text,
  path,
  json,
  projectPath,
  blobRef,
  rowId,
  part,
}: {
  label: string;
  text: string;
  path?: string | null;
  /** Force JSON: arguments are always an object, whatever they look like. */
  json?: boolean;
  projectPath: string;
  blobRef: string | null;
  rowId: string;
  part: PayloadPart;
}) {
  const remote = useContext(RemoteSourceContext);
  const [full, setFull] = useState<string | null>(null);
  const source = full ?? text;
  const pretty = json ? prettyJson(source) : { text: source, json: false };
  return (
    <div>
      <CodeBlock
        text={pretty.text}
        path={path}
        label={label}
        language={pretty.json ? "JSON" : undefined}
      />
      {(blobRef || remote) && full === null && (
        <ShowFull
          projectPath={projectPath}
          blobRef={blobRef}
          rowId={rowId}
          part={part}
          onLoaded={setFull}
        />
      )}
    </div>
  );
}

/** Message text, with the truncation stated rather than hidden. */
export function Body({
  entry,
  projectPath,
  markdown = false,
  raw,
}: {
  entry: TimelineEntry;
  projectPath: string;
  /** Render through the cached markdown pipeline (responses only — prompts are
   *  verbatim developer input and must not be reinterpreted). */
  markdown?: boolean;
  /** Pre-resolved text, when the caller already has it. */
  raw?: string;
}) {
  const remote = useContext(RemoteSourceContext);
  const [full, setFull] = useState<string | null>(null);
  const truncated = entry.truncated && full === null;

  const notice = truncated && (
    <>
      <span className="ml-1 text-xs text-[var(--muted-foreground)]">
        … {compact(entry.bodyBytes)} bytes not shown
      </span>
      {(entry.bodyRef || remote) && (
        <ShowFull
          projectPath={projectPath}
          blobRef={entry.bodyRef}
          rowId={entry.id}
          part="body"
          onLoaded={setFull}
        />
      )}
    </>
  );

  if (markdown) {
    return (
      <div className="break-words">
        <CachedMarkdown source={full ?? entry.text ?? ""} className="atlas-prose-wrap" />
        {truncated && <p className="-ml-1 mt-1">{notice}</p>}
      </div>
    );
  }

  return (
    <>
      {full ?? raw ?? entry.text}
      {notice}
    </>
  );
}
