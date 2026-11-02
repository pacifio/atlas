// The agent composer's editor: the shared composer core with one chip of its
// own, and the `@` picker over it.
//
// A mention is a chip in the document carrying the whole `Mention` record. Its
// text is `@label`, which is what the message's text says; the records ride
// beside it in `mentions` (the contract: "the composer writes each into
// `text` as `@label` and sends what it names in `mentions`"). Deleting a chip
// deletes the mention, so text and mentions never disagree.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  BookMarked,
  FileText,
  FolderKanban,
  Hash,
  Link2,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Monitor,
  PenTool,
  Repeat,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";

import {
  ComposerChip,
  createChipNode,
  type ComposerChipViewProps,
} from "@/components/composer/composer-chip";
import { docChips, type ComposerSerializer } from "@/components/composer/composer-doc";
import { ComposerEditor, type ComposerEditorHandle } from "@/components/composer/composer-editor";
import type {
  ComposerKeyInterceptor,
  ComposerTrigger,
  ComposerTriggerSpec,
} from "@/components/composer/composer-triggers";
import { cn } from "@/lib/utils";

import { mentionsToSend, searchMentionGroups, type MentionGroup } from "../lib/org-agent-mentions";
import type { Mention, MentionKind } from "../lib/org-agent-types";

const CHIP = "orgAgentMention";

export const MENTION_ICON: Record<MentionKind, LucideIcon> = {
  person: User,
  conversation: Hash,
  project: FolderKanban,
  session: FileText,
  message: MessageSquare,
  comment: MessageSquare,
  ask: Sparkles,
  rc_room: Monitor,
  thread: MessagesSquare,
  file: FileText,
  draft: FileText,
  loop: Repeat,
  fact: BookMarked,
  space_page: PenTool,
};

const KINDS = new Set<string>(Object.keys(MENTION_ICON));

