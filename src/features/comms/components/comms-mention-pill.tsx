// Team chat's mention pill, on the shared composer core
// (`components/composer/composer-chip.tsx`).
//
// The node carries only who is mentioned (`{ userId }` or `{ broadcast }`);
// the name and face come from the roster at render time, through
// `CommsDirectoryContext`, so a roster that loads after the draft repaints the
// pills without touching the document — the same reason the message renderer
// resolves names at render.
//
// The look is the rendered message's pill (`lib/mention-pill.ts`,
// `CommsAvatar`), so the pill you are typing is the one you will send.
//
// `CommsMentionPills` keeps the document's pills in step with what the user
// types. The CodeMirror composer re-derived its decorations from the whole
// text on every keystroke; here the scan covers only the lines a change
// touched, and rewrites a line only when its pills actually differ:
//   - a finished `@channel ` / `@here ` / `<@id>` becomes a pill — a
//     broadcast not while the caret still sits at its end, so `@here` is not a
//     pill a keystroke before it turns into `@hereby`;
//   - a pill that ends up inside code (backticks typed around it, a fence
//     opened above it) goes back to its text, because the renderer will print
//     it literally.

import { createContext, useContext } from "react";
import { Extension, combineTransactionSteps, getChangedRanges } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { NodeViewWrapper } from "@tiptap/react";

import { createChipNode, type ComposerChipViewProps } from "@/components/composer/composer-chip";
import { FenceTracker } from "@/components/composer/composer-doc";
import { PROGRAMMATIC } from "@/components/composer/composer-editor";
import { cn } from "@/lib/utils";
import {
  COMMS_MENTION,
  commsMentionText,
  mayBeFenceLine,
  pillsInLine,
  type CommsMentionData,
  type MentionDirectory,
} from "../lib/comms-composer-doc";
import {
  MENTION_AVATAR_SIZE,
  MENTION_PILL_ATTR,
  MENTION_SELF_ATTR,
  mentionPillClass,
} from "../lib/mention-pill";
import type { OrgMemberProfile } from "../types";
import { CommsAvatar } from "./comms-avatar";

export const CommsDirectoryContext = createContext<MentionDirectory>({
  members: new Map(),
  me: "",
});

export const CommsMention = createChipNode<CommsMentionData>({
  name: COMMS_MENTION,
  toText: commsMentionText,
  view: CommsMentionView,
  fromHTML: pillFromHTML,
});

/** A pill pasted as HTML: exactly one of the two shapes, or text. */
export function pillFromHTML(record: Record<string, unknown>): CommsMentionData | null {
  if (typeof record.userId === "string" && record.userId) return { userId: record.userId };
  if (record.broadcast === "channel" || record.broadcast === "here") {
    return { broadcast: record.broadcast };
  }
  return null;
}

function CommsMentionView({ data, selected }: ComposerChipViewProps<CommsMentionData>) {
  const { members, me } = useContext(CommsDirectoryContext);
  const member = "userId" in data ? (members.get(data.userId) ?? null) : null;
  // A broadcast notifies everyone, so it always reads as addressed to you.
  const highlight = "userId" in data ? data.userId === me : true;
  const title =
    "userId" in data
      ? member?.email
      : data.broadcast === "here"
        ? "Notifies everyone online"
        : "Notifies everyone";
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      title={title}
      {...{ [MENTION_PILL_ATTR]: "", [MENTION_SELF_ATTR]: highlight ? "" : undefined }}
      className={cn(mentionPillClass(highlight), selected && "atlas-mention-chip--selected")}
    >
      {/* No face for a broadcast — there is nobody in particular to show. */}
      {"userId" in data && <CommsAvatar member={member} size={MENTION_AVATAR_SIZE} />}
      <span>
        {"userId" in data
          ? member
            ? `@${member.name}`
            : commsMentionText(data)
          : `@${data.broadcast}`}
      </span>
    </NodeViewWrapper>
  );
}

