import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GitCommitHorizontal,
  Loader2,
  Sparkles,
  TriangleAlert,
  Unlink,
  User,
} from "lucide-react";

import { CachedMarkdown } from "@/lib/markdown-cache";
import { cn } from "@/lib/utils";

import {
  DEFAULT_FILTERS,
  type ArtifactPayload,
  type SessionDetail as Detail,
  type TimelineEntry,
  type TimelineFilters,
} from "../types";
import { AgentBadge, prettyModel } from "./session-list";

/**
 * One Session, as the ordered record of what happened.
 *
 * The layout is a timeline and a rail, because the two things a developer does
 * here are different in kind: *read* the sequence, and *find* one moment in it.
 * The timeline carries a gutter — a continuous line with a glyph node per entry
 * — so the shape of a turn (prompt, thinking, tools, response, commit) is
 * scannable without reading a word.
 *
 * Long Sessions are windowed: the first 300 visible entries render, and more
 * are appended as the scroll approaches the bottom. Deliberately slice-based
 * rather than a virtualizer — entries expand and collapse, so measured-height
 * virtualization would fight the content, and a Session being *read* is
 * scrolled forward, not randomly accessed. Jumping to a Checkpoint extends the
 * window first.
 *
 * Everything shown is already redacted. Scrubbing happened before persistence,
 * so there is no way for this component to leak something the store does not
 * already hold.
 */

/** How many visible entries render before the window has to grow. */
const WINDOW_CHUNK = 300;

/** Distance from the bottom (px) at which the window grows. */
const WINDOW_MARGIN = 600;

interface Props {
  detail: Detail;
  /** Needed to fetch spilled payloads via `artifacts_payload`. */
  projectPath: string;
  /** Opened from a commit: land on that Checkpoint rather than at the top. */
  focusCommitSha?: string;
}

