import { useEffect, useState } from "react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import { cn } from "@/lib/utils";
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
} from "lucide-react";

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

  if (!editor) return null;

  const tool = (props: {
    title: string;
    icon: typeof Bold;
    isActive?: boolean;
    onClick: () => void;
  }) => {
    const Icon = props.icon;
    return (
      <button
        type="button"
        title={props.title}
        onMouseDown={(e) => {
          e.preventDefault();
          props.onClick();
        }}
        className={cn("atlas-bubble-btn", props.isActive && "is-active")}
      >
        <Icon size={13} strokeWidth={1.7} />
      </button>
    );
  };

  return (
    <BubbleMenu editor={editor} options={{ placement: "top" }} className="atlas-bubble-wrap">
      {linkOpen ? (
        <div className="atlas-bubble-link">
          <input
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
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().unsetLink().run();
              setLinkOpen(false);
              setLinkUrl("");
            }}
            className="atlas-bubble-btn"
            title="Remove link"
          >
            ×
          </button>
        </div>
      ) : (
        <>
          {tool({
            title: "Bold (⌘B)",
            icon: Bold,
            isActive: editor.isActive("bold"),
            onClick: () => editor.chain().focus().toggleBold().run(),
          })}
          {tool({
            title: "Italic (⌘I)",
            icon: Italic,
            isActive: editor.isActive("italic"),
            onClick: () => editor.chain().focus().toggleItalic().run(),
          })}
          {tool({
            title: "Underline (⌘U)",
            icon: Underline,
            isActive: editor.isActive("underline"),
            onClick: () => editor.chain().focus().toggleUnderline().run(),
          })}
          {tool({
            title: "Strike",
            icon: Strikethrough,
            isActive: editor.isActive("strike"),
            onClick: () => editor.chain().focus().toggleStrike().run(),
          })}
          {tool({
            title: "Inline code (`)",
            icon: Code,
            isActive: editor.isActive("code"),
            onClick: () => editor.chain().focus().toggleCode().run(),
          })}
          <span className="atlas-bubble-sep" />
          {tool({
            title: "Link (⌘K)",
            icon: LinkIcon,
            isActive: editor.isActive("link"),
            onClick: () => {
              const existing = editor.getAttributes("link").href as string | undefined;
              setLinkUrl(existing ?? "");
              setLinkOpen(true);
            },
          })}
          {tool({
            title: "H1",
            icon: Heading1,
            isActive: editor.isActive("heading", { level: 1 }),
            onClick: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
          })}
          {tool({
            title: "H2",
            icon: Heading2,
            isActive: editor.isActive("heading", { level: 2 }),
            onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          })}
          {tool({
            title: "Bullet list",
            icon: List,
            isActive: editor.isActive("bulletList"),
            onClick: () => editor.chain().focus().toggleBulletList().run(),
          })}
          {tool({
            title: "Quote",
            icon: Quote,
            isActive: editor.isActive("blockquote"),
            onClick: () => editor.chain().focus().toggleBlockquote().run(),
          })}
          <span className="atlas-bubble-sep" />
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
  );
}
