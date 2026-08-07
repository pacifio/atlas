import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";
import { ChevronRight } from "lucide-react";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toggle: {
      setToggle: (attrs?: { title?: string; open?: boolean }) => ReturnType;
    };
  }
}

/**
 * Atlas Toggle — matches `atlas-knowledge.jsx::Toggle` (lines 667–692).
 * A chevron + clickable summary; the body is editable when open.
 * Round-trips through markdown as `<details><summary>…</summary>…</details>`
 * (real GFM HTML), so the file remains readable in any markdown tool.
 */
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      title: {
        default: "Untitled",
        parseHTML: (el) => el.querySelector("summary")?.textContent?.trim() ?? "Untitled",
      },
      open: {
        default: true,
        parseHTML: (el) => el.hasAttribute("open"),
      },
    };
  },

  parseHTML() {
    return [{ tag: "details" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "details",
      mergeAttributes(HTMLAttributes, {
        class: "atlas-toggle",
        ...(node.attrs.open ? { open: "" } : {}),
      }),
      ["summary", { class: "atlas-toggle-summary" }, node.attrs.title as string],
      ["div", { class: "atlas-toggle-body" }, 0],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },

  addCommands() {
    return {
      setToggle:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            renderContent: (n: unknown) => void;
            closeBlock: (n: unknown) => void;
          },
          node: { attrs: { title?: string; open?: boolean } },
        ) {
          const title = (node.attrs.title || "Untitled").replace(/</g, "&lt;");
          const open = node.attrs.open ? " open" : "";
          state.write(`<details${open}>\n<summary>${title}</summary>\n\n`);
          state.renderContent(node);
          state.write(`\n</details>`);
          state.closeBlock(node);
        },
        parse: {
          // markdown-it html mode parses <details> back into the node.
        },
      },
    };
  },
});

function ToggleView({ node, updateAttributes }: NodeViewProps) {
  const open = Boolean(node.attrs.open);
  const title = (node.attrs.title as string) || "Untitled";
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(title);

  return (
    <NodeViewWrapper className="atlas-toggle" data-open={open ? "true" : "false"}>
      <div className="atlas-toggle-header" contentEditable={false}>
        <button
          type="button"
          className="atlas-toggle-chev"
          onClick={() => updateAttributes({ open: !open })}
          title={open ? "Collapse" : "Expand"}
        >
          <ChevronRight
            size={12}
            strokeWidth={1.7}
            style={{
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 120ms",
            }}
          />
        </button>
        {editingTitle ? (
          <input
            className="atlas-toggle-title-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              updateAttributes({ title: draft.trim() || "Untitled" });
              setEditingTitle(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                updateAttributes({ title: draft.trim() || "Untitled" });
                setEditingTitle(false);
              } else if (e.key === "Escape") {
                setDraft(title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="atlas-toggle-title"
            onClick={() => {
              setDraft(title);
              setEditingTitle(true);
            }}
            title="Click to rename"
          >
            {title}
          </button>
        )}
      </div>
      {open ? (
        <NodeViewContent className="atlas-toggle-body" />
      ) : (
        // Keep ProseMirror happy by mounting a hidden NodeViewContent so
        // the children stay in the doc; visibility is just CSS-toggled.
        <NodeViewContent className="atlas-toggle-body" style={{ display: "none" }} />
      )}
    </NodeViewWrapper>
  );
}