export function SessionDetail({ detail, projectPath, focusCommitSha }: Props) {
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  /** Narrow tool calls to failed ones — the "which calls failed" question. */
  const [failedOnly, setFailedOnly] = useState(false);
  const [expandAllTools, setExpandAllTools] = useState(false);
  const [renderCount, setRenderCount] = useState(WINDOW_CHUNK);
  const entryRefs = useRef(new Map<string, HTMLLIElement>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** A jump target waiting for its entry to be rendered. */
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  /** The entry a jump just landed on, highlighted briefly. */
  const [landed, setLanded] = useState<string | null>(null);
  /** The Checkpoint currently being read, so the rail can say which of N. */
  const [activeCheckpoint, setActiveCheckpoint] = useState<string | null>(null);

  const visible = useMemo(
    () => detail.entries.filter((entry) => passes(entry, filters, failedOnly)),
    [detail.entries, filters, failedOnly],
  );

  const checkpoints = useMemo(
    () => detail.entries.filter((entry) => entry.kind === "checkpoint"),
    [detail.entries],
  );

  const failedCount = useMemo(
    () =>
      detail.entries.filter(
        (entry) => entry.kind === "tool_call" && entry.toolStatus === "failed",
      ).length,
    [detail.entries],
  );

  /** Tool calls per turn, for the quiet meta line under each prompt. Computed
   *  from the unfiltered entries — hiding tool calls must not zero the count. */
  const callsByTurn = useMemo(() => {
    const calls = new Map<number, number>();
    for (const entry of detail.entries) {
      if (entry.kind === "tool_call") {
        calls.set(entry.turnSeq, (calls.get(entry.turnSeq) ?? 0) + 1);
      }
    }
    return calls;
  }, [detail.entries]);

  // A new Session or a filter change restarts the window from the top.
  useEffect(() => {
    setRenderCount(WINDOW_CHUNK);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [detail.summary.id, filters, failedOnly]);

  const rendered = visible.slice(0, renderCount);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (
      renderCount < visible.length &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - WINDOW_MARGIN
    ) {
      setRenderCount((count) => Math.min(count + WINDOW_CHUNK, visible.length));
    }
  }, [renderCount, visible.length]);

  // Jump-to-Checkpoint has to survive both a filter that hides Checkpoints and
  // a window that has not reached the target yet, so it settles over renders:
  // reveal the kind, grow the window, then scroll.
  useEffect(() => {
    if (!pendingJump) return;
    const index = visible.findIndex((entry) => entry.id === pendingJump);
    if (index === -1) {
      setFilters((current) =>
        current.checkpoints ? current : { ...current, checkpoints: true },
      );
      return;
    }
    if (index >= renderCount) {
      setRenderCount(index + 40);
      return;
    }
    const node = entryRefs.current.get(pendingJump);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      // A smooth scroll into the middle of a long conversation leaves no clue
      // which row was the destination. The ring says "this one", then gets out
      // of the way.
      setLanded(pendingJump);
      if (visible[index]?.kind === "checkpoint")
        setActiveCheckpoint(pendingJump);
      setPendingJump(null);
    }
  }, [pendingJump, visible, renderCount]);

  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(null), 2000);
    return () => clearTimeout(timer);
  }, [landed]);

  // Arrived from a commit in the git panel. That commit is the only part of the
  // Session the developer asked about, and a Session can produce several — so
  // opening at the top would land them in the wrong conversation.
  //
  // Honoured once per arrival. A live Session re-reads its entries every poll,
  // and without the guard each one would yank the reader back to the Checkpoint
  // they had already scrolled away from.
  const honouredFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusCommitSha) return;
    const arrival = `${detail.summary.id}:${focusCommitSha}`;
    if (honouredFocus.current === arrival) return;
    const target = detail.entries.find(
      (entry) =>
        entry.kind === "checkpoint" && entry.commitSha === focusCommitSha,
    );
    if (target) {
      honouredFocus.current = arrival;
      setPendingJump(target.id);
    }
  }, [focusCommitSha, detail.summary.id, detail.entries]);

  return (
    <div className="flex h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
      >
        <Header detail={detail} />

        {visible.length === 0 ? (
          <p className="py-10 text-center text-[12px] text-[var(--text-tertiary)]">
            {detail.entries.length === 0
              ? "Nothing was recorded in this session."
              : failedOnly && failedCount === 0
                ? "No tool calls failed in this session."
                : "Every entry is hidden by the current filters."}
          </p>
        ) : (
          <>
            {/* The gutter: a continuous line the glyph nodes sit on. A run of
             *  tool calls in one turn is a cluster — one agent node on the
             *  first call, the rest indented under it with no node of their
             *  own, so the line runs uninterrupted behind them. */}
            <ul className="relative mt-5 before:absolute before:bottom-1 before:left-[11px] before:top-1 before:w-px before:bg-[var(--border-default)]">
              {rendered.map((entry, index) => {
                const prev = index > 0 ? rendered[index - 1] : null;
                const inCluster =
                  entry.kind === "tool_call" &&
                  prev?.kind === "tool_call" &&
                  prev.turnSeq === entry.turnSeq;
                return (
                  <li
                    key={entry.id}
                    className={cn(
                      "relative rounded transition-shadow duration-500",
                      entry.kind === "tool_call" ? "pl-12" : "pl-9",
                      index > 0 && (inCluster ? "mt-1" : "mt-3"),
                      landed === entry.id &&
                        "ring-1 ring-[var(--border-focus)] ring-offset-2 ring-offset-[var(--bg-surface)]",
                    )}
                    ref={(node) => {
                      if (node) entryRefs.current.set(entry.id, node);
                      else entryRefs.current.delete(entry.id);
                    }}
                  >
                    {!inCluster && <GutterNode entry={entry} />}
                    <Entry
                      entry={entry}
                      projectPath={projectPath}
                      expandAllTools={expandAllTools}
                      calls={callsByTurn.get(entry.turnSeq) ?? 0}
                    />
                  </li>
                );
              })}
            </ul>
            {renderCount < visible.length && (
              <button
                type="button"
                onClick={() =>
                  setRenderCount((count) =>
                    Math.min(count + WINDOW_CHUNK, visible.length),
                  )
                }
                className="mt-4 w-full rounded border border-[var(--border-default)] py-1.5 text-[11px] text-[var(--text-tertiary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.99]"
              >
                {visible.length - renderCount} more entries — scroll or click to
                load
              </button>
            )}
          </>
        )}
      </div>

      <Rail
        detail={detail}
        filters={filters}
        onFiltersChange={setFilters}
        failedCount={failedCount}
        failedOnly={failedOnly}
        onFailedOnlyChange={setFailedOnly}
        expandAllTools={expandAllTools}
        onExpandAllToolsChange={setExpandAllTools}
        checkpoints={checkpoints}
        activeCheckpoint={activeCheckpoint}
        onJump={setPendingJump}
      />
    </div>
  );
}

