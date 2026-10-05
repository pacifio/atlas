import { useEffect, useMemo, useRef } from "react";
import { Copy, Hash, Link2, Play } from "lucide-react";
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { editorThemeExtensions } from "@/features/editor/themes/build-cm-theme";
import { sendToAgentChat } from "@/features/chat/lib/send-to-agent";
import { yCollab } from "y-codemirror.next";
import { remoteCaretField, setRemoteCarets } from "@/features/editor/lib/remote-carets";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CommsAvatar } from "./comms-avatar";
import { useDraftSession } from "../lib/use-draft-session";
import { useCommsStore } from "../stores/comms-store";
import type { ChatConversation, PromptDraft } from "../types";

/**
 * The realtime Prompt Draft editor: one shared Y.Doc, everyone types at
 * once, remote carets drawn in place with the owner's name — the document
 * plumbing lives in `use-draft-session` and this file is the chrome plus a
 * CodeMirror wired with `yCollab` for sync and a custom caret layer for the
 * bespoke awareness protocol (position-only; y-protocols would be invisible
 * to the web client).
 */
export function DraftEditor({ conv, draft }: { conv: ChatConversation; draft: PromptDraft }) {
  const { ytext, ready, meta, peers, publishCursor } = useDraftSession(draft);
  const memberList = useCommsStore.use.members();
  const me = useCommsStore.use.me();
  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The theme lives in its own compartment so a theme apply reconfigures it in
  // place. It used to be a dependency of the effect below, so every apply
  // destroyed the view — and the user's focus and undo history with it.
  const themeCompartment = useRef(new Compartment()).current;
  const sent = meta.sent_at !== null;

  // ---- CodeMirror ---------------------------------------------------------
  useEffect(() => {
    if (!host.current || !ready) return;
    const view = new EditorView({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        history(),
        markdown({ base: markdownLanguage, addKeymap: true }),
        EditorView.lineWrapping,
        keymap.of([...historyKeymap, ...defaultKeymap]),
        cmPlaceholder("Write together…"),
        themeCompartment.of(editorThemeExtensions()),
        yCollab(ytext, null),
        remoteCaretField,
        EditorState.readOnly.of(sent),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) {
            publishCursor(u.state.selection.main.head);
          }
        }),
        EditorView.contentAttributes.of({ "aria-label": `Draft ${meta.title}` }),
      ],
      parent: host.current,
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Recreated only on identity-level changes; yCollab owns doc content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ytext, sent]);

  // Live-reskin on every theme apply, as `editor-panel.tsx` does.
  useEffect(() => {
    const onTheme = () => {
      viewRef.current?.dispatch({
        effects: themeCompartment.reconfigure(editorThemeExtensions()),
      });
    };
    window.addEventListener("atlas:theme-applied", onTheme);
    return () => window.removeEventListener("atlas:theme-applied", onTheme);
  }, [themeCompartment]);

  // Push peer carets into the editor as decorations whenever they move.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const list = Object.values(peers).map((p) => ({
      ...p,
      name: firstName(members.get(p.userId)?.name),
    }));
    view.dispatch({ effects: setRemoteCarets.of(list) });
  }, [peers, members]);

  // ---- actions ------------------------------------------------------------
  const copyAll = async () => {
    const ok = await copyText(ytext.toString());
    if (ok) toast.success("Draft copied.");
  };
  const toAgent = () => {
    const text = ytext.toString().trim();
    if (!text) {
      toast.error("The draft is empty.");
      return;
    }
    sendToAgentChat(text);
  };

  const peerList = Object.values(peers);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border px-1.5">
        <span className="flex min-w-0 items-center gap-1 pl-1 text-xs font-medium text-secondary-foreground">
          <Hash size={11} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{conv.name ?? "conversation"}</span>
        </span>

        {/* Centre: the grouped action pill. */}
        <div className="flex min-w-0 flex-1 justify-center">
          <HintGroup>
            <div className="flex items-center overflow-hidden rounded-full border border-border bg-[var(--atlas-element-selected)]">
              <PillButton label="Copy draft" onClick={() => void copyAll()}>
                <Copy size={11} />
              </PillButton>
              <span className="h-4 w-px bg-border" />
              <PillButton label="Send to agent" onClick={toAgent}>
                <Play size={11} />
              </PillButton>
              <span className="h-4 w-px bg-border" />
              {/* No API mints a public draft link (the meetings door is the one
                unauthenticated surface) — a mock, like the Spaces pill. */}
              <PillButton label="Public link — coming soon" disabled>
                <Link2 size={11} />
              </PillButton>
            </div>
          </HintGroup>
        </div>

        {/* Who's here — always at least you: an empty corner read as "nobody
            is in this doc", which is never true while you are. Peers stack in
            front of your avatar as they arrive. */}
        <div className="flex shrink-0 items-center pl-1">
          <div className="flex items-center -space-x-1.5">
            {peerList.slice(0, 3).map((p) => (
              <Tooltip key={p.userId}>
                <TooltipTrigger
                  render={
                    <span className="inline-flex">
                      <CommsAvatar
                        member={members.get(p.userId) ?? null}
                        size={16}
                        className="ring-2 ring-[var(--background)] rounded-full"
                      />
                    </span>
                  }
                />
                <TooltipContent side="bottom" sideOffset={4}>
                  {members.get(p.userId)?.name ?? "Unknown"} · editing
                </TooltipContent>
              </Tooltip>
            ))}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <CommsAvatar
                      member={members.get(me) ?? null}
                      size={16}
                      className="ring-2 ring-[var(--background)] rounded-full"
                    />
                  </span>
                }
              />
              <TooltipContent side="bottom" sideOffset={4}>
                You
              </TooltipContent>
            </Tooltip>
          </div>
          {peerList.length > 3 && (
            <span className="pl-1 text-2xs text-muted-foreground">+{peerList.length - 3}</span>
          )}
        </div>
      </div>

      {sent && (
        <div className="shrink-0 border-b border-border-subtle bg-[var(--atlas-element-hover)] px-3 py-1 text-2xs text-muted-foreground">
          Sent to an agent — this draft is read-only now.
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto hide-scrollbar">
        {!ready && (
          <div className="flex flex-col gap-2 px-4 py-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[10px] rounded bg-[var(--card)] opacity-50 atlas-marker-running"
                style={{ width: `${60 - i * 12}%` }}
              />
            ))}
          </div>
        )}
        <div ref={host} className={cn("h-full [&_.cm-editor]:h-full", !ready && "hidden")} />
      </div>
    </div>
  );
}

function PillButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex h-[22px] w-8 items-center justify-center text-secondary-foreground transition-colors",
          disabled
            ? "cursor-not-allowed text-disabled"
            : "hover:bg-[var(--atlas-element-active)] hover:text-foreground cursor-pointer",
        )}
      >
        {children}
      </button>
    </HintItem>
  );
}

function firstName(name: string | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "Someone";
}