/** A chip's record as it may come back through HTML: checked, never trusted. */
function mentionFromRecord(r: Record<string, unknown>): Mention | null {
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
  if (typeof r.id !== "string" || !/^[^\s<>"]{1,200}$/.test(r.id)) return null;
  if (typeof r.label !== "string" || !r.label.trim()) return null;
  return {
    kind: r.kind as MentionKind,
    id: r.id,
    label: r.label.slice(0, 120),
    ...(typeof r.handle === "string" ? { handle: r.handle } : {}),
    ...(Array.isArray(r.within)
      ? { within: r.within.filter((w): w is string => typeof w === "string").slice(0, 2) }
      : {}),
  };
}

function MentionChipView({ data, selected }: ComposerChipViewProps<Mention>) {
  const Glyph = MENTION_ICON[data.kind] ?? AtSign;
  return (
    <ComposerChip
      icon={<Glyph size={11} />}
      label={data.label}
      selected={selected}
      title={data.handle ?? data.kind.replace("_", " ")}
      data-kind={data.kind}
    />
  );
}

const MentionNode = createChipNode<Mention>({
  name: CHIP,
  toText: (m) => `@${m.label}`,
  view: MentionChipView,
  fromHTML: mentionFromRecord,
});

const EXTENSIONS = [MentionNode];

/** Text is plain text: a typed `@name` is only a mention once it is picked. */
const SERIALIZER: ComposerSerializer = {
  tokenize: (lines) => lines.map((line) => (line ? [{ type: "text", text: line }] : [])),
  chipText: (node) => `@${(node.attrs.data as Mention).label}`,
};

export interface OrgAgentInputHandle {
  focus(): void;
  /** The message text, mentions spelled `@label`. */
  getValue(): string;
  /** What the text's chips name, once each, in reading order. */
  getMentions(): Mention[];
  clear(): void;
  insertText(text: string): void;
}

export const OrgAgentInput = forwardRef<
  OrgAgentInputHandle,
  {
    orgId: string | null;
    placeholder: string;
    enterToSend: boolean;
    onSubmit: () => void;
    onEmptyChange: (empty: boolean) => void;
  }
>(function OrgAgentInput({ orgId, placeholder, enterToSend, onSubmit, onEmptyChange }, ref) {
  const inner = useRef<ComposerEditorHandle>(null);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [groups, setGroups] = useState<MentionGroup[] | null>(null);
  const [index, setIndex] = useState(0);
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;

  useImperativeHandle(
    ref,
    (): OrgAgentInputHandle => ({
      focus: () => inner.current?.focus(),
      getValue: () => inner.current?.getValue() ?? "",
      getMentions: () => {
        const editor = inner.current?.editor();
        if (!editor) return [];
        return mentionsToSend(docChips(editor.state.doc, CHIP).map((n) => n.attrs.data as Mention));
      },
      clear: () => inner.current?.clear(),
      insertText: (text) => inner.current?.insertText(text),
    }),
    [],
  );

  const triggers = useMemo((): ComposerTriggerSpec[] => [{ chars: "@", onChange: setTrigger }], []);

  // The picker's groups for what follows the `@`, a beat after typing stops.
  const query = trigger?.query ?? null;
  useEffect(() => {
    if (query === null || !orgId) {
      setGroups(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void searchMentionGroups(query, orgId)
        .then((g) => {
          if (!live) return;
          setGroups(g);
          setIndex(0);
        })
        .catch(() => live && setGroups([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, orgId]);

  const flat = useMemo(() => (groups ?? []).flatMap((g) => g.options), [groups]);

  const pick = useCallback((mention: Mention) => {
    const t = triggerRef.current;
    if (!t) return;
    inner.current?.insertChip(CHIP, mention, { from: t.from, to: t.to });
    setTrigger(null);
  }, []);

  const keyInterceptor = useCallback<ComposerKeyInterceptor>(
    (key) => {
      if (!triggerRef.current) return false;
      if (key === "Escape") {
        setTrigger(null);
        return true;
      }
      if (flat.length === 0) return false;
      if (key === "Down") {
        setIndex((i) => (i + 1) % flat.length);
        return true;
      }
      if (key === "Up") {
        setIndex((i) => (i - 1 + flat.length) % flat.length);
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        const option = flat[Math.min(index, flat.length - 1)];
        if (option) pick(option.mention);
        return true;
      }
      return false;
    },
    [flat, index, pick],
  );

  const host = useRef<HTMLDivElement>(null);
  return (
    <div ref={host}>
      <ComposerEditor
        ref={inner}
        extensions={EXTENSIONS}
        serializer={SERIALIZER}
        placeholder={placeholder}
        ariaLabel="Message Atlas"
        className="atlas-chat-composer"
        enterToSend={enterToSend}
        onSubmit={onSubmit}
        onEmptyChange={onEmptyChange}
        triggers={triggers}
        keyInterceptor={trigger ? keyInterceptor : null}
      />
      {trigger &&
        createPortal(
          <MentionPicker
            anchor={trigger.anchor}
            host={host}
            groups={groups}
            active={Math.min(index, Math.max(0, flat.length - 1))}
            hasOrg={!!orgId}
            onHover={(i) => setIndex(i)}
            onPick={pick}
          />,
          document.body,
        )}
    </div>
  );
});

/** The `@` picker: one group per kind of thing, opening upward from the `@`. */
function MentionPicker({
  anchor,
  host,
  groups,
  active,
  hasOrg,
  onHover,
  onPick,
}: {
  anchor: { x: number; y: number };
  /** The editor: the picker sits above it, wherever it has moved to. */
  host: React.RefObject<HTMLDivElement | null>;
  groups: MentionGroup[] | null;
  active: number;
  hasOrg: boolean;
  onHover: (i: number) => void;
  onPick: (m: Mention) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  // The anchor is where the `@` was when it was typed; the composer grows
  // under it as it opens (capsule to card, the tray unfolding), so the
  // picker follows the editor's live top instead of a stale point.
  const [top, setTop] = useState(anchor.y);
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      const rect = host.current?.getBoundingClientRect();
      if (rect) setTop((t) => (Math.abs(t - rect.top) > 0.5 ? rect.top : t));
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [host]);
  let i = -1;
  const width = 300;
  const left = Math.max(8, Math.min(anchor.x - 8, window.innerWidth - width - 8));
  return (
    <div
      role="listbox"
      aria-label="Mention"
      data-slot="org-agent-mention-picker"
      // Above the `@`, so the text being typed stays visible.
      style={{ left, bottom: window.innerHeight - Math.min(top, anchor.y) + 8, width }}
      className="fixed z-popover flex max-h-80 flex-col overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div ref={list} className="overflow-y-auto p-1">
        {!hasOrg ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Connect to an organisation to mention things.
          </p>
        ) : groups === null ? (
          <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 size={11} className="animate-spin" />
            Looking…
          </p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing matches.</p>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="flex flex-col">
              <p className="px-2 pt-1.5 pb-0.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
                {g.heading}
              </p>
              {g.options.map((o) => {
                i += 1;
                const at = i;
                const Glyph = g.key === "link" ? Link2 : (MENTION_ICON[o.mention.kind] ?? AtSign);
                return (
                  <button
                    key={o.key}
                    type="button"
                    role="option"
                    aria-selected={at === active}
                    data-index={at}
                    onMouseEnter={() => onHover(at)}
                    onClick={() => onPick(o.mention)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left",
                      at === active ? "bg-element-selected" : "hover:bg-element-hover",
                    )}
                  >
                    <Glyph size={12} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs">{o.mention.label}</span>
                    {o.detail && (
                      <span className="max-w-28 shrink-0 truncate text-2xs text-muted-foreground">
                        {o.detail}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
