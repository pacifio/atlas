import { useEffect, useMemo, useRef } from "react";
import { Copy, Hash, Link2, Play } from "lucide-react";
import {
  EditorView,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  Decoration,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { editorThemeExtensions } from "@/features/editor/themes/build-cm-theme";
import { useProjectStore } from "@/features/project/stores/project-store";
import { sendToAgentChat } from "@/features/chat/lib/send-to-agent";
import { yCollab } from "y-codemirror.next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CommsAvatar } from "./comms-avatar";
import { useDraftSession } from "../lib/use-draft-session";
import { avatarHue } from "../lib/derive";
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
  const themeId = useProjectStore((s) => s.settings.codeEditorTheme);

  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
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
        editorThemeExtensions(themeId),
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
  }, [ready, ytext, sent, themeId]);

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
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-default px-1.5">
        <span className="flex min-w-0 items-center gap-1 pl-1 text-[11px] font-medium text-text-secondary">
          <Hash size={11} className="shrink-0 text-text-tertiary" />
          <span className="truncate">{conv.name ?? "conversation"}</span>
        </span>

        {/* Centre: the grouped action pill. */}
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="flex items-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06]">
            <PillButton label="Copy draft" onClick={() => void copyAll()}>
              <Copy size={11} />
            </PillButton>
            <span className="h-4 w-px bg-white/10" />
            <PillButton label="Send to agent" onClick={toAgent}>
              <Play size={11} />
            </PillButton>
            <span className="h-4 w-px bg-white/10" />
            {/* No API mints a public draft link (the meetings door is the one
                unauthenticated surface) — a mock, like the Spaces pill. */}
            <PillButton label="Public link — coming soon" disabled>
              <Link2 size={11} />
            </PillButton>
          </div>
        </div>

        {/* Who's here — always at least you: an empty corner read as "nobody
            is in this doc", which is never true while you are. Peers stack in
            front of your avatar as they arrive. */}
        <div className="flex shrink-0 items-center pl-1">
          <div className="flex items-center -space-x-1.5">
            {peerList.slice(0, 3).map((p) => (
              <Tooltip key={p.userId}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <CommsAvatar
                      member={members.get(p.userId) ?? null}
                      size={16}
                      className="ring-2 ring-[var(--comms-surface)] rounded-full"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {members.get(p.userId)?.name ?? "Unknown"} · editing
                </TooltipContent>
              </Tooltip>
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <CommsAvatar
                    member={members.get(me) ?? null}
                    size={16}
                    className="ring-2 ring-[var(--comms-surface)] rounded-full"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                You
              </TooltipContent>
            </Tooltip>
          </div>
          {peerList.length > 3 && (
            <span className="pl-1 text-[9.5px] text-text-tertiary">+{peerList.length - 3}</span>
          )}
        </div>
      </div>

      {sent && (
        <div className="shrink-0 border-b border-border-subtle bg-white/[0.03] px-3 py-1 text-[10px] text-text-tertiary">
          Sent to an agent — this draft is read-only now.
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto hide-scrollbar">
        {!ready && (
          <div className="flex flex-col gap-2 px-4 py-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[10px] rounded bg-[var(--bg-elevated)] opacity-50"
                style={{
                  width: `${60 - i * 12}%`,
                  animation: "atlas-marker-shimmer 1.4s ease-in-out infinite",
                }}
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex h-[22px] w-8 items-center justify-center text-text-secondary transition-colors",
            disabled
              ? "cursor-not-allowed text-text-ghost"
              : "hover:bg-white/10 hover:text-text-primary cursor-pointer",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function firstName(name: string | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "Someone";
}

// ---------------------------------------------------------------------------
// Remote carets — the Google-docs treatment, from position-only awareness.
// ---------------------------------------------------------------------------

interface CaretInfo {
  userId: string;
  cursor: number;
  name: string;
}

const setRemoteCarets = StateEffect.define<CaretInfo[]>();

class CaretWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly hue: number,
  ) {
    super();
  }
  override eq(other: CaretWidget): boolean {
    return other.name === this.name && other.hue === this.hue;
  }
  toDOM(): HTMLElement {
    const color = `hsl(${this.hue} 55% 55%)`;
    const wrap = document.createElement("span");
    wrap.className = "atlas-remote-caret";
    wrap.style.cssText =
      "position:relative;display:inline-block;width:0;height:1em;vertical-align:text-bottom;";
    const bar = document.createElement("span");
    bar.style.cssText = `position:absolute;left:-1px;top:0;bottom:-2px;width:2px;border-radius:1px;background:${color};`;
    const flag = document.createElement("span");
    flag.textContent = this.name;
    flag.style.cssText =
      `position:absolute;left:-1px;top:-14px;padding:0 4px;border-radius:3px 3px 3px 0;` +
      `background:${color};color:#fff;font-size:9px;line-height:13px;white-space:nowrap;` +
      `pointer-events:none;user-select:none;`;
    wrap.append(bar, flag);
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Carets as a StateField so positions MAP through document changes between
 *  awareness frames — a peer's caret keeps riding its text while you type
 *  above it, instead of drifting until their next 500ms publish. */
const remoteCaretField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(carets, tr) {
    let next = carets.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCarets)) {
        const len = tr.newDoc.length;
        next = Decoration.set(
          effect.value
            .map((c) => {
              const at = Math.min(Math.max(0, c.cursor), len);
              return Decoration.widget({
                widget: new CaretWidget(c.name, avatarHue(c.userId)),
                side: -1,
              }).range(at);
            })
            .sort((a, b) => a.from - b.from),
        );
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
