// Mention pills inside the composer.
//
// The problem this solves: the body format stores a mention as `<@user_id>`,
// and an id is 32 characters of noise. Typing one used to leave
// `<@AyavUcP3Vbur3PSS1802TE1tXBIKDRvf>` sitting in the composer — unreadable,
// and nothing like the pill the message renders as a second later.
//
// A `<textarea>` cannot do better: its text IS its display, so the id has to be
// visible. CodeMirror separates the two. The document still holds the exact
// `<@id>` the server expects — drafts, the byte counter and send are untouched
// — and a `Decoration.replace` paints a widget over that range. The same spans
// go into `atomicRanges`, so one Backspace removes a whole mention and the
// caret steps over it rather than landing inside the id. This is the same
// model the agent composer uses (`features/chat/lib/cm-mention-extension`),
// minus its side-table: a comms mention is self-describing, so the decorations
// can be derived from the document text and never drift from it.
//
// The directory arrives by effect rather than closure because names load
// asynchronously — the roster can arrive after the draft was restored, and the
// chips have to repaint when it does.

import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";

import { BROADCAST_SOURCE, MENTION_SOURCE } from "../types";
import type { OrgMemberProfile } from "../types";
import {
  avatarElement,
  MENTION_PILL_ATTR,
  MENTION_SELF_ATTR,
  mentionPillClass,
} from "./mention-pill";

export interface MentionDirectory {
  members: Map<string, OrgMemberProfile>;
  /** The current user — a mention of them reads as addressed to you. */
  me: string;
}

const EMPTY: MentionDirectory = { members: new Map(), me: "" };

export const setMentionDirectory = StateEffect.define<MentionDirectory>();

const directoryField = StateField.define<MentionDirectory>({
  create: () => EMPTY,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMentionDirectory)) return effect.value;
    }
    return value;
  },
});

class ChipWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly highlight: boolean,
    readonly title: string | undefined,
    /** Null for `@channel` / `@here`, which have no face to show. */
    readonly member: OrgMemberProfile | null,
  ) {
    super();
  }

  // Without this every keystroke rebuilds every chip's DOM.
  eq(other: ChipWidget): boolean {
    return (
      other.label === this.label &&
      other.highlight === this.highlight &&
      other.title === this.title &&
      other.member?.id === this.member?.id &&
      other.member?.image === this.member?.image
    );
  }

  toDOM(): HTMLElement {
    // Shape and classes come from `mention-pill`, shared with the rendered
    // message, so the chip you are typing matches the one you will send.
    const span = document.createElement("span");
    span.className = mentionPillClass(this.highlight);
    span.setAttribute(MENTION_PILL_ATTR, "");
    if (this.highlight) span.setAttribute(MENTION_SELF_ATTR, "");
    if (this.member) span.append(avatarElement(this.member));
    const text = document.createElement("span");
    text.textContent = this.label;
    span.append(text);
    if (this.title) span.title = this.title;
    return span;
  }
}

const SCANNER = new RegExp(`${MENTION_SOURCE}|${BROADCAST_SOURCE}`, "g");
const FENCE = /^\s*```/;

/**
 * Ranges that must not become pills, because the message renderer will not
 * make them pills either: anything inside a fence or a `` `code span` ``.
 *
 * Deliberately a scanner rather than a markdown parse. The composer holds at
 * most 16 KB and this runs per keystroke, and getting it slightly wrong costs a
 * chip that should have been plain — not a wrong message. Showing a pill for a
 * token that will render as literal text is the failure worth avoiding.
 */
function codeMask(text: string): (index: number) => boolean {
  const lines = text.split("\n");
  const spans: [number, number][] = [];
  let offset = 0;
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      // The fence line itself, and everything until the closing one.
      inFence = !inFence;
      spans.push([offset, offset + line.length]);
    } else if (inFence) {
      spans.push([offset, offset + line.length]);
    } else {
      // Inline code: every pair of backticks on the line.
      let tick = line.indexOf("`");
      while (tick !== -1) {
        const close = line.indexOf("`", tick + 1);
        if (close === -1) break;
        spans.push([offset + tick, offset + close + 1]);
        tick = line.indexOf("`", close + 1);
      }
    }
    offset += line.length + 1; // the newline
  }

  return (index: number) => spans.some(([from, to]) => index >= from && index < to);
}

function buildChips(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const { members, me } = view.state.field(directoryField);
  const builder = new RangeSetBuilder<Decoration>();
  const inCode = codeMask(text);

  SCANNER.lastIndex = 0;
  for (let m = SCANNER.exec(text); m; m = SCANNER.exec(text)) {
    if (inCode(m.index)) continue;
    const [raw, userId, broadcast] = m;

    let label: string;
    let highlight: boolean;
    let title: string | undefined;
    let member: OrgMemberProfile | null = null;
    if (userId !== undefined) {
      member = members.get(userId) ?? null;
      // An unresolved id keeps the raw token: a pill reading "@unknown" over
      // an id we cannot name would hide which person is about to be notified.
      if (!member) continue;
      label = `@${member.name}`;
      highlight = userId === me;
      title = member.email;
    } else {
      label = `@${broadcast}`;
      highlight = true;
      title = broadcast === "here" ? "Notifies everyone online" : "Notifies everyone";
    }

    builder.add(
      m.index,
      m.index + raw.length,
      Decoration.replace({
        widget: new ChipWidget(label, highlight, title, member),
        inclusive: false,
      }),
    );
  }

  return builder.finish();
}

const chipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildChips(view);
    }

    update(update: ViewUpdate) {
      const directoryChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setMentionDirectory)),
      );
      if (update.docChanged || directoryChanged) {
        this.decorations = buildChips(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** One Backspace deletes a whole mention, and arrows step over it. */
const atomicChips = EditorView.atomicRanges.of(
  (view) => view.plugin(chipPlugin)?.decorations ?? Decoration.none,
);

export const commsMentionExtension = [directoryField, chipPlugin, atomicChips];
