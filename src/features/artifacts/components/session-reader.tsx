/**
 * The open Session, docked beside the board.
 *
 * A dock rather than a page swap: the board is the index you are reading
 * *from*, and replacing it to show one Session meant losing your place every
 * time you opened something. Beside it, the row stays lit, the day you were
 * in stays on screen, and the next Session is one click away.
 *
 * Its header is the one line of chrome: what state the Session is in, which
 * Session it is, and the two controls that are about the panel rather than
 * the record — widen it, close it. Everything about the Session itself lives
 * in {@link SessionDetail} below, including its own floating action bar.
 */

import { Check, Link2, PanelLeft, PanelRight, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { SessionDetail as Detail } from "../types";
import { sessionState, shortSessionId } from "../lib/board";
import { SessionStatusIcon, STATE_LABEL } from "./session-status-icon";
import { Hint } from "@tryatlas/design";

/** One half of the width pair. Pressed is a filled thumb, as a segmented
 *  control's selected segment is everywhere else in the app. */
function SizeButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint label={label} side="bottom">
      <button
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        onClick={onClick}
        className={cn(
          "grid h-5.5 w-6 cursor-pointer place-items-center rounded-full transition-colors duration-fast",
          pressed
            ? "bg-element-selected text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Hint>
  );
}

/**
 * Hand this Session to someone else.
 *
 * A shared Session copies as a link a colleague can open; a local one has no
 * address to give out, so it copies the id it always did. The id is useless
 * to anyone else, which is exactly why it stops being the answer the moment
 * there is a URL.
 */
function CopyLink({
  sessionId,
  remoteProjectId,
}: {
  sessionId: string;
  remoteProjectId: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (flash.current && clearTimeout(flash.current)), []);

  const copy = () => {
    void (async () => {
      const url = remoteProjectId
        ? await invoke<string | null>("artifacts_cloud_session_url", {
            projectId: remoteProjectId,
            sessionId,
          }).catch(() => null)
        : null;
      await copyText(url ?? sessionId);
    })();
    setCopied(true);
    if (flash.current) clearTimeout(flash.current);
    flash.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Hint
      label={remoteProjectId ? "Copy a link to this Session" : `Copy ${sessionId}`}
      side="bottom"
    >
      <button
        type="button"
        aria-label={remoteProjectId ? "Copy a link to this Session" : "Copy the Session id"}
        onClick={copy}
        className="grid size-control-xs shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-foreground"
      >
        {copied ? <Check size={12} className="text-success" /> : <Link2 size={12} />}
      </button>
    </Hint>
  );
}

export function SessionReaderHeader({
  detail,
  sessionId,
  wide,
  onToggleWide,
  onClose,
  actions,
  remoteProjectId = null,
}: {
  /** `undefined` while the read is in flight — the header still draws, so the
   *  panel has a close button before its contents arrive. */
  detail: Detail | null | undefined;
  sessionId: string;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  /** Session-scoped actions — export, and whatever else is about the record. */
  actions?: ReactNode;
  /** The server Project, when this Session is shared. Without one there is no
   *  address to hand out and the id is copied instead. */
  remoteProjectId?: string | null;
}) {
  const state = detail ? sessionState(detail.summary) : null;

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      {state && <SessionStatusIcon state={state} />}
      <span className="shrink-0 text-xs font-medium text-foreground">
        {state ? STATE_LABEL[state] : "Loading…"}
      </span>
      {/* The id, so what is on screen can be named in a message to someone
          else — shortened, because only its first digits are ever read. The
          full one is on the tooltip, and the copy button beside it copies the
          whole thing. */}
      <span className="shrink-0 font-mono text-2xs text-muted-foreground" title={sessionId}>
        {shortSessionId(sessionId)}
      </span>

      <CopyLink sessionId={sessionId} remoteProjectId={remoteProjectId} />

      <span className="flex-1" />

      {actions}

      {/* Two sizes, as a segmented pair rather than one toggle: a single
          button that changes meaning each time you press it makes you read it
          before every press. Two say what both sizes ARE, and which one you
          are in. */}
      <div
        role="group"
        aria-label="Session width"
        className="flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5"
      >
        <SizeButton
          label="Beside the timeline"
          pressed={!wide}
          onClick={() => wide && onToggleWide()}
        >
          <PanelRight size={12} />
        </SizeButton>
        <SizeButton label="Full width" pressed={wide} onClick={() => !wide && onToggleWide()}>
          <PanelLeft size={12} />
        </SizeButton>
      </div>
      <Hint label="Close" side="bottom">
        <button
          type="button"
          aria-label="Close session"
          onClick={onClose}
          className="grid size-control-sm shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-foreground"
        >
          <X size={14} />
        </button>
      </Hint>
    </header>
  );
}
