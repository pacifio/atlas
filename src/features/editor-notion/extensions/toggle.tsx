import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Hint, iconButtonVariants } from "@tryatlas/design";
import { cn } from "@/lib/utils";

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

const TITLE = "flex-1 bg-transparent text-left text-md font-medium text-foreground outline-none";
const BODY = "mt-1 ml-3 border-l border-border-subtle pl-7";

function ToggleView({ node, updateAttributes }: NodeViewProps) {
  const open = Boolean(node.attrs.open);
  const title = (node.attrs.title as string) || "Untitled";
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(title);

  return (
    <NodeViewWrapper className="my-2.5" data-open={open ? "true" : "false"}>
      <div
        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-md text-foreground hover:bg-element-hover"
        contentEditable={false}
      >
        <Hint label={open ? "Collapse" : "Expand"}>
          <button
            type="button"
            className={iconButtonVariants({ variant: "ghost", size: "xs" })}
            onClick={() => updateAttributes({ open: !open })}
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform duration-fast ease-out-strong motion-reduce:transition-none",
                open && "rotate-90",
              )}
              strokeWidth={1.7}
            />
          </button>
        </Hint>
        {editingTitle ? (
          <input
            className={TITLE}
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
            className={cn(TITLE, "cursor-text")}
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
        <NodeViewContent className={BODY} />
      ) : (
        // Keep ProseMirror happy by mounting a hidden NodeViewContent so
        // the children stay in the doc; visibility is just CSS-toggled.
        <NodeViewContent className={cn(BODY, "hidden")} />
      )}
    </NodeViewWrapper>
  );
}