/** The glyph on the gutter line — the entry's kind at a glance. A tool-call
 *  cluster gets one agent node (the Bot) on its first call; the calls
 *  themselves carry their names and failure chips in their own rows. */
function GutterNode({ entry }: { entry: TimelineEntry }) {
  const failed = entry.kind === "tool_call" && entry.toolStatus === "failed";
  const orphaned =
    entry.kind === "checkpoint" && entry.linkState === "orphaned";
  const Icon =
    entry.kind === "prompt"
      ? User
      : entry.kind === "response"
        ? Sparkles
        : entry.kind === "thinking"
          ? Brain
          : entry.kind === "tool_call"
            ? Bot
            : orphaned
              ? Unlink
              : GitCommitHorizontal;
  return (
    <span
      aria-hidden
      className={cn(
        // Solid surface behind the glyph so it interrupts the line.
        "absolute left-0 top-0.5 flex size-[23px] items-center justify-center rounded-full border bg-[var(--bg-surface)]",
        failed
          ? "border-[var(--status-error)] text-[var(--status-error)]"
          : entry.kind === "prompt"
            ? "border-[var(--border-strong)] text-[var(--text-secondary)]"
            : "border-[var(--border-default)] text-[var(--text-tertiary)]",
      )}
    >
      <Icon size={11} />
    </span>
  );
}

/** Title and the one-line fact sheet under it. */
function Header({ detail }: { detail: Detail }) {
  const s = detail.summary;
  const facts = [
    prettyModel(s.model),
    relative(s.updatedAt),
    duration(s.durationSeconds),
    count(s.checkpointCount, "Checkpoint"),
    count(s.filesTouched, "file"),
    s.totalTokens > 0 ? `${compact(s.totalTokens)} tokens` : null,
  ].filter((f): f is string => typeof f === "string" && f.length > 0);

  return (
    <header>
      <h1 className="text-[18px] font-semibold leading-snug tracking-[-0.01em] text-[var(--text-primary)]">
        {s.title ?? "Untitled session"}
      </h1>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--text-tertiary)]">
        {s.agent && (
          <AgentBadge
            agent={s.agent}
            className="block border border-[color-mix(in_srgb,currentColor_25%,transparent)] px-2 text-[11px]"
          />
        )}
        {s.source === "external_jsonl" && (
          <span className="rounded border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
            imported
          </span>
        )}
        {facts.map((fact, i) => (
          <span key={fact}>
            {i > 0 && <span className="pr-2">·</span>}
            {fact}
          </span>
        ))}
        {(s.insertions > 0 || s.deletions > 0) && (
          <span className="font-mono">
            {facts.length > 0 && <span className="pr-2 font-sans">·</span>}
            {s.insertions > 0 && (
              <span className="text-[var(--stat-added)]">+{s.insertions}</span>
            )}
            {s.insertions > 0 && s.deletions > 0 && " / "}
            {s.deletions > 0 && (
              <span className="text-[var(--stat-removed)]">-{s.deletions}</span>
            )}
          </span>
        )}
      </div>

      {/* The record has a hole and says so at the top of the record, not in a
       *  log nobody reads. */}
      {s.needsAttention && (
        <p className="mt-2 flex items-start gap-1.5 rounded bg-[var(--status-warning-muted)] px-2 py-1.5 text-[11px] text-[var(--status-warning)]">
          <TriangleAlert size={12} className="mt-px shrink-0" />
          <span>
            {s.attentionReason ?? "Part of this session could not be recorded."}{" "}
            Content that could not be scrubbed was not stored.
          </span>
        </p>
      )}
    </header>
  );
}

