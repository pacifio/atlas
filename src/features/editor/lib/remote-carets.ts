import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { avatarHue } from "@/features/comms/lib/derive";

/**
 * Remote carets — the Google-docs treatment, from position-only awareness.
 * Shared by the Prompt Draft editor and the code editor in a Shared Thread
 * (ATL-407): dispatch `setRemoteCarets` with everyone else's carets, and the
 * field keeps each riding its text as the document changes in between.
 */

export interface CaretInfo {
  userId: string;
  cursor: number;
  name: string;
}

export const setRemoteCarets = StateEffect.define<CaretInfo[]>();

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
    // ratchet-allow: a collaborator's own caret hue, assigned per session.
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
      // ratchet-allow: white on that saturated caret hue, which is not a theme surface.
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
