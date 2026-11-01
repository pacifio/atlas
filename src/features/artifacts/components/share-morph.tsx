/**
 * Share this Session — the round button at the foot of the reader that grows
 * into a sheet.
 *
 * The growth is CSS (`.t-morph` in `globals.css`), not `motion`: the whole
 * animation is three properties on one box with `overflow: hidden` clipping
 * its contents, which is what makes it read as one object changing shape
 * rather than a panel appearing over a button. `motion` is used only for the
 * contents arriving, which is a different question.
 *
 * Two ways to hand a Session on, and the segmented control at the top is the
 * choice between them:
 *
 *   Atlas org   the in-app address. Anyone in the Organisation can open it;
 *               nobody else can, and nothing is published.
 *   Anyone      a public link on an unguessable slug. This is a DISCLOSURE,
 *               so it is never on by default and the sheet says plainly what
 *               it does before the button that does it.
 *
 * Ported from the web reader, with two deliberate differences. The web draws
 * the sheet in the opposite theme, which needs `data-theme` scoping this app
 * does not have, so it sits on `--popover` like every other menu here. And
 * the web's "Markdown" target downloads a blob; this one goes through the
 * same export path as the header's Export, which writes a real file.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Code, FileDown, Link2, Mail, Paperclip, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useControllableOpen } from "@/lib/use-controllable-open";
import { SPRING_PILL } from "@/lib/motion";
import { motion } from "motion/react";
import type { SessionDetail as Detail } from "../types";
import { sessionTitle } from "../lib/board";
import { authorOf, type AuthorDirectory } from "../lib/author-directory";
import { exportSession } from "../lib/export";
import { shares, type ArtifactShare } from "../lib/shares-api";

type Access = "org" | "link";

/** Where each orbiting face sits, as a % of the stage, and how it bobs. */
const ORBIT = [
  { x: 15, y: 56, d: 0 },
  { x: 16, y: 22, d: 0.6 },
  { x: 85, y: 24, d: 1.2 },
  { x: 86, y: 60, d: 1.8 },
];

