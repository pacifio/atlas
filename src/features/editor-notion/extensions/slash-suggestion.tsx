import { Extension } from "@tiptap/core";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { createRoot } from "react-dom/client";
import {
  SLASH_ITEMS,
  SlashMenu,
  filterSlashItems,
  type SlashItem,
  type SlashMenuRef,
} from "../components/slash-menu";
import type { ComponentType } from "react";

/**
 * Tiptap extension that registers a `/` trigger and pops up the Atlas
 * slash menu. Built on @tiptap/suggestion + a small portal renderer.
 *
 * The popup renders into a div appended to document.body so the menu
 * isn't clipped by the editor's scroll container. Position comes from
 * suggestion's `clientRect()` which tracks the caret.
 */

const SlashPluginKey = new PluginKey("atlas-slash");

interface Popup {
  el: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
  ref: { current: SlashMenuRef | null };
  destroy: () => void;
}

function createPopup(): Popup {
  const el = document.createElement("div");
  el.className = "atlas-slash-popup";
  el.style.position = "absolute";
  el.style.zIndex = "1000";
  el.style.display = "none";
  document.body.appendChild(el);
  const root = createRoot(el);
  const ref: { current: SlashMenuRef | null } = { current: null };
  return {
    el,
    root,
    ref,
    destroy: () => {
      try {
        root.unmount();
      } catch {
        // ignore
      }
      el.remove();
    },
  };
}

function positionPopup(popup: Popup, rect: DOMRect | null) {
  if (!rect) {
    popup.el.style.display = "none";
    return;
  }
  popup.el.style.display = "block";
  const POPUP_W = 280;
  // Anchor 4px below caret, left-align with caret; clamp to viewport.
  const left = Math.min(
    Math.max(8, rect.left),
    window.innerWidth - POPUP_W - 8,
  );
  const top = Math.min(rect.bottom + 4, window.innerHeight - 360);
  popup.el.style.left = `${left}px`;
  popup.el.style.top = `${top}px`;
}

function render(
  popup: Popup,
  items: SlashItem[],
  command: (it: SlashItem) => void,
) {
  // Forwarding the ref through ReactRenderer is finicky; use a plain
  // root + ref callback so onKeyDown can dispatch synchronously.
  const Menu = SlashMenu as ComponentType<{
    items: SlashItem[];
    command: (it: SlashItem) => void;
    ref?: React.Ref<SlashMenuRef>;
  }>;
  popup.root.render(<Menu items={items} command={command} ref={popup.ref} />);
}

export interface SlashExtensionOptions {
  suggestion: Omit<SuggestionOptions<SlashItem>, "editor">;
}

export const Slash = Extension.create<SlashExtensionOptions>({
  name: "atlasSlash",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => filterSlashItems(query, SLASH_ITEMS),
        command: ({ editor, range, props }) => {
          const item = props as unknown as SlashItem;
          item.command({ editor, range });
        },
        render: () => {
          let popup: Popup | null = null;
          return {
            onStart: (props) => {
              popup = createPopup();
              const command = (item: SlashItem) => {
                props.command(item as unknown as never);
              };
              render(popup, props.items as SlashItem[], command);
              positionPopup(popup, props.clientRect?.() ?? null);
            },
            onUpdate: (props) => {
              if (!popup) return;
              const command = (item: SlashItem) => {
                props.command(item as unknown as never);
              };
              render(popup, props.items as SlashItem[], command);
              positionPopup(popup, props.clientRect?.() ?? null);
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                if (popup) {
                  popup.destroy();
                  popup = null;
                }
                return true;
              }
              return popup?.ref.current?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              if (popup) {
                popup.destroy();
                popup = null;
              }
            },
          };
        },
      } satisfies Omit<SuggestionOptions<SlashItem>, "editor">,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: SlashPluginKey,
        ...this.options.suggestion,
      }),
    ];
  },
});