/** Whether a line could be fence markup. Fence markup starts the line, so
 *  the first text run is all there is to read: cheap enough to ask of every
 *  line on every keystroke. */
function blockIsFence(block: PMNode): boolean {
  const first = block.firstChild;
  return !!first?.isText && mayBeFenceLine(first.text ?? "");
}

/** What `FenceTracker` needs of a line: its first text run, and a stand-in
 *  for anything after it, since a fence line with a pill on it closes
 *  nothing. */
function fenceText(block: PMNode): string {
  const first = block.firstChild;
  if (!first?.isText) return block.childCount > 0 ? "\uFFFC" : "";
  return block.childCount > 1 ? `${first.text ?? ""}\uFFFC` : (first.text ?? "");
}

/** Whether a line could hold a pill, or holds one now. */
function mayHavePills(block: PMNode): boolean {
  let may = false;
  block.forEach((node) => {
    if (!node.isText || (node.text ?? "").includes("@")) may = true;
  });
  return may;
}

/** One line's text as the wire has it, and where each text offset sits in the
 *  document. */
function lineText(block: PMNode, start: number): { text: string; posAt: (i: number) => number } {
  let text = "";
  const starts: { offset: number; pos: number; atom: boolean }[] = [];
  let pos = start;
  block.forEach((node) => {
    const piece = node.isText
      ? (node.text ?? "")
      : commsMentionText(node.attrs.data as CommsMentionData);
    starts.push({ offset: text.length, pos, atom: !node.isText });
    text += piece;
    pos += node.nodeSize;
  });
  const end = pos;
  return {
    text,
    posAt(i) {
      for (let k = starts.length - 1; k >= 0; k--) {
        const s = starts[k];
        if (i >= s.offset)
          return s.atom ? (i === s.offset ? s.pos : s.pos + 1) : s.pos + (i - s.offset);
      }
      return i === 0 ? start : end;
    },
  };
}

/** The pills a line has now, as `offset:token` keys, for comparing with the
 *  pills it should have. */
function currentPills(block: PMNode): string[] {
  const out: string[] = [];
  let offset = 0;
  block.forEach((node) => {
    if (node.isText) {
      offset += node.text?.length ?? 0;
    } else {
      const text = commsMentionText(node.attrs.data as CommsMentionData);
      out.push(`${offset}:${text}`);
      offset += text.length;
    }
  });
  return out;
}

/** Rewrite the lines in `indexes` so their pills are what their text calls
 *  for. Returns null when every line already agrees. */