export function ShareMorph({
  detail,
  projectId,
  directory,
  authorId = null,
  open: openProp,
  onOpenChange,
  anchorY = "bottom",
  anchorX = "start",
  inPill = false,
}: {
  detail: Detail;
  /** The server Project, or `null` when this Session is local-only — there is
   *  nothing to link to then, and the sheet says so. */
  projectId: string | null;
  directory: AuthorDirectory;
  /** Whose Session it is; `null` means your own. */
  authorId?: string | null;
  /** Owns the open state when given (the overview's Session card opens this
   *  from its own button); otherwise the morph keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Which edge the closed button sits on and the panel grows away from.
   *  "bottom" (default) grows up out of a footer; "top" grows down. */
  anchorY?: "top" | "bottom";
  /** Which side the button sits on. "start" (default) grows right. */
  anchorX?: "start" | "end";
  /** Closed, it is a button in the reader's footer pill (`footer-pill.tsx`). */
  inPill?: boolean;
}) {
  const s = detail.summary;
  const title = sessionTitle(s.title) ?? "Untitled session";
  const [open, setOpen] = useControllableOpen(openProp, onOpenChange);
  const [access, setAccess] = useState<Access>("org");
  const [share, setShare] = useState<ArtifactShare | null>(null);
  const [orgUrl, setOrgUrl] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [guestComments, setGuestComments] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  // The sheet's height is its content's, measured — the public half appears
  // and disappears, so a fixed height would be wrong in one state or the
  // other. The menu's padding and border sit outside the measure.
  useEffect(() => {
    const el = measure.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContentHeight(el.offsetHeight));
    ro.observe(el);
    setContentHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [open]);

  /**
   * Which Session's links have been read, so the round trip happens once.
   *
   * A REF, not the `status` state. With `status` in this effect's deps, its
   * own `setStatus("loading")` re-ran the effect, whose cleanup cancelled the
   * fetch the first run had just started — so the result was thrown away and
   * the sheet sat on "Checking for a public link…" for ever. An effect must
   * not list state it sets itself.
   */
  const loadedFor = useRef<string | null>(null);

  // Read the Session's link the first time the sheet opens, not on mount:
  // this is a network round trip per Session and most are never shared.
  useEffect(() => {
    if (!open) return;
    const key = `${projectId ?? ""}\u0000${s.id}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;

    if (!projectId) {
      setStatus("ready");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    void (async () => {
      try {
        const [existing, org] = await Promise.all([
          shares.forSession(projectId, s.id),
          shares.orgUrl(projectId, s.id),
        ]);
        if (cancelled) return;
        setShare(existing);
        setOrgUrl(org ?? "");
        if (existing) {
          setPublicUrl(await shares.url(existing.slug));
          setAccess("link");
        }
        setStatus("ready");
      } catch {
        // A refusal is an answer: say so rather than spinning. The sheet's
        // Markdown export still works with no link at all.
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, s.id]);

  // Dismiss on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const url = access === "org" ? orgUrl : publicUrl;
  const isPublic = access === "link" && share !== null;

  const run = useCallback(async (write: () => Promise<unknown>, what: string) => {
    setBusy(true);
    try {
      await write();
    } catch (error) {
      toast.error(`Could not ${what}`, {
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const createLink = () =>
    run(async () => {
      if (!projectId) return;
      const made = await shares.create(projectId, s.id, guestComments);
      setShare(made);
      setPublicUrl(await shares.url(made.slug));
    }, "create the link");

  const revokeLink = () =>
    run(async () => {
      if (!projectId || !share) return;
      await shares.revoke(projectId, share.id);
      setShare(null);
      setPublicUrl("");
    }, "stop sharing");

  const copy = async () => {
    if (!url) return;
    await copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  /** The targets. Markdown is the one that works with no link at all. */
  const send = (target: "email" | "github" | "x" | "markdown" | "embed") => {
    if (target === "markdown") {
      void exportSession(detail, "md");
      return;
    }
    if (!url) return;
    if (target === "email") {
      void openUrl(
        `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`,
      ).catch(() => toast.error("Could not open your mail app."));
    } else if (target === "github") {
      void copyText(`[${title.replace(/[[\]]/g, "")}](${url})`);
      toast.success("Markdown link copied — paste it into an issue or PR");
    } else if (target === "x") {
      void openUrl(
        `https://x.com/intent/post?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`,
      ).catch(() => toast.error("Could not open your browser."));
    } else if (target === "embed") {
      void copyText(
        `<iframe src="${url}" width="100%" height="640" style="border:0" title="${title.replace(/"/g, "&quot;")}" loading="lazy"></iframe>`,
      );
      toast.success("Embed code copied");
    }
  };

  // Whose Session this is. `SessionDetail.summary` is a bare summary with no
  // author id on it — that lives on the board row — so the caller passes it.
  const author = authorOf(authorId, directory);

  return (
    <div
      ref={root}
      className={cn(
        "relative z-10",
        inPill && "size-7 shrink-0 [--morph-closed:1.75rem] [--morph-r-closed:0.875rem]",
      )}
    >
      <div
        data-open={open}
        data-anchor={anchorX}
        data-anchor-y={anchorY}
        className={cn(
          "t-morph border border-[var(--border)] bg-[var(--popover)]/85 shadow-md backdrop-blur-xl",
          "data-[open=true]:shadow-lg",
          // In a footer pill (`footer-pill.tsx`) the closed box IS one of the
          // pill's buttons: the pill's size, no chrome of its own, the pill's
          // hover. It takes the panel's chrome as it opens, and sits absolute
          // in its slot so growing covers the pill rather than pushing it —
          // `!` because `.t-morph`'s own `position: relative` is unlayered
          // CSS (globals.css) and outranks any utility.
          inPill &&
            "absolute! bottom-0 data-[open=false]:border-transparent data-[open=false]:bg-transparent data-[open=false]:shadow-none data-[open=false]:backdrop-blur-none data-[open=false]:hover:bg-element-hover",
          inPill && (anchorX === "start" ? "left-0" : "right-0"),
          "[--morph-open-w:min(22rem,calc(100cqw-2rem))]",
        )}
        style={
          {
            "--morph-open-h": `min(calc(${Math.ceil(contentHeight)}px + 1rem + 2px), calc(100svh - 10rem))`,
          } as React.CSSProperties
        }
      >
        {/* The panel's own fill, in the OTHER appearance — white over a dark
            session, dark over a light one — so it reads as a layer laid over
            the record rather than as more of it. Its own `aria-hidden` div so
            the round button does not flash at the panel's colour halfway
            through the morph. */}
        <div aria-hidden data-theme-invert className="t-morph-surface bg-[var(--popover)]" />

        <div
          data-theme-invert
          role="dialog"
          aria-label="Share session"
          inert={!open}
          className="t-morph-menu hide-scrollbar flex flex-col gap-3.5 overflow-y-auto p-2 text-foreground"
        >
          <div ref={measure} className="flex flex-col gap-3.5">
            <div className="relative">
              <Stage open={open} title={title} detail={detail} author={author} />
              <button
                type="button"
                aria-label="Close share"
                onClick={() => setOpen(false)}
                className="absolute top-4 right-4 flex size-7 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity duration-fast hover:opacity-80"
              >
                <X size={13} />
              </button>
            </div>

            <div className="flex flex-col gap-3 px-2">
              {projectId && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-secondary-foreground">Who can open it</span>
                  <Segmented
                    value={access}
                    onChange={setAccess}
                    options={[
                      { value: "org", label: "Atlas org" },
                      { value: "link", label: "Anyone" },
                    ]}
                  />
                </div>
              )}

              {access === "link" && projectId && (
                <PublicLink
                  status={status}
                  share={share}
                  busy={busy}
                  guestComments={guestComments}
                  onGuestComments={setGuestComments}
                  onCreate={createLink}
                  onRevoke={revokeLink}
                />
              )}

              {!projectId && (
                <p className="rounded-lg bg-foreground/5 px-3 py-2 text-2xs text-muted-foreground">
                  This Session is only on this machine. Sync its Project to share it.
                </p>
              )}

              <div className="flex flex-col gap-2">
                <span className="text-xs text-secondary-foreground">Share to</span>
                <ul className="grid grid-cols-5 gap-1">
                  {TARGETS.map((t, i) => {
                    const disabled = t.id !== "markdown" && (!url || (t.publicOnly && !isPublic));
                    return (
                      <motion.li
                        key={t.id}
                        initial={false}
                        animate={open ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
                        transition={{ ...SPRING_PILL, delay: open ? 0.18 + i * 0.035 : 0 }}
                      >
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => send(t.id)}
                          title={disabled && t.publicOnly ? "Needs a public link" : undefined}
                          className="group/target flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-xl text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <span className="flex size-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-foreground transition-[translate,background-color] duration-fast group-enabled/target:group-hover/target:-translate-y-0.5 group-enabled/target:group-hover/target:bg-element-hover">
                            <t.Mark size={16} />
                          </span>
                          <span className="text-3xs transition-colors duration-fast group-enabled/target:group-hover/target:text-foreground">
                            {t.label}
                          </span>
                        </button>
                      </motion.li>
                    );
                  })}
                </ul>
              </div>

              <div className="flex h-9 items-center gap-2 rounded-full border border-border-strong bg-[var(--card)] pr-1 pl-3">
                <Link2 size={13} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-secondary-foreground">
                  {url ? url.replace(/^https?:\/\//, "") : "No link yet"}
                </span>
                <button
                  type="button"
                  onClick={() => void copy()}
                  disabled={!url}
                  className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-3 text-2xs font-medium text-background transition-opacity duration-fast hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copied ? <Check size={11} /> : <Link2 size={11} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          aria-label="Share session"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          // `-left-px -bottom-px`: positioned children sit inside the box's
          // 1px border, so without this the glyph hangs off-centre.
          className="t-morph-trigger -bottom-px -left-px flex cursor-pointer items-center justify-center text-muted-foreground transition-colors duration-fast hover:text-foreground"
        >
          <Upload size={14} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}

/** The two brand marks, inline. `lucide-react` v1 dropped its brand icons,
 *  and a wrong-but-present glyph reads as a different product. */
function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M12 .5a12 12 0 0 0-3.79 23.4c.6.1.82-.26.82-.58v-2.2c-3.34.72-4.04-1.6-4.04-1.6-.55-1.4-1.34-1.77-1.34-1.77-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.003 0c2.29-1.55 3.3-1.23 3.3-1.23.64 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.69.83.57A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

function XMark({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M18.9 2H22l-7.1 8.1L23.2 22h-6.6l-5.1-6.7L5.6 22H2.5l7.6-8.7L1.1 2h6.8l4.6 6.1L18.9 2Zm-1.1 18h1.7L7.3 3.7H5.5L17.8 20Z" />
    </svg>
  );
}

const TARGETS = [
  {
    id: "email",
    label: "Email",
    Mark: ({ size }: { size: number }) => <Mail size={size} strokeWidth={1.6} />,
    publicOnly: false,
  },
  { id: "github", label: "GitHub", Mark: GitHubMark, publicOnly: false },
  { id: "x", label: "X", Mark: XMark, publicOnly: true },
  {
    id: "markdown",
    label: "Markdown",
    Mark: ({ size }: { size: number }) => <FileDown size={size} strokeWidth={1.6} />,
    publicOnly: false,
  },
  {
    id: "embed",
    label: "Embed",
    Mark: ({ size }: { size: number }) => <Code size={size} strokeWidth={1.6} />,
    publicOnly: true,
  },
] as const;

/** The two-option track. A sliding thumb would need a layout animation for
 *  two states; a filled segment says the same thing and cannot drift. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      role="tablist"
      className="flex w-fit items-center gap-0.5 rounded-full bg-foreground/8 p-0.5 ring-1 ring-foreground/15"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-5.5 shrink-0 cursor-pointer rounded-full px-2.5 text-2xs font-medium whitespace-nowrap transition-colors duration-fast",
            o.value === value
              ? "bg-[var(--popover)] text-foreground ring-1 ring-foreground/8"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The "Anyone" half: what the link is, or the button that makes one. */
function PublicLink({
  status,
  share,
  busy,
  guestComments,
  onGuestComments,
  onCreate,
  onRevoke,
}: {
  status: "idle" | "loading" | "ready" | "error";
  share: ArtifactShare | null;
  busy: boolean;
  guestComments: boolean;
  onGuestComments: (on: boolean) => void;
  onCreate: () => void;
  onRevoke: () => void;
}) {
  if (status === "loading" || status === "idle") {
    return <p className="text-2xs text-muted-foreground">Checking for a public link…</p>;
  }
  if (status === "error") {
    return <p className="text-2xs text-error">Couldn't load this Project's links.</p>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-foreground/5 p-2.5">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-secondary-foreground">
        Guests can comment
        <input
          type="checkbox"
          checked={share ? share.commentsEnabled : guestComments}
          disabled={busy || share !== null}
          onChange={(e) => onGuestComments(e.target.checked)}
          className="size-3.5 cursor-pointer accent-[var(--primary)]"
        />
      </label>
      {share ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-muted-foreground">
            Anyone with the link can read this Session.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={onRevoke}
            className="shrink-0 cursor-pointer rounded-full px-2 py-1 text-2xs text-error transition-colors duration-fast hover:bg-[var(--atlas-status-error-background)] disabled:opacity-40"
          >
            Stop sharing
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="flex h-8 cursor-pointer items-center justify-center rounded-full bg-foreground text-2xs font-medium text-background transition-opacity duration-fast hover:opacity-85 disabled:opacity-40"
        >
          Create public link
        </button>
      )}
    </div>
  );
}

