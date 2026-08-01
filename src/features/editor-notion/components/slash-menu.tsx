import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Code,
  Minus,
  Image as ImageIcon,
  Table as TableIcon,
  AtSign,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Editor, Range } from "@tiptap/core";

export interface SlashItem {
  id: string;
  group: string;
  title: string;
  hint: string;
  kbd?: string;
  icon: LucideIcon;
  /** Imperative command run when the user picks the item. The range
   *  argument is the slash trigger's range so the command can replace
   *  it with the new block. */
  command: (props: { editor: Editor; range: Range }) => void;
}

export interface SlashMenuRef {
  /** Forwarded from the suggestion plugin onKeyDown — returns true if
   *  the key was handled (so the editor doesn't see it). */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  // ── Basic ────────────────────────────────────────────────────────
  {
    id: "p",
    group: "Basic",
    title: "Text",
    hint: "Plain paragraph",
    icon: Type,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "h1",
    group: "Basic",
    title: "Heading 1",
    hint: "Big section title",
    kbd: "# space",
    icon: Heading1,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 1 })
        .run(),
  },
  {
    id: "h2",
    group: "Basic",
    title: "Heading 2",
    hint: "Medium section",
    kbd: "## space",
    icon: Heading2,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 2 })
        .run(),
  },
  {
    id: "h3",
    group: "Basic",
    title: "Heading 3",
    hint: "Small section",
    kbd: "### space",
    icon: Heading3,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 3 })
        .run(),
  },
  {
    id: "ul",
    group: "Basic",
    title: "Bullet list",
    hint: "Bulleted items",
    kbd: "- space",
    icon: List,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "ol",
    group: "Basic",
    title: "Numbered list",
    hint: "Ordered items",
    kbd: "1. space",
    icon: ListOrdered,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  // ── Rich ─────────────────────────────────────────────────────────
  {
    id: "todo",
    group: "Rich",
    title: "To-do",
    hint: "Checkboxes",
    kbd: "[] space",
    icon: CheckSquare,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: "toggle",
    group: "Rich",
    title: "Toggle",
    hint: "Collapsible section",
    icon: Quote,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setToggle().run(),
  },
  {
    id: "quote",
    group: "Rich",
    title: "Quote",
    hint: "Indented quote",
    kbd: "> space",
    icon: Quote,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: "callout",
    group: "Rich",
    title: "Callout",
    hint: "Highlighted block",
    icon: Quote,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setCallout().run(),
  },
  {
    id: "divider",
    group: "Rich",
    title: "Divider",
    hint: "Horizontal rule",
    kbd: "---",
    icon: Minus,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    id: "code",
    group: "Rich",
    title: "Code block",
    hint: "Syntax-highlighted",
    kbd: "``` space",
    icon: Code,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  // ── Embed ────────────────────────────────────────────────────────
  {
    id: "table",
    group: "Embed",
    title: "Table",
    hint: "Inline grid",
    icon: TableIcon,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: "img",
    group: "Embed",
    title: "Image",
    hint: "Paste a URL",
    icon: ImageIcon,
    // Phase D will wire a real image upload. For now insert a placeholder
    // link that the user can swap to a URL.
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent("![alt](url)")
        .run(),
  },
  {
    id: "mention",
    group: "Embed",
    title: "Mention",
    hint: "Person, page or commit",
    kbd: "@",
    icon: AtSign,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent("@").run(),
  },
];

export function filterSlashItems(
  query: string,
  items: SlashItem[] = SLASH_ITEMS,
): SlashItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.id.toLowerCase().includes(q) ||
      it.hint.toLowerCase().includes(q),
  );
}

export const SlashMenu = forwardRef<SlashMenuRef, SlashMenuProps>(
  function SlashMenu({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event) => {
          if (event.key === "ArrowDown") {
            setSelectedIndex((i) => (i + 1) % Math.max(1, items.length));
            return true;
          }
          if (event.key === "ArrowUp") {
            setSelectedIndex(
              (i) => (i - 1 + items.length) % Math.max(1, items.length),
            );
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = items[selectedIndex];
            if (item) command(item);
            return true;
          }
          return false;
        },
      }),
      [items, selectedIndex, command],
    );

    useLayoutEffect(() => {
      const active = listRef.current?.querySelector(
        `[data-idx="${selectedIndex}"]`,
      ) as HTMLElement | null;
      active?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    if (items.length === 0) {
      return (
        <div
          className="atlas-slash-menu empty"
          style={{
            width: 280,
            padding: "10px 12px",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          No matches
        </div>
      );
    }

    // Group items by their `group` field preserving first-seen order.
    const groups: { label: string; items: SlashItem[] }[] = [];
    const seen = new Map<string, SlashItem[]>();
    for (const it of items) {
      if (!seen.has(it.group)) {
        const arr: SlashItem[] = [];
        seen.set(it.group, arr);
        groups.push({ label: it.group, items: arr });
      }
      seen.get(it.group)!.push(it);
    }

    let flat = -1;
    return (
      <div className="atlas-slash-menu" ref={listRef}>
        {groups.map((g) => (
          <div key={g.label} className="atlas-slash-group">
            <div className="atlas-slash-eyebrow">{g.label}</div>
            {g.items.map((item) => {
              flat += 1;
              const idx = flat;
              const Icon = item.icon;
              const active = idx === selectedIndex;
              return (
                <button
                  key={item.id}
                  data-idx={idx}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    command(item);
                  }}
                  className={cn("atlas-slash-item", active && "is-active")}
                >
                  <span className="atlas-slash-iconwrap">
                    <Icon size={14} strokeWidth={1.6} />
                  </span>
                  <span className="atlas-slash-body">
                    <span className="atlas-slash-title">{item.title}</span>
                    <span className="atlas-slash-hint">{item.hint}</span>
                  </span>
                  {item.kbd ? (
                    <span className="atlas-slash-kbd mono">{item.kbd}</span>
                  ) : (
                    <ChevronRight
                      size={11}
                      className="atlas-slash-chev"
                      strokeWidth={1.6}
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
);
