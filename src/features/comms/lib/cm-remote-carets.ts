// Remote carets for the Prompt Draft editor — the Google-docs treatment, from
// position-only awareness. Pure CodeMirror: no React, no store.
//
// Each caret is painted in its person's identity hue (`peerTone` in
// `derive.ts`, the package's `hueFor`) through the `bg-hue-*` utilities, so a
// theme switch recolours every caret through CSS without rebuilding the
// editor, and the flag's ink is the theme's own background.

import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { LabelTone } from "@tryatlas/design";
import { INK } from "./derive";

export interface CaretInfo {
  userId: string;
  cursor: number;
  name: string;
  tone: LabelTone;
}

export const setRemoteCarets = StateEffect.define<CaretInfo[]>();

class CaretWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly tone: LabelTone,
  ) {
    super();
  }
  override eq(other: CaretWidget): boolean {
    return other.name === this.name && other.tone === this.tone;
  }
  toDOM(): HTMLElement {
    const ink = INK[this.tone].bg;
    const wrap = document.createElement("span");
    wrap.className = "atlas-remote-caret";
    wrap.style.cssText =
      "position:relative;display:inline-block;width:0;height:1em;vertical-align:text-bottom;";
    const bar = document.createElement("span");
    bar.className = `${ink} rounded-full`;
    bar.style.cssText = "position:absolute;left:-1px;top:0;bottom:-2px;width:2px;";
    const flag = document.createElement("span");
    flag.textContent = this.name;
    flag.className = `${ink} text-background text-3xs font-medium rounded-sm rounded-bl-none whitespace-nowrap pointer-events-none select-none`;
    flag.style.cssText = "position:absolute;left:-1px;top:-14px;padding:0 4px;line-height:13px;";
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
export const remoteCaretField = StateField.define<DecorationSet>({
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
                widget: new CaretWidget(c.name, c.tone),
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