/** The illustration: the Session as a paperclipped sheet on dashed orbits,
 *  with the people who have touched it bobbing around it. */
function Stage({
  open,
  title,
  detail,
  author,
}: {
  open: boolean;
  title: string;
  detail: Detail;
  author: ReturnType<typeof authorOf>;
}) {
  const body = excerpt(detail);
  return (
    <div className="relative h-48 shrink-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)]">
      <svg
        aria-hidden
        viewBox="0 0 320 192"
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 size-full text-foreground/16"
      >
        {[70, 120, 170, 220].map((r) => (
          <circle
            key={r}
            cx="160"
            cy="220"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeDasharray="3 5"
          />
        ))}
      </svg>

      <motion.div
        initial={false}
        animate={open ? { opacity: 1, y: 0, rotate: -2 } : { opacity: 0, y: 28, rotate: -6 }}
        transition={{ ...SPRING_PILL, delay: open ? 0.12 : 0 }}
        className="group/sheet absolute top-6 left-1/2 w-34 -translate-x-1/2"
      >
        <span
          aria-hidden
          className="absolute inset-0 translate-x-1 rotate-3 rounded-lg border border-[var(--border)] bg-[var(--popover)] transition-transform duration-base ease-out-strong group-hover/sheet:translate-x-4 group-hover/sheet:rotate-9"
        />
        <span
          aria-hidden
          className="absolute inset-0 -translate-x-0.5 -rotate-2 rounded-lg border border-[var(--border)] bg-[var(--popover)] transition-transform duration-base ease-out-strong group-hover/sheet:-translate-x-3 group-hover/sheet:-rotate-7"
        />
        <div className="relative h-34 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--popover)] px-3 pt-4 shadow-md">
          <p className="line-clamp-3 text-2xs leading-snug font-medium">{title}</p>
          <p className="mt-1.5 h-16 overflow-hidden text-3xs leading-relaxed text-muted-foreground">
            {body}
          </p>
        </div>
        <Paperclip
          size={18}
          className="absolute -top-2.5 left-2 -rotate-12 text-muted-foreground transition-transform duration-base ease-out-strong group-hover/sheet:-translate-y-0.5 group-hover/sheet:-rotate-20"
        />
      </motion.div>

      {author.avatar && (
        <motion.div
          initial={false}
          animate={open ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
          transition={{ ...SPRING_PILL, delay: open ? 0.2 : 0 }}
          style={{ left: `${ORBIT[0]!.x}%`, top: `${ORBIT[0]!.y}%` }}
          className="absolute -translate-1/2"
        >
          <motion.div
            animate={open ? { y: [0, -4, 0] } : { y: 0 }}
            transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            className="rounded-full ring-2 ring-[var(--card)]"
          >
            <AccountAvatar user={author.avatar} size={24} />
          </motion.div>
          {author.isSelf && (
            <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-full bg-foreground px-1.5 text-3xs font-medium text-background">
              You
            </span>
          )}
        </motion.div>
      )}
    </div>
  );
}

/** The first response, as plain prose — the sheet's preview body. */
function excerpt(detail: Detail): string {
  const first = detail.entries.find((e) => e.kind === "response");
  return (first?.text ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_`>[\]()-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
