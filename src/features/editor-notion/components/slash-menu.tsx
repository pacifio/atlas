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
  ListCollapse,
  Lightbulb,
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

// The menu chrome is the package dropdown menu's (`DropdownMenuContent`,
// `DropdownMenuLabel`, `DropdownMenuItem`, `DropdownMenuShortcut`). Those are
// Base UI components that take focus and need a React tree with their
// providers; this menu renders into the slash popup's own root and must never
// steal focus from the editor, so it borrows their class strings instead.
// copy of @tryatlas/design dropdown-menu POPUP: not exported as of 0.1.8.
// Minus `animate-scale-in`: the menu opens on a keystroke, many times a day,
// and a keyboard-invoked surface appears at once.
const MENU_POPUP =
  "overflow-y-auto overflow-x-hidden rounded-lg p-0.5 bg-popover border border-border text-foreground shadow-md";
// copy of @tryatlas/design DropdownMenuLabel: not exported as of 0.1.8.
const MENU_LABEL = "eyebrow px-2 py-1 text-muted-foreground";
// copy of @tryatlas/design dropdown-menu ITEM: not exported as of 0.1.8.
// `data-active` stands in for `focus:` — the row is highlighted, never focused.
const MENU_ITEM =
  "relative flex items-center gap-2 rounded px-2 py-1 text-xs cursor-pointer select-none outline-none text-secondary-foreground data-active:bg-element-hover data-active:text-foreground";
// copy of @tryatlas/design DropdownMenuShortcut: not exported as of 0.1.8.
const MENU_SHORTCUT = "ml-auto pl-3 text-3xs text-disabled";

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
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "h1",
    group: "Basic",
    title: "Heading 1",
    hint: "Big section title",
    kbd: "# space",
    icon: Heading1,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    group: "Basic",
    title: "Heading 2",
    hint: "Medium section",
    kbd: "## space",
    icon: Heading2,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    group: "Basic",
    title: "Heading 3",
    hint: "Small section",
    kbd: "### space",
    icon: Heading3,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
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
    icon: ListCollapse,
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setToggle().run(),
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
    icon: Lightbulb,
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setCallout().run(),
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
      editor.chain().focus().deleteRange(range).insertContent("![alt](url)").run(),
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

export function filterSlashItems(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.id.toLowerCase().includes(q) ||
      it.hint.toLowerCase().includes(q),
  );
}

export const SlashMenu = forwardRef<SlashMenuRef, SlashMenuProps>(function SlashMenu(
  { items, command },
  ref,
) {
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
          setSelectedIndex((i) => (i - 1 + items.length) % Math.max(1, items.length));
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
      <div className={cn(MENU_POPUP, "w-[280px]")}>
        <div className="px-2 py-1.5 text-xs text-muted-foreground">No matches</div>
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
  // 280 x 360 px are the box `positionPopup` (slash-suggestion.tsx) clamps to
  // the viewport. Pixels on purpose: the spacing scale is rem-based and the
  // app's root is 13px, so `w-70` would come out at 228px.
  return (
    <div className={cn(MENU_POPUP, "max-h-[360px] w-[280px]")} ref={listRef}>
      {groups.map((g) => (
        <div key={g.label} className="py-0.5">
          <div className={MENU_LABEL}>{g.label}</div>
          {g.items.map((item) => {
            flat += 1;
            const idx = flat;
            const Icon = item.icon;
            const active = idx === selectedIndex;
            return (
              <button
                key={item.id}
                type="button"
                data-idx={idx}
                data-active={active || undefined}
                onMouseEnter={() => setSelectedIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  command(item);
                }}
                className={cn(MENU_ITEM, "w-full text-left")}
              >
                <span className="flex size-control-sm shrink-0 items-center justify-center rounded-md border border-border-subtle bg-card">
                  <Icon className="size-3.5" strokeWidth={1.6} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-xs text-foreground">{item.title}</span>
                  <span className="text-2xs text-muted-foreground">{item.hint}</span>
                </span>
                {item.kbd ? (
                  <span className={cn(MENU_SHORTCUT, "font-mono")}>{item.kbd}</span>
                ) : (
                  <ChevronRight className="size-3 text-muted-foreground" strokeWidth={1.6} />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});
