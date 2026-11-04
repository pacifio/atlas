// The ask box, mounted once at the app root. Opened from anywhere through
// `openAskAgent` (`../lib/ask-agent.ts`); it grows out of what opened it (the
// popover's `--transform-origin`), takes the focus into its field, and hands
// it back when it closes. The face is `views/ask-agent-box-view.tsx`.

import { useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent } from "@tryatlas/design";

import { isMac } from "@/lib/platform";
import { contextLabel, contextTitle, type AgentContext } from "../lib/agent-context";
import {
  activeSession,
  askAgent,
  confirmAsk,
  openSessions,
  type AskTarget,
  type OpenSession,
} from "../lib/ask-agent";
import { trackFocusedContext } from "../lib/focused-context";
import { useAskAgentStore, type AskAnchor, type AskRequest } from "../stores/ask-agent-store";
import { AskAgentBoxView, type AskTargetOption } from "./views/ask-agent-box-view";

/** How many open sessions the picker lists besides "New session". */
const RECENT_SESSIONS = 6;

const SEND_KEYS = isMac ? ["⌘", "↵"] : ["Ctrl", "↵"];
const DRAFT_KEYS = isMac ? ["⌘", "⇧", "↵"] : ["Ctrl", "⇧", "↵"];

/** What Base UI positions against: the element, the rect, or a point near
 *  the top of the window. */
function positionAnchor(anchor: AskAnchor): Element | { getBoundingClientRect: () => DOMRect } {
  if (anchor instanceof Element) return anchor;
  const rect = anchor ?? new DOMRect(window.innerWidth / 2, window.innerHeight * 0.18, 0, 0);
  return { getBoundingClientRect: () => rect };
}

/** The picker's options and the one it opens on: the recent open sessions,
 *  then "Start a new session". A session the ask names is listed even when
 *  it is not a recent one, so the box opens on it rather than on the session
 *  in view. Pure. */
export function pickerTargets(
  open: readonly OpenSession[],
  active: string | null,
  wanted: string | undefined,
): { targets: AskTargetOption[]; initial: string } {
  const sessions = open.slice(0, RECENT_SESSIONS);
  const named = open.find((s) => s.tabId === wanted);
  if (named && !sessions.includes(named)) sessions.unshift(named);
  const targets: AskTargetOption[] = sessions.map((s) => ({
    value: s.tabId,
    label: s.title,
    description: s.tabId === active ? "Current session" : "Open session",
  }));
  targets.push({ value: "new", label: "Start a new session", description: "In this project" });
  const initial =
    wanted && targets.some((o) => o.value === wanted)
      ? wanted
      : (active ?? sessions[0]?.tabId ?? "new");
  return { targets, initial };
}

export function AskAgentHost() {
  const request = useAskAgentStore.use.request();
  const serial = useAskAgentStore.use.serial();
  const { close } = useAskAgentStore.use.actions();
  // The last request stays drawn while the popup plays its exit.
  const shown = useRef<AskRequest | null>(null);
  if (request) shown.current = request;

  useEffect(() => trackFocusedContext(), []);

  const current = request ?? shown.current;
  return (
    <Popover open={request !== null} onOpenChange={(open) => !open && close()}>
      {current && (
        <AskAgentBox key={serial} request={current} open={request !== null} onClose={close} />
      )}
    </Popover>
  );
}

function AskAgentBox({
  request,
  open,
  onClose,
}: {
  request: AskRequest;
  open: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [contexts, setContexts] = useState(() =>
    request.context.map((ctx, i) => ({ key: `${i}`, ctx })),
  );
  const [prompt, setPrompt] = useState(request.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once: the box lives for one ask, and a subscription to every
  // session would re-render it on every streamed token.
  const [{ targets, initial }] = useState(() =>
    pickerTargets(openSessions(), activeSession(), request.target),
  );
  const [target, setTarget] = useState<AskTarget>(initial);

  const chips = useMemo(
    () =>
      contexts.map(({ key, ctx }) => ({
        key,
        kind: ctx.kind,
        label: contextLabel(ctx),
        title: contextTitle(ctx),
      })),
    [contexts],
  );
  // Stable, so typing does not hand the popover a new anchor every key.
  const anchor = useMemo(() => positionAnchor(request.anchor), [request.anchor]);
  const canSubmit = open && !busy && (contexts.length > 0 || prompt.trim().length > 0);

  const submit = async (send: boolean) => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const context: AgentContext[] = contexts.map((c) => c.ctx);
      const result = await askAgent({ context, prompt, send, target });
      onClose();
      confirmAsk(result);
      // Each chip's key is its index in the request's context.
      request.onAsked?.(
        result,
        contexts.map((c) => Number(c.key)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PopoverContent
      data-ask-agent-box=""
      anchor={anchor}
      side="bottom"
      // Under its trigger's start edge; centred when there is none.
      align={request.anchor ? "start" : "center"}
      sideOffset={6}
      // A pre-filled prompt ("Fix this:") is continued, not overtyped: the
      // caret starts at its end.
      initialFocus={() => {
        const el = inputRef.current;
        el?.setSelectionRange(el.value.length, el.value.length);
        return el;
      }}
      // Reduced motion: globals.css swaps `animate-scale-in` for a fade.
      className="w-96 max-w-[calc(100vw-2rem)]"
    >
      <AskAgentBoxView
        chips={chips}
        onRemoveChip={(key) => setContexts((cs) => cs.filter((c) => c.key !== key))}
        prompt={prompt}
        onPromptChange={setPrompt}
        suggestions={request.suggestions}
        onSuggestion={(s) => {
          // Fills, never sends: the session can still be picked, the words
          // still edited. The caret goes back to the end of the field.
          setPrompt(s);
          requestAnimationFrame(() => {
            const el = inputRef.current;
            el?.focus();
            el?.setSelectionRange(el.value.length, el.value.length);
          });
        }}
        placeholder={request.placeholder}
        targets={targets}
        target={target}
        onTargetChange={setTarget}
        onSend={() => void submit(true)}
        onDraft={() => void submit(false)}
        onCancel={onClose}
        canSubmit={canSubmit}
        error={error}
        sendKeys={SEND_KEYS}
        draftKeys={DRAFT_KEYS}
        inputRef={inputRef}
      />
    </PopoverContent>
  );
}