function Entry({
  entry,
  projectPath,
  expandAllTools,
  calls,
}: {
  entry: TimelineEntry;
  projectPath: string;
  expandAllTools: boolean;
  /** Tool calls in this entry's turn, for the meta line under a prompt. */
  calls: number;
}) {
  switch (entry.kind) {
    case "prompt":
      return <Prompt entry={entry} projectPath={projectPath} calls={calls} />;
    case "response":
      return <Response entry={entry} projectPath={projectPath} />;
    case "thinking":
      return <Thinking entry={entry} projectPath={projectPath} />;
    case "tool_call":
      return (
        <ToolCall
          entry={entry}
          projectPath={projectPath}
          expandAll={expandAllTools}
        />
      );
    case "checkpoint":
      return <Checkpoint entry={entry} />;
  }
}

/** Roughly fourteen 13px lines. Anything taller clamps behind a fade. */
const CLAMP_MAX_PX = 340;
/** Slack so a body a couple of lines over the limit doesn't earn a toggle. */
const CLAMP_SLACK_PX = 60;

/**
 * Long bodies render clamped with a bottom fade and an explicit toggle.
 *
 * A single pasted prompt can be hundreds of lines, and the timeline exists to
 * read the *sequence* — any one body is expandable in place. Expansion is
 * instant by design: there is no height animation, so `prefers-reduced-motion`
 * has nothing to fight. Measured with a ResizeObserver rather than a line
 * count, because "Show full" can swell a body after mount.
 */
