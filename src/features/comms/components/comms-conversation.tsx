import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronLeft, Hash, Loader2, Lock, Pin, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { GradualBlur } from "@/components/gradual-blur";
import { useTranscriptScroll } from "@/features/chat/lib/use-transcript-scroll";
import { CommsAvatar } from "./comms-avatar";
import { CommsComposer } from "./comms-composer";
import { MessageGroup } from "./message-group";
import { useCommsStore } from "../stores/comms-store";
import {
  conversationTitle,
  dmCounterpart,
  formatDayDivider,
  groupMessages,
  isNewDay,
} from "../lib/derive";
import type { ChatConversation, OrgMemberProfile } from "../types";

/**
 * Writing this to `scrollTop` and letting the browser clamp is the one way to
 * reach the bottom WITHOUT reading `scrollHeight` — which forces a synchronous
 * layout, and was the only layout read left in the scroll path.
 */
const SCROLL_BOTTOM = 1 << 30;

/** Height of the top blur ramp; content padding must clear it. */
const TOP_FADE = 36;

export const CommsConversation = memo(function CommsConversation({
  conv,
}: {
  conv: ChatConversation;
}) {
  const me = useCommsStore.use.me();
  const memberList = useCommsStore.use.members();
  const online = useCommsStore.use.online();
  const messages = useCommsStore((s) => s.messages[conv.id]) ?? EMPTY_MESSAGES;
  const pinned = useCommsStore.use.pinned();
  const typingRoom = useCommsStore((s) => s.typing[conv.id]);
  const loading = useCommsStore((s) => s.loading[conv.id] === true);
  const actions = useCommsStore.use.actions();

  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const lookup = useMemo(() => (id: string) => byId.get(id), [byId]);

  // The whole projection — grouping, day dividers — is computed once per
  // messages change, not once per render. It was ~200 Date/Intl operations
  // inline in JSX before, re-run on every keystroke.
  const groups = useMemo(() => {
    const grouped = groupMessages(messages, me);
    return grouped.map((group, i) => {
      const prevGroup = grouped[i - 1];
      const prev = prevGroup?.messages[prevGroup.messages.length - 1];
      return { group, newDay: isNewDay(prev, group.messages[0]) };
    });
  }, [messages, me]);

  // Stable identities so MessageGroup's memo actually engages — the previous
  // inline arrows gave every group new props on every render, which made the
  // memo 100% dead and every store write a full-transcript repaint.
  const onReply = useCallback((id: string) => actions.setReplyTo(conv.id, id), [actions, conv.id]);
  const onEdit = useCallback((id: string) => actions.beginEdit(conv.id, id), [actions, conv.id]);
  const onDelete = useCallback(
    (id: string) => actions.deleteMessage(conv.id, id),
    [actions, conv.id],
  );

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = SCROLL_BOTTOM;
  }, []);

  // Keep the reader pinned to the live edge through content growth the way the
  // reference clients do: a reaction growing a row, an image resolving its
  // aspect ratio, the composer growing — all of it re-pins when at the end.
  const { more, onScroll, invalidate, atEndRef } = useTranscriptScroll({
    scrollRef: scroller,
    contentRef: content,
    canGrow: false,
    onGrow: () => {},
    onContentResize: () => {
      if (atEndRef.current) {
        const el = scroller.current;
        if (el) el.scrollTop = SCROLL_BOTTOM;
      }
    },
  });

  // Unseen-message count for the pill label. Counted only while away from the
  // live edge; cleared the moment the reader returns.
  const [newCount, setNewCount] = useState(0);
  const prevLen = useRef(messages.length);
  useLayoutEffect(() => {
    const grew = messages.length - prevLen.current;
    prevLen.current = messages.length;
    if (grew > 0 && !atEndRef.current) {
      setNewCount((n) => n + grew);
    }
    if (atEndRef.current) {
      scrollToBottom();
      setNewCount(0);
    }
    invalidate();
  }, [messages.length, atEndRef, invalidate, scrollToBottom]);

  useEffect(() => {
    if (!more && newCount !== 0) setNewCount(0);
  }, [more, newCount]);

  // Jump to the bottom on a conversation switch, and tell the server we are
  // caught up. The badge itself comes back from the server, never from here.
  useEffect(() => {
    scrollToBottom();
    atEndRef.current = true;
    actions.markRead(conv.id);
  }, [conv.id, actions, atEndRef, scrollToBottom]);

  // Keyed by user id with the time they last said so; the store ages entries
  // out, since there is no "stopped typing" frame to wait for.
  const typers = useMemo(
    () => Object.keys(typingRoom ?? {}).filter((id) => id !== me),
    [typingRoom, me],
  );
  const isChannel = conv.kind === "channel";
  const title = conversationTitle(conv, members, me);
  const counterpart = dmCounterpart(conv, members, me);
  const pinnedCount = useMemo(
    () => messages.reduce((n, m) => n + (pinned.includes(m.id) ? 1 : 0), 0),
    [messages, pinned],
  );
  const otherMembers = useMemo(() => memberList.filter((m) => m.id !== me), [memberList, me]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ConversationHeader
        conv={conv}
        title={title}
        counterpart={counterpart}
        online={online}
        members={members}
        me={me}
        pinnedCount={pinnedCount}
        onBack={actions.goHome}
      />

      {/* Overlays are SIBLINGS of the scroller, never inside the content — the
          transcript pattern. `relative` scopes them; nothing here transforms
          (the vibrant-panel rule), and both overlays are pointer-events-none. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <GradualBlur
          position="top"
          height={`${TOP_FADE}px`}
          strength={2}
          layers={4}
          tint="color-mix(in srgb, var(--panel-bg-2) 90%, transparent)"
          style={{ zIndex: 3 }}
        />

        <div
          ref={scroller}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto hide-scrollbar [overflow-anchor:none]"
        >
          <div ref={content} style={{ paddingTop: TOP_FADE / 2, paddingBottom: 10 }}>
            {loading && messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 py-16">
                <Loader2 size={15} className="animate-spin text-text-tertiary" />
                <span className="text-[11px] text-text-secondary">Loading messages…</span>
              </div>
            ) : (
              <ConversationIntro conv={conv} title={title} isChannel={isChannel} />
            )}

            {groups.map(({ group, newDay }) => (
              <Fragment key={group.key}>
                {newDay && <DayDivider at={group.messages[0].created_at} />}
                <MessageGroup
                  messages={group.messages}
                  own={group.own}
                  author={members.get(group.authorId) ?? null}
                  members={members}
                  me={me}
                  lookup={lookup}
                  onReply={onReply}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onReact={actions.react}
                  onPin={actions.togglePin}
                  showAuthor={conv.kind !== "dm"}
                />
              </Fragment>
            ))}

            {typers.length > 0 && (
              <TypingHint names={typers.map((id) => members.get(id)?.name ?? "Someone")} />
            )}
          </div>
        </div>

        {/* Bottom fade. Overshoots by 2px on purpose: at fractional UI scales
            the fade and the scroller bottom round to different device pixels
            and a hairline of text flashes through. Full colour at 72% — a
            two-stop gradient is only ~97% opaque just above the composer and
            text ghosts through on near-black. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute -bottom-[2px] left-0 right-0 z-[1] h-[44px] transition-opacity duration-200",
            more ? "opacity-100" : "opacity-0",
          )}
          style={{
            background:
              "linear-gradient(to bottom, transparent, var(--panel-bg-2) 72%, var(--panel-bg-2))",
          }}
        />
      </div>

      <div className="relative">
        {more && (
          <div className="pointer-events-none absolute bottom-full inset-x-0 mb-2 z-20 flex justify-center">
            <button
              type="button"
              onClick={scrollToBottom}
              title="Jump to latest"
              style={{ backdropFilter: "blur(4px)" }}
              className={cn(
                "atlas-pill-in pointer-events-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5",
                "border border-border-default bg-bg-elevated",
                "text-[11px] font-medium leading-none text-text-secondary",
                "shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-colors cursor-pointer",
                "hover:bg-bg-hover hover:text-text-primary",
              )}
            >
              <ChevronDown size={11} />
              <span>
                {newCount > 0
                  ? `${newCount} new message${newCount === 1 ? "" : "s"}`
                  : "Scroll to bottom"}
              </span>
            </button>
          </div>
        )}

        <CommsComposer
          convId={conv.id}
          members={otherMembers}
          memberMap={members}
          lookup={lookup}
          placeholder={isChannel ? `Message #${conv.name}` : `Message ${title}`}
        />
      </div>
    </div>
  );
});

const EMPTY_MESSAGES: never[] = [];

function ConversationHeader({
  conv,
  title,
  counterpart,
  online,
  members,
  me,
  pinnedCount,
  onBack,
}: {
  conv: ChatConversation;
  title: string;
  counterpart: OrgMemberProfile | null;
  online: string[];
  members: Map<string, OrgMemberProfile>;
  me: string;
  pinnedCount: number;
  onBack: () => void;
}) {
  const isChannel = conv.kind === "channel";
  const isGroup = conv.kind === "group_dm";
  const others = (conv.member_ids ?? []).filter((id) => id !== me);

  return (
    <div className="flex h-[29px] shrink-0 items-center gap-1.5 border-b border-border-default px-1.5">
      {/* Back to the tab's home view — the panel has no sidebar to fall back on. */}
      <button
        type="button"
        title="Back to chats"
        onClick={onBack}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
      >
        <ChevronLeft size={14} />
      </button>
      {isChannel ? (
        conv.visibility === "private" ? (
          <Lock size={11} className="shrink-0 text-text-tertiary" />
        ) : (
          <Hash size={12} className="shrink-0 text-text-tertiary" />
        )
      ) : isGroup ? (
        <Users size={12} className="shrink-0 text-text-tertiary" />
      ) : (
        <CommsAvatar
          member={counterpart}
          size={16}
          online={counterpart ? online.includes(counterpart.id) : false}
        />
      )}
      <span className="min-w-0 truncate text-[11.5px] font-medium text-text-primary">
        {isChannel ? conv.name : title}
      </span>

      {isGroup && (
        <span className="shrink-0 text-[10px] text-text-ghost">
          {others.length + 1} · membership frozen
        </span>
      )}
      {isChannel && conv.workspace_ref_ids.length > 0 && (
        <span className="shrink-0 rounded bg-bg-hover px-1 py-px text-[9px] text-text-tertiary">
          {conv.workspace_ref_ids.length} workspace
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {pinnedCount > 0 && (
          <button
            type="button"
            title={`${pinnedCount} pinned`}
            className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
          >
            <Pin size={10} />
            <span className="tabular-nums">{pinnedCount}</span>
          </button>
        )}
        {(isChannel || isGroup) && (
          <div className="flex items-center -space-x-1.5 pl-1">
            {others.slice(0, 3).map((id) => (
              <CommsAvatar
                key={id}
                member={members.get(id) ?? null}
                size={16}
                className="ring-2 ring-[var(--panel-bg-2)] rounded-full"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationIntro({
  conv,
  title,
  isChannel,
}: {
  conv: ChatConversation;
  title: string;
  isChannel: boolean;
}) {
  return (
    <div className="px-4 pb-3 pt-4">
      <div className="text-[13px] font-semibold text-text-primary">
        {isChannel ? `#${conv.name}` : title}
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-ghost">
        {isChannel
          ? "This is the beginning of the channel. Anyone in the organisation can be invited, and an invitee sees the full history."
          : conv.kind === "group_dm"
            ? "Group membership is fixed for the life of the conversation — adding someone means starting a new group."
            : "This conversation is between the two of you."}
      </p>
    </div>
  );
}

function DayDivider({ at }: { at: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="h-px flex-1 bg-border-subtle" />
      <span className="text-[9.5px] font-medium uppercase tracking-wide text-text-ghost">
        {formatDayDivider(at)}
      </span>
      <span className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

/** There is no "stopped typing" frame — the store ages these out on a timer. */
function TypingHint({ names }: { names: string[] }) {
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names.length} people are typing`;
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10.5px] text-text-ghost">
      <span className="flex gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-[3px] w-[3px] rounded-full bg-text-tertiary animate-pulse"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      {label}
    </div>
  );
}
