import { useEffect, useMemo, useRef } from "react";
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { editorThemeExtensions } from "@/features/editor/themes/build-cm-theme";
import { sendToAgentChat } from "@/features/chat/lib/send-to-agent";
import { yCollab } from "y-codemirror.next";
import { CommsAvatar } from "./comms-avatar";
import { useDraftSession } from "../lib/use-draft-session";
import { peerTone } from "../lib/derive";
import { remoteCaretField, setRemoteCarets } from "../lib/cm-remote-carets";
import { useCommsStore } from "../stores/comms-store";
import type { ChatConversation, PromptDraft } from "../types";
import { DraftEditorView } from "./views/draft-editor-view";

/**
 * The realtime Prompt Draft editor: one shared Y.Doc, everyone types at
 * once, remote carets drawn in place with the owner's name — the document
 * plumbing lives in `use-draft-session`, the chrome in
 * `views/draft-editor-view.tsx`, and this file wires CodeMirror with `yCollab`
 * for sync and a custom caret layer (`lib/cm-remote-carets.ts`) for the
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps
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
      tone: peerTone(p.userId),
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

  const peerList = Object.values(peers).map((p) => {
    const member = members.get(p.userId) ?? null;
    return {
      id: p.userId,
      name: member?.name ?? null,
      tone: peerTone(p.userId),
      avatar: <CommsAvatar member={member} size={16} />,
    };
  });

  return (
    <DraftEditorView
      convName={conv.name}
      sent={sent}
      ready={ready}
      editorHost={host}
      onCopy={() => void copyAll()}
      onSendToAgent={toAgent}
      peers={peerList}
      self={<CommsAvatar member={members.get(me) ?? null} size={16} />}
    />
  );
}

function firstName(name: string | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "Someone";
}
