import { useEffect, useState } from "react";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import { sendToAgentChat } from "@/features/chat/lib/send-to-agent";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link as LinkIcon,
  Heading1,
  Heading2,
  List,
  Quote,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { HintGroup, HintItem, Hint, Input, Separator, iconButtonVariants } from "@tryatlas/design";

const TOOL = iconButtonVariants({ variant: "ghost", size: "md" });

interface AtlasBubbleMenuProps {
  editor: Editor | null;
}

/**
 * Matches `atlas-knowledge.jsx::BubbleMenu` (lines 437–490). Floats
 * above the current text selection with the standard formatting tools,
 * a divider, then block-conversion shortcuts. Built on Tiptap v3's
 * `BubbleMenu` React wrapper (Floating UI under the hood) — no Tippy.
 *
 * "Ask Claude" omitted: AI features are out of scope this round.
 */
export function AtlasBubbleMenu({ editor }: AtlasBubbleMenuProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  // Reset link input when the editor reports a different selection.
  useEffect(() => {
    if (!editor) return;
    const reset = () => {
      setLinkOpen(false);
      setLinkUrl("");
    };
    editor.on("selectionUpdate", reset);
    return () => {
      editor.off("selectionUpdate", reset);
    };
  }, [editor]);

  // Tiptap does not re-render on transactions, so pressed states read in
  // render would go stale; this re-renders when one of them flips.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            code: e.isActive("code"),
            link: e.isActive("link"),
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            bulletList: e.isActive("bulletList"),
            blockquote: e.isActive("blockquote"),
          }
        : null,
  });

  if (!editor || !active) return null;

  const tool = (props: {
    title: string;
    icon: typeof Bold;
    isActive?: boolean;
    onClick: () => void;
  }) => {
    const Icon = props.icon;
    return (
      <HintItem label={props.title}>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            props.onClick();
          }}
          aria-pressed={props.isActive}
          className={TOOL}
        >
          <Icon className="size-3.5" strokeWidth={1.7} />
        </button>
      </HintItem>
    );
  };

  return (
    // The menu sits above the selection, so its tooltips open upward too and
    // never cover the selected text.
    <HintGroup side="top">
      <BubbleMenu
        editor={editor}
        options={{ placement: "top" }}
        // The package menu surface (`DropdownMenuContent`'s tokens) without its
        // scroll and entrance animation: a selection toolbar tracks the
        // selection and should not pop on every drag.
        className="z-popover flex items-center gap-px rounded-lg border border-border bg-popover p-0.5 text-foreground shadow-md"
      >
        {linkOpen ? (
          <div className="flex items-center gap-1 px-0.5">
            <Input
              size="sm"
              className="w-[220px]"
              value={linkUrl}
              placeholder="https://…"
              autoFocus
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (linkUrl.trim()) {
                    editor
                      .chain()
                      .focus()
                      .extendMarkRange("link")
                      .setLink({ href: linkUrl.trim() })
                      .run();
                  }
                  setLinkOpen(false);
                  setLinkUrl("");
                } else if (e.key === "Escape") {
                  setLinkOpen(false);
                  setLinkUrl("");
                }
              }}
            />
            <Hint label="Remove link" side="top">
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  editor.chain().focus().unsetLink().run();
                  setLinkOpen(false);
                  setLinkUrl("");
                }}
                className={iconButtonVariants({ variant: "ghost", size: "xs" })}
              >
                <X className="size-3" />
              </button>
            </Hint>
          </div>
        ) : (
          <>
            {tool({
              title: "Bold",
              icon: Bold,
              isActive: active.bold,
              onClick: () => editor.chain().focus().toggleBold().run(),
            })}
            {tool({
              title: "Italic (⌘I)",
              icon: Italic,
              isActive: active.italic,
              onClick: () => editor.chain().focus().toggleItalic().run(),
            })}
            {tool({
              title: "Underline (⌘U)",
              icon: Underline,
              isActive: active.underline,
              onClick: () => editor.chain().focus().toggleUnderline().run(),
            })}
            {tool({
              title: "Strike",
              icon: Strikethrough,
              isActive: active.strike,
              onClick: () => editor.chain().focus().toggleStrike().run(),
            })}
            {tool({
              title: "Inline code (`)",
              icon: Code,
              isActive: active.code,
              onClick: () => editor.chain().focus().toggleCode().run(),
            })}
            <Separator orientation="vertical" className="mx-0.5 h-4" />
            {tool({
              title: "Link",
              icon: LinkIcon,
              isActive: active.link,
              onClick: () => {
                const existing = editor.getAttributes("link").href as string | undefined;
                setLinkUrl(existing ?? "");
                setLinkOpen(true);
              },
            })}
            {tool({
              title: "H1",
              icon: Heading1,
              isActive: active.h1,
              onClick: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
            })}
            {tool({
              title: "H2",
              icon: Heading2,
              isActive: active.h2,
              onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
            })}
            {tool({
              title: "Bullet list",
              icon: List,
              isActive: active.bulletList,
              onClick: () => editor.chain().focus().toggleBulletList().run(),
            })}
            {tool({
              title: "Quote",
              icon: Quote,
              isActive: active.blockquote,
              onClick: () => editor.chain().focus().toggleBlockquote().run(),
            })}
            <Separator orientation="vertical" className="mx-0.5 h-4" />
            {tool({
              title: "Send selection to chat",
              icon: MessageSquarePlus,
              onClick: () => {
                const { from, to } = editor.state.selection;
                const text = editor.state.doc.textBetween(from, to, "\n").trim();
                if (!text) return;
                sendToAgentChat(text);
              },
            })}
          </>
        )}
      </BubbleMenu>
    </HintGroup>
  );
}
