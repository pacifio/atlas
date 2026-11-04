import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";
import { Hint, calloutVariants } from "@tryatlas/design";
import { cn } from "@/lib/utils";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { emoji?: string }) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

/**
 * Atlas Callout — the design's `<Callout>` (atlas-knowledge.jsx:605–624).
 * Emoji on the left, `border-left: 2px solid var(--fg)`. Body is fully
 * editable inline. Round-trips through markdown as raw HTML
 * (`<aside class="atlas-callout" data-emoji="…">…</aside>`); tiptap-
 * markdown's html mode preserves it on parse via parseHTML.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: "💡",
        parseHTML: (el) => el.getAttribute("data-emoji") ?? "💡",
        renderHTML: (attrs) => ({ "data-emoji": attrs.emoji as string }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: "aside.atlas-callout" },
      // Friendly fallback for legacy `<div data-callout="true">` if we
      // ever export to that shape (we don't today).
      { tag: "div[data-callout]" },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["aside", mergeAttributes(HTMLAttributes, { class: "atlas-callout" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },

  // Register tiptap-markdown serializer. We emit a raw HTML block so
  // markdown-it (in html mode) can round-trip the structure on reload.
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            renderContent: (n: unknown) => void;
            closeBlock: (n: unknown) => void;
          },
          node: { attrs: { emoji?: string } },
        ) {
          const emoji = node.attrs.emoji ?? "💡";
          state.write(`<aside class="atlas-callout" data-emoji="${emoji}">\n\n`);
          state.renderContent(node);
          state.write(`\n</aside>`);
          state.closeBlock(node);
        },
        parse: {
          // markdown-it html mode handles re-parsing the <aside> tag.
        },
      },
    };
  },
});

function CalloutView({ node, updateAttributes }: NodeViewProps) {
  const emoji = (node.attrs.emoji as string) || "💡";
  // Edited in place: the shipped app's webview has no `window.prompt`.
  const [editing, setEditing] = useState(false);
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim()) updateAttributes({ emoji: value.trim() });
  };
  return (
    // The package callout's neutral surface, laid out as emoji | body.
    <NodeViewWrapper
      className={cn(
        calloutVariants({ tone: "neutral" }),
        "mt-2 mb-3 grid grid-cols-[auto_1fr] gap-3 text-base/relaxed",
      )}
    >
      {editing ? (
        <input
          contentEditable={false}
          aria-label="Emoji"
          maxLength={8}
          autoFocus
          defaultValue={emoji}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          className="w-8 bg-transparent text-lg leading-snug outline-none"
        />
      ) : (
        <Hint label="Change emoji">
          <button
            type="button"
            contentEditable={false}
            className="cursor-pointer select-none text-lg leading-snug"
            onClick={() => setEditing(true)}
          >
            {emoji}
          </button>
        </Hint>
      )}
      <NodeViewContent className="atlas-callout-body text-secondary-foreground" />
    </NodeViewWrapper>
  );
}