function Clamp({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => {
      const next = el.offsetHeight > CLAMP_MAX_PX + CLAMP_SLACK_PX;
      setOverflows((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const clamped = overflows && !expanded;

  return (
    <div>
      <div
        className={cn(
          clamped &&
            "max-h-[340px] overflow-hidden [-webkit-mask-image:linear-gradient(to_bottom,black_calc(100%-56px),transparent)] [mask-image:linear-gradient(to_bottom,black_calc(100%-56px),transparent)]",
        )}
      >
        <div ref={innerRef}>{children}</div>
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 flex items-center gap-1 rounded text-[11px] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.98]"
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** What the developer asked. Boxed, because it is the anchor of a turn — with
 *  the turn's measurements (when, how many tool calls it triggered) as a quiet
 *  meta line under the box rather than furniture inside it. */
function Prompt({
  entry,
  projectPath,
  calls,
}: {
  entry: TimelineEntry;
  projectPath: string;
  calls: number;
}) {
  const meta = [
    relative(entry.at),
    calls > 0 ? `${calls} call${calls === 1 ? "" : "s"}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2.5">
        <Clamp>
          <Body
            entry={entry}
            projectPath={projectPath}
            className="text-[13px] text-[var(--text-primary)]"
          />
        </Clamp>
      </div>
      {meta && (
        <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">{meta}</p>
      )}
    </div>
  );
}

/** What the agent said back. Unboxed, so the conversation reads as prose —
 *  and through the app's cached markdown renderer, so code fences and lists
 *  in agent output stop reading as prose soup. */
function Response({
  entry,
  projectPath,
}: {
  entry: TimelineEntry;
  projectPath: string;
}) {
  return (
    <div className="py-0.5">
      <Clamp>
        <Body
          entry={entry}
          projectPath={projectPath}
          markdown
          className="text-[13px] text-[var(--text-secondary)]"
        />
      </Clamp>
    </div>
  );
}

/**
 * Agent reasoning.
 *
 * Collapsed and dimmed: it is the bulk of the bytes in a Session and is almost
 * never what someone opened the timeline to read — but throwing it away would
 * lose the only record of *why* the agent did what it did.
 */
function Thinking({
  entry,
  projectPath,
}: {
  entry: TimelineEntry;
  projectPath: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text-secondary)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.98]"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Thinking
      </button>
      {open && (
        <Body
          entry={entry}
          projectPath={projectPath}
          className="mt-1 border-l border-[var(--border-default)] pl-3 text-[12px] text-[var(--text-muted)]"
        />
      )}
    </div>
  );
}

/**
 * One tool invocation: name, target, and the arguments and result on demand.
 *
 * Collapsed by default because a Session has far more tool calls than messages,
 * and expanding all of them by default turns the timeline into a log dump — the
 * rail's "Expand all tool calls" is the explicit opt-in.
 */
function ToolCall({
  entry,
  projectPath,
  expandAll,
}: {
  entry: TimelineEntry;
  projectPath: string;
  expandAll: boolean;
}) {
  const [open, setOpen] = useState(expandAll);
  // The rail toggle overrides local state in both directions; a later manual
  // click takes over again until the toggle next changes.
  useEffect(() => {
    setOpen(expandAll);
  }, [expandAll]);

  const target = entry.paths[0] ?? entry.toolTitle ?? "";
  const failed = entry.toolStatus === "failed";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded px-1 py-0.5 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:bg-[var(--bg-active)]"
      >
        <span
          className={cn(
            "w-[64px] shrink-0 font-mono text-[11px]",
            failed ? "text-[var(--status-error)]" : "text-[var(--status-info)]",
          )}
        >
          {entry.toolName ?? "tool"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">
          {target}
        </span>
        {failed && (
          <span className="shrink-0 rounded bg-[var(--status-error-muted)] px-1.5 py-px text-[10px] text-[var(--status-error)]">
            failed
          </span>
        )}
        {entry.paths.length > 1 && (
          <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
            +{entry.paths.length - 1}
          </span>
        )}
        {open ? (
          <ChevronDown
            size={12}
            className="shrink-0 text-[var(--text-tertiary)]"
          />
        ) : (
          <ChevronRight
            size={12}
            className="shrink-0 text-[var(--text-tertiary)]"
          />
        )}
      </button>

      {open && (
        <div className="mt-1 space-y-1.5 border-l border-[var(--border-default)] pl-3">
          {entry.paths.length > 1 && (
            <Block label="Files" text={entry.paths.join("\n")} />
          )}
          {entry.arguments && (
            <Block
              label="Arguments"
              text={entry.arguments}
              projectPath={projectPath}
              blobRef={spilledRef(entry.argumentsRef, entry.arguments)}
            />
          )}
          {entry.resultBinary ? (
            <p className="text-[11px] text-[var(--text-tertiary)]">
              The result was binary and is not shown.
            </p>
          ) : (
            entry.result && (
              <Block
                label="Result"
                text={entry.result}
                projectPath={projectPath}
                blobRef={spilledRef(entry.resultRef, entry.result)}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Is this field's inline text a preview with the real payload spilled to a
 * blob? A spilled-but-small payload is already inlined in full, so the ref
 * alone is not enough — a full inline is ~64 KB where a preview is ~2 KB.
 */
function spilledRef(ref: string | null, inline: string | null): string | null {
  if (!ref) return null;
  return (inline?.length ?? 0) <= 4096 ? ref : null;
}

function Block({
  label,
  text,
  projectPath,
  blobRef,
}: {
  label: string;
  text: string;
  projectPath?: string;
  /** When set, the text is a preview and the full payload is on disk. */
  blobRef?: string | null;
}) {
  const [full, setFull] = useState<string | null>(null);
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
        {label}
      </p>
      <pre className="mt-0.5 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg-raised)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-secondary)]">
        {full ?? text}
      </pre>
      {blobRef && projectPath && full === null && (
        <ShowFull
          projectPath={projectPath}
          blobRef={blobRef}
          onLoaded={setFull}
        />
      )}
    </div>
  );
}

/**
 * A commit this Session produced.
 *
 * Rendered as a *boundary*, not as another row in the stream. A Checkpoint is
 * literally the slice of a Session whose work landed in one commit, so in a
 * Session that produced several it is the only thing marking where one piece of
 * work ends and the next begins. As a peer row it read as an aside; the rule and
 * the caption make the timeline chunk into "work → landed in X → work".
 */
function Checkpoint({ entry }: { entry: TimelineEntry }) {
  const orphaned = entry.linkState === "orphaned";
  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[9px] uppercase tracking-wider text-[var(--text-ghost)]">
          {orphaned ? "Landed in — since rewritten" : "Landed in"}
        </span>
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border px-3 py-2",
          orphaned
            ? "border-dashed border-[var(--border-strong)]"
            : "border-[var(--border-default)] bg-[var(--bg-raised)]",
        )}
      >
        <span className="shrink-0 font-mono text-[11px] text-[var(--text-tertiary)]">
          {entry.commitSha?.slice(0, 7)}
        </span>

        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            orphaned
              ? "text-[var(--text-secondary)]"
              : "text-[var(--text-primary)]",
          )}
        >
          {entry.commitSubject ?? (
            // The Checkpoint is a real record even when git can no longer resolve
            // it — a moved repository or a pruned commit must not erase it.
            <span className="text-[var(--text-tertiary)]">
              {orphaned ? "Commit no longer reachable" : "Subject unavailable"}
            </span>
          )}
        </span>

        {/* A squash or a conflict-resolved rebase leaves the subject and the diff
         *  stat intact, so without saying so outright an orphaned Checkpoint reads
         *  exactly like a live one — the "wrong link" this whole subsystem exists
         *  to avoid. The state is named on the row, not inferred from a border. */}
        {orphaned && (
          <span
            className="shrink-0 rounded bg-[var(--status-warning-muted)] px-1.5 py-px text-[10px] text-[var(--status-warning)]"
            title="This commit is no longer in history — rewritten or squashed. The Session record is kept."
          >
            orphaned
          </span>
        )}

        {/* Suppressed when orphaned: the branch no longer contains this commit,
         *  so showing it would assert exactly the link that was lost. */}
        {entry.branch && !orphaned && (
          <span className="hidden shrink-0 font-mono text-[10px] text-[var(--text-tertiary)] md:block">
            {entry.branch}
          </span>
        )}

        {(entry.insertions > 0 || entry.deletions > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            {entry.insertions > 0 && (
              <span className="text-[var(--stat-added)]">
                +{entry.insertions}
              </span>
            )}
            {entry.insertions > 0 && entry.deletions > 0 && (
              <span className="text-[var(--text-ghost)]"> / </span>
            )}
            {entry.deletions > 0 && (
              <span className="text-[var(--stat-removed)]">
                -{entry.deletions}
              </span>
            )}
          </span>
        )}
      </div>
    </>
  );
}

/** Message text, with the truncation stated rather than hidden — and the rest
 *  fetchable, now that the store hands out the blob key. */
function Body({
  entry,
  projectPath,
  className,
  markdown = false,
}: {
  entry: TimelineEntry;
  projectPath: string;
  className?: string;
  /** Render through the cached markdown pipeline (responses only — prompts
   *  are verbatim developer input and must not be reinterpreted). */
  markdown?: boolean;
}) {
  const [full, setFull] = useState<string | null>(null);
  const truncated = entry.truncated && full === null;

  const notice = truncated && (
    <>
      <span className="ml-1 text-[11px] text-[var(--text-tertiary)]">
        … {compact(entry.bodyBytes)} bytes not shown
      </span>
      {entry.bodyRef && (
        <ShowFull
          projectPath={projectPath}
          blobRef={entry.bodyRef}
          onLoaded={setFull}
        />
      )}
    </>
  );

  if (markdown) {
    return (
      <div className="break-words">
        <CachedMarkdown
          source={full ?? entry.text ?? ""}
          className={className}
        />
        {truncated && <p className="mt-1 -ml-1">{notice}</p>}
      </div>
    );
  }

  return (
    <div className={cn("whitespace-pre-wrap break-words", className)}>
      {full ?? entry.text}
      {notice}
    </div>
  );
}

/**
 * Fetch a spilled payload on demand.
 *
 * The failure copy matters: a pruned blob store is a real state (the Session
 * still renders from previews) and "could not load" must not read as a crash.
 */
function ShowFull({
  projectPath,
  blobRef,
  onLoaded,
}: {
  projectPath: string;
  blobRef: string;
  onLoaded: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFull = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await invoke<ArtifactPayload>("artifacts_payload", {
        projectPath,
        blobRef,
      });
      if (payload.text !== null) onLoaded(payload.text);
      else setError("The full payload is binary and cannot be shown.");
    } catch {
      setError("The full payload is no longer on disk.");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <span className="ml-1.5 text-[11px] text-[var(--text-tertiary)]">
        {error}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void fetchFull()}
      className="ml-1.5 inline-flex items-center gap-1 rounded text-[11px] text-[var(--text-secondary)] underline underline-offset-2 transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:scale-[0.98] disabled:opacity-60"
    >
      {busy && <Loader2 size={10} className="animate-spin" />}
      Show full
    </button>
  );
}

/** Jump-to, filters, and view options. */
function Rail({
  detail,
  filters,
  onFiltersChange,
  failedCount,
  failedOnly,
  onFailedOnlyChange,
  expandAllTools,
  onExpandAllToolsChange,
  checkpoints,
  activeCheckpoint,
  onJump,
}: {
  detail: Detail;
  filters: TimelineFilters;
  onFiltersChange: (next: TimelineFilters) => void;
  failedCount: number;
  failedOnly: boolean;
  onFailedOnlyChange: (value: boolean) => void;
  expandAllTools: boolean;
  onExpandAllToolsChange: (value: boolean) => void;
  checkpoints: TimelineEntry[];
  activeCheckpoint: string | null;
  onJump: (id: string) => void;
}) {
  const set = (key: keyof TimelineFilters) => (value: boolean) =>
    onFiltersChange({ ...filters, [key]: value });

  return (
    <aside className="w-[240px] shrink-0 overflow-y-auto border-l border-[var(--border-default)] px-4 py-4">
      {checkpoints.length > 0 ? (
        <JumpTo
          checkpoints={checkpoints}
          activeId={activeCheckpoint}
          onJump={onJump}
        />
      ) : (
        /* Zero is a fact worth one quiet sentence, not an empty rail — the
         * difference between "imported, so never linked" and "nothing was
         * linked" is exactly what someone staring at zero wants to know. */
        <p className="mb-5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          {detail.summary.source === "external_jsonl"
            ? "Imported session — commits aren't linked to imported history."
            : "No commits were linked to this session."}
        </p>
      )}

      <section>
        <h3 className="pb-1.5 text-[11px] font-medium text-[var(--text-primary)]">
          Filters
        </h3>
        <Toggle
          label="Prompts"
          count={detail.counts.prompts}
          checked={filters.prompts}
          onChange={set("prompts")}
        />
        <Toggle
          label="Responses"
          count={detail.counts.responses}
          checked={filters.responses}
          onChange={set("responses")}
        />
        <Toggle
          label="Thinking"
          count={detail.counts.thinking}
          checked={filters.thinking}
          onChange={set("thinking")}
        />
        <Toggle
          label="Checkpoints"
          count={detail.counts.checkpoints}
          checked={filters.checkpoints}
          onChange={set("checkpoints")}
        />
        <Toggle
          label="Tool calls"
          count={detail.counts.toolCalls}
          checked={filters.toolCalls}
          onChange={set("toolCalls")}
        />

        {/* Failed is a facet of tool calls, in the error tone because it is the
         *  one row here that reports a problem rather than a kind. */}
        {failedCount > 0 && (
          <label
            className={cn(
              "ml-6 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors duration-150 hover:bg-[var(--bg-hover)]",
              !filters.toolCalls && "opacity-45",
            )}
          >
            <input
              type="checkbox"
              checked={failedOnly}
              disabled={!filters.toolCalls}
              onChange={(e) => onFailedOnlyChange(e.target.checked)}
              className="size-3 accent-[var(--status-error)]"
            />
            <span className="flex-1 text-[12px] text-[var(--status-error)]">
              Failed
            </span>
            <span className="text-[11px] text-[var(--status-error)]">
              {failedCount}
            </span>
          </label>
        )}

        {/* Per-tool totals, indented under the toggle they belong to. Read-only:
         *  filtering to a single tool is a narrower question than this surface
         *  is for, and a row of eleven checkboxes would bury the five above. */}
        {filters.toolCalls && detail.tools.length > 0 && (
          <ul className="mt-0.5 space-y-0.5 pl-6">
            {detail.tools.map((tool) => (
              <li
                key={tool.toolName}
                className="flex items-baseline justify-between text-[11px] text-[var(--text-tertiary)]"
              >
                <span className="font-mono">{tool.toolName}</span>
                <span>{tool.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5">
        <h3 className="pb-1.5 text-[11px] font-medium text-[var(--text-primary)]">
          View
        </h3>
        <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors duration-150 hover:bg-[var(--bg-hover)]">
          <input
            type="checkbox"
            checked={expandAllTools}
            onChange={(e) => onExpandAllToolsChange(e.target.checked)}
            className="size-3 accent-[var(--accent-primary)]"
          />
          <span className="flex-1 text-[12px] text-[var(--text-secondary)]">
            Expand all tool calls
          </span>
        </label>
      </section>
    </aside>
  );
}

/**
 * The rail's Checkpoints, as an ordered "Jump to" list.
 *
 * Collapsed at one Checkpoint, where the list would just restate what the
 * timeline already shows. Open by default past that: a Session that produced
 * several commits is the case where the timeline stops being self-evident, and
 * the ordered list is the only place that says how many there were, in what
 * order, and which one is being read. Numbering matters for the same reason —
 * "2 of 3" is the orienting fact, and a bare list of subjects does not carry it.
 *
 * The jump goes through the same pending-jump mechanism the timeline settles
 * over renders (filter reveal, window growth, scroll).
 */
function JumpTo({
  checkpoints,
  activeId,
  onJump,
}: {
  checkpoints: TimelineEntry[];
  activeId: string | null;
  onJump: (id: string) => void;
}) {
  const [open, setOpen] = useState(checkpoints.length > 1);
  const activeIndex = checkpoints.findIndex((c) => c.id === activeId);

  return (
    <section className="mb-5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded border border-[var(--border-default)] px-2 py-1.5 transition-colors duration-150 hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:bg-[var(--bg-active)]"
      >
        <span className="text-[11px] font-medium text-[var(--text-primary)]">
          Jump to
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
          {activeIndex >= 0 && checkpoints.length > 1
            ? `${activeIndex + 1} of ${checkpoints.length}`
            : `${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"}`}
          <ChevronDown
            size={11}
            className={cn(
              "transition-transform duration-150 ease-out",
              open && "rotate-180",
            )}
          />
        </span>
      </button>

      {open && (
        <ul className="mt-1 max-h-[240px] overflow-y-auto rounded border border-[var(--border-default)] bg-[var(--bg-raised)] p-0.5">
          {checkpoints.map((checkpoint, index) => {
            const meta = [
              checkpoint.commitSha?.slice(0, 7) ?? null,
              checkpoint.files.length > 0
                ? `${checkpoint.files.length} file${checkpoint.files.length === 1 ? "" : "s"}`
                : null,
              // Same reason as the row itself: an orphaned Checkpoint keeps its
              // subject, so the jump list must say so rather than let it pass
              // for a commit that is still in history.
              checkpoint.linkState === "orphaned" ? "orphaned" : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ");
            const active = checkpoint.id === activeId;
            return (
              <li key={checkpoint.id}>
                <button
                  type="button"
                  // Deliberately does not close the list: stepping through a
                  // Session's commits in order is the whole point, and a list
                  // that closes on every pick makes that four clicks per step.
                  onClick={() => onJump(checkpoint.id)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full items-start gap-1.5 rounded px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:bg-[var(--bg-active)]",
                    active && "bg-[var(--bg-active)]",
                  )}
                >
                  <span
                    className={cn(
                      "mt-px w-3 shrink-0 text-right font-mono text-[10px] tabular-nums",
                      active
                        ? "text-[var(--text-secondary)]"
                        : "text-[var(--text-ghost)]",
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-[var(--text-primary)]">
                      {checkpoint.commitSubject ??
                        (checkpoint.linkState === "orphaned"
                          ? "Commit no longer reachable"
                          : "Subject unavailable")}
                    </span>
                    {meta && (
                      <span className="mt-0.5 block font-mono text-[10px] text-[var(--text-tertiary)]">
                        {meta}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Toggle({
  label,
  count,
  checked,
  onChange,
}: {
  label: string;
  count: number;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors duration-150 hover:bg-[var(--bg-hover)]",
        count === 0 && "opacity-45",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3 accent-[var(--accent-primary)]"
      />
      <span className="flex-1 text-[12px] text-[var(--text-secondary)]">
        {label}
      </span>
      <span className="text-[11px] text-[var(--text-tertiary)]">{count}</span>
    </label>
  );
}

function passes(
  entry: TimelineEntry,
  filters: TimelineFilters,
  failedOnly: boolean,
): boolean {
  switch (entry.kind) {
    case "prompt":
      return filters.prompts;
    case "response":
      return filters.responses;
    case "thinking":
      return filters.thinking;
    case "tool_call":
      return (
        filters.toolCalls && (!failedOnly || entry.toolStatus === "failed")
      );
    case "checkpoint":
      return filters.checkpoints;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

function count(n: number, noun: string): string | null {
  return n > 0 ? `${n} ${noun}${n === 1 ? "" : "s"}` : null;
}

function duration(seconds: number): string | null {
  if (seconds < 60) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}min`;
}

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString();
}