function syncPills(
  state: EditorState,
  indexes: Set<number>,
  members: ReadonlyMap<string, OrgMemberProfile>,
) {
  const { doc, selection, schema } = state;
  // Most keystrokes touch a line with no `@` and no pill: nothing to do, and
  // no reason to walk the lines above it for fences.
  for (const i of indexes) if (!mayHavePills(doc.child(i))) indexes.delete(i);
  if (indexes.size === 0) return null;
  const head = selection.head;
  let tr: Transaction | null = null;
  const fences = new FenceTracker();
  let pos = 0;
  const last = Math.max(...indexes);
  for (let i = 0; i <= last; i++) {
    const block = doc.child(i);
    const start = pos + 1;
    pos += block.nodeSize;
    const fenced = fences.line(fenceText(block));
    if (!indexes.has(i)) continue;
    const { text, posAt } = lineText(block, start);
    const caret = head >= start && head <= start + block.content.size ? head : -1;
    const have = currentPills(block);
    const wanted = pillsInLine(text, fenced, members).filter(
      (p) =>
        // A broadcast the caret is still at the end of stays text, unless it
        // already is a pill (a Backspace over the space after it).
        "userId" in p.data ||
        posAt(p.index + p.length) !== caret ||
        have.includes(`${p.index}:${commsMentionText(p.data)}`),
    );
    const wantedKeys = wanted.map((p) => `${p.index}:${commsMentionText(p.data)}`);
    if (wantedKeys.length === have.length && wantedKeys.every((k, j) => k === have[j])) continue;

    const nodes: PMNode[] = [];
    let cursor = 0;
    for (const p of wanted) {
      if (p.index > cursor) nodes.push(schema.text(text.slice(cursor, p.index)));
      nodes.push(schema.nodes[COMMS_MENTION].create({ data: p.data }));
      cursor = p.index + p.length;
    }
    if (cursor < text.length) nodes.push(schema.text(text.slice(cursor)));

    // Where the caret is in this line's text, so it lands in the same place.
    let caretOffset = -1;
    if (caret !== -1) {
      for (let k = 0; k <= text.length; k++) {
        if (posAt(k) >= caret) {
          caretOffset = k;
          break;
        }
      }
    }
    tr ??= state.tr;
    const from = tr.mapping.map(start);
    const to = tr.mapping.map(start + block.content.size);
    tr.replaceWith(from, to, nodes);
    if (caretOffset !== -1) {
      // Recompute against the new line: pills are one position each.
      const rebuilt = tr.doc.resolve(from).parent;
      const map = lineText(rebuilt, from);
      tr.setSelection(TextSelection.create(tr.doc, map.posAt(caretOffset)));
    }
  }
  return tr;
}

export interface CommsMentionPillsOptions {
  getMembers: () => ReadonlyMap<string, OrgMemberProfile>;
}

export const CommsMentionPills = Extension.create<CommsMentionPillsOptions>({
  name: "atlasCommsMentionPills",

  addOptions() {
    return { getMembers: () => new Map() };
  },

  addProseMirrorPlugins() {
    const getMembers = () => this.options.getMembers();
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("atlasCommsMentionPills"),
        props: {
          handleDOMEvents: {
            // The lines skipped while composing get their pills once the
            // input method commits. After the event, so the view has read
            // the committed text.
            compositionend: (view) => {
              window.setTimeout(() => {
                if (view.isDestroyed || view.composing) return;
                const all = new Set<number>();
                for (let i = 0; i < view.state.doc.childCount; i++) all.add(i);
                const tr = syncPills(view.state, all, getMembers());
                if (tr) view.dispatch(tr);
              }, 0);
              return false;
            },
          },
        },
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          // Never rewrite a line an input method is composing in: replacing
          // its text would cancel the composition. `compositionend` catches
          // up.
          if (
            editor.view.composing ||
            transactions.some((tr) => tr.getMeta("composition") != null)
          ) {
            return null;
          }
          // A whole-document set already came through the serializer, and
          // undo/redo restores a document that was already in step.
          if (transactions.some((tr) => tr.getMeta(PROGRAMMATIC) || tr.getMeta("history$"))) {
            return null;
          }
          const ranges = getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions]));
          const indexes = new Set<number>();
          let fenceTouched = false;
          const collect = (
            doc: EditorState["doc"],
            from: number,
            to: number,
            into: Set<number> | null,
          ) => {
            const lo = Math.max(0, Math.min(from, doc.content.size));
            const hi = Math.max(lo, Math.min(to, doc.content.size));
            doc.forEach((block, offset, index) => {
              if (offset + block.nodeSize < lo || offset > hi) return;
              into?.add(index);
              if (blockIsFence(block)) fenceTouched = true;
            });
          };
          for (const { oldRange, newRange } of ranges) {
            collect(oldState.doc, oldRange.from, oldRange.to, null);
            collect(newState.doc, newRange.from, newRange.to, indexes);
          }
          // A fence opened or closed changes every line below it.
          if (fenceTouched) {
            for (let i = 0; i < newState.doc.childCount; i++) indexes.add(i);
          }
          if (indexes.size === 0) return null;
          return syncPills(newState, indexes, getMembers());
        },
      }),
    ];
  },
});
