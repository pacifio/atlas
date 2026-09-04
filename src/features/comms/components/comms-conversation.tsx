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
import {
  ChevronDown,
  ChevronLeft,
  FileText,
  Folder,
  Frame,
  Hash,
  Lock,
  MessageCircle,
  Pencil,
  RefreshCw,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GradualBlur } from "@/components/gradual-blur";
import { useTranscriptScroll } from "@/features/chat/lib/use-transcript-scroll";
import { animatedScrollTo } from "@/features/artifacts/lib/scroll-to";
import { toast } from "sonner";
import { CommsAvatar } from "./comms-avatar";
import { CommsComposer } from "./comms-composer";
import { MessageGroup } from "./message-group";
import { PinnedMenu } from "./pinned-menu";
import { DraftsTab } from "./drafts-tab";
import { FilesTab } from "./files-tab";
import { RenameChannelMenu } from "./rename-channel-menu";
import { CallActivity } from "./call-activity";
import { useCommsStore, type ConvSubTab } from "../stores/comms-store";
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
  const calls = useCommsStore.use.calls();
  const loading = useCommsStore((s) => s.loading[conv.id] === true);
  // "Loaded and empty" and "never loaded" look identical in a transcript, so
  // the intro copy is gated on the former — it used to appear over a fetch
  // that had quietly failed and claim the channel had no history.
  const hydrated = useCommsStore((s) => s.hydrated[conv.id] === true);
  const loadError = useCommsStore((s) => s.loadError[conv.id]);
  const subTab = useCommsStore((s) => s.convTab[conv.id] ?? "messages");
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

  // Calls belong to the same timeline as messages and are ordered by the same
  // org-wide `seq`, so they interleave rather than sitting in a sidebar. Ended
  // calls stay: the row IS the record that the call happened.
  const items = useMemo(() => {
    const callRows = Object.values(calls).filter((c) => c.conv_id === conv.id);
    if (callRows.length === 0) {
      return groups.map((g) => ({ kind: "group" as const, seq: g.group.messages[0].seq, ...g }));
    }
    const merged = [
      ...groups.map((g) => ({ kind: "group" as const, seq: g.group.messages[0].seq, ...g })),
      ...callRows.map((call) => ({ kind: "call" as const, seq: call.seq, call })),
    ];
    merged.sort((a, b) => a.seq - b.seq);
    return merged;
  }, [groups, calls, conv.id]);

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

  // Jump to a message and flash it. If the target is older than the loaded
  // window, page history in (bounded) until it appears — the store's
  // `loadOlder` merges through the same dedupe as everything else.
  const jumpSeqRef = useRef(0);
  const jumpToMessage = useCallback(
    async (messageId: string) => {
      const seq = ++jumpSeqRef.current;
      const store = useCommsStore.getState();
      const present = () =>
        (useCommsStore.getState().messages[conv.id] ?? []).some((m) => m.id === messageId);

      let pages = 0;
      while (!present() && pages < 8) {
        const before = (useCommsStore.getState().messages[conv.id] ?? [])[0]?.seq;
        await store.actions.loadOlder(conv.id);
        if (jumpSeqRef.current !== seq) return; // superseded by a newer jump
        const after = (useCommsStore.getState().messages[conv.id] ?? [])[0]?.seq;
        if (after === before) break; // no further history
        pages += 1;
      }
      if (!present()) {
        toast.error("That message is too far back to jump to.");
        return;
      }

      // The rows for freshly paged-in history need a paint before they can be
      // measured; two frames is the cheap, reliable wait for that.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (jumpSeqRef.current !== seq) return;
          const el = scroller.current;
          if (!el) return;
          const node = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
          if (!node) return;
          // A jump is a deliberate departure from the live edge — without
          // this, the bottom-pin yanks the view straight back down.
          atEndRef.current = false;
          animatedScrollTo(el, node, { block: "center" });
          node.classList.remove("atlas-jump-flash");
          // Force a restart when the same row is jumped to twice in a row.
          void node.offsetWidth;
          node.classList.add("atlas-jump-flash");
          const done = () => node.classList.remove("atlas-jump-flash");
          node.addEventListener("animationend", done, { once: true });
          setTimeout(done, 1400);
        });
      });
    },
    [conv.id, atEndRef],
  );

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
    // Warm the drafts cache in the background so the FIRST visit to that tab
    // paints instantly too, not just returns to it. Cheap (a small list) and
    // silent — nothing renders until the user goes looking.
    void actions.loadDrafts(conv.id);
  }, [conv.id, actions, atEndRef, scrollToBottom]);

  // Last-resort self-heal: any path that renders a conversation without going
  // through `openConversation` (a restored tab, a retarget, a view swapped in
  // by something else) still gets its first page. Idempotent — the store
  // cancels a pending retry before starting another.
  useEffect(() => {
    if (!hydrated && !loading && !loadError) actions.retryConversation(conv.id);
  }, [conv.id, hydrated, loading, loadError, actions]);

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
        onJumpToMessage={jumpToMessage}
        onBack={actions.goHome}
      />

      <SubTabStrip active={subTab} onSelect={(tab) => actions.setConvTab(conv.id, tab)} />

      {subTab === "drafts" && <DraftsTab convId={conv.id} />}
      {subTab === "files" && <FilesTab convId={conv.id} />}

      {/* Overlays are SIBLINGS of the scroller, never inside the content — the
          transcript pattern. `relative` scopes them; nothing here transforms
          (the vibrant-panel rule), and both overlays are pointer-events-none.
          The messages subtree UNMOUNTS on other tabs rather than hiding with
          display:none — the transcript's measurement path must never observe
          a zero-height layout (the hidden-measure poison), and re-entry lands
          at the live edge exactly like a conversation switch. */}
      {subTab === "messages" && (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <GradualBlur
              position="top"
              height={`${TOP_FADE}px`}
              strength={2}
              layers={4}
              tint="color-mix(in srgb, var(--comms-surface) 90%, transparent)"
              style={{ zIndex: 3 }}
            />

            <div
              ref={scroller}
              onScroll={onScroll}
              className="min-h-0 flex-1 overflow-y-auto hide-scrollbar [overflow-anchor:none]"
            >
              <div ref={content} style={{ paddingTop: TOP_FADE / 2, paddingBottom: 10 }}>
                {messages.length === 0 && (loading || (!hydrated && !loadError)) ? (
                  <TranscriptSkeleton />
                ) : messages.length === 0 && loadError ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                    <span className="text-[12px] font-medium text-text-primary">
                      Couldn’t load this conversation
                    </span>
                    <span className="max-w-[260px] text-[11px] text-text-tertiary">
                      {loadError}
                    </span>
                    <button
                      type="button"
                      onClick={() => actions.retryConversation(conv.id)}
                      className="mt-1 flex h-[26px] items-center gap-1.5 rounded-md border border-border-default bg-bg-hover px-3 text-[11px] font-medium text-text-primary transition-colors hover:bg-bg-active cursor-pointer"
                    >
                      <RefreshCw size={11} />
                      Try again
                    </button>
                  </div>
                ) : (
                  hydrated && <ConversationIntro conv={conv} title={title} isChannel={isChannel} />
                )}

                {items.map((item) =>
                  item.kind === "call" ? (
                    <CallActivity
                      key={`call:${item.call.id}`}
                      call={item.call}
                      author={members.get(item.call.started_by) ?? null}
                    />
                  ) : (
                    <Fragment key={item.group.key}>
                      {item.newDay && <DayDivider at={item.group.messages[0].created_at} />}
                      <MessageGroup
                        messages={item.group.messages}
                        own={item.group.own}
                        author={members.get(item.group.authorId) ?? null}
                        members={members}
                        me={me}
                        lookup={lookup}
                        onReply={onReply}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        onReact={actions.react}
                        onPin={actions.togglePin}
                        onJump={jumpToMessage}
                        showAuthor={conv.kind !== "dm"}
                      />
                    </Fragment>
                  ),
                )}

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
                  "linear-gradient(to bottom, transparent, var(--comms-surface) 72%, var(--comms-surface))",
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
        </>
      )}
    </div>
  );
});

const EMPTY_MESSAGES: never[] = [];

/**
 * The Slack-style sub-tab strip, at Atlas scale: an underline marks the
 * active tab. Messages is the transcript; Drafts and Files are the
 * conversation's other faces. Spaces joins later.
 */
function SubTabStrip({
  active,
  onSelect,
}: {
  active: ConvSubTab;
  onSelect: (tab: ConvSubTab) => void;
}) {
  const tabs: { id: ConvSubTab; label: string; icon: LucideIcon }[] = [
    { id: "messages", label: "Messages", icon: MessageCircle },
    { id: "drafts", label: "Drafts", icon: FileText },
    { id: "files", label: "Files", icon: Folder },
  ];
  return (
    <div className="flex h-[30px] shrink-0 items-center gap-0.5 border-b border-border-default px-2">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          className={cn(
            "relative flex h-full items-center gap-1.5 px-2 text-[11px] font-medium transition-colors cursor-pointer",
            active === id ? "text-text-primary" : "text-text-tertiary hover:text-text-secondary",
          )}
        >
          <Icon size={11} className="shrink-0 opacity-80" />
          {label}
          {active === id && (
            <span className="absolute inset-x-1.5 bottom-0 h-[1.5px] rounded-full bg-text-primary" />
          )}
        </button>
      ))}

      {/* Placeholder for the realtime canvas (ATL-252). Disabled rather than
          wired to nothing: a button that looks live and does nothing is worse
          than one that says it isn't ready yet. */}
      <button
        type="button"
        disabled
        title="Spaces — coming soon"
        className="ml-auto flex h-[20px] shrink-0 cursor-not-allowed items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2.5 text-[10px] font-medium text-text-tertiary"
      >
        <Frame size={10} />
        Spaces
      </button>
    </div>
  );
}

function ConversationHeader({
  conv,
  title,
  counterpart,
  online,
  members,
  me,
  pinnedCount,
  onJumpToMessage,
  onBack,
}: {
  conv: ChatConversation;
  title: string;
  counterpart: OrgMemberProfile | null;
  online: string[];
  members: Map<string, OrgMemberProfile>;
  me: string;
  pinnedCount: number;
  onJumpToMessage: (id: string) => void;
  onBack: () => void;
}) {
  const isChannel = conv.kind === "channel";
  const isGroup = conv.kind === "group_dm";
  const others = (conv.member_ids ?? []).filter((id) => id !== me);

  return (
    // Three zones, not one row: the two `flex-1` rails let the middle group
    // sit optically centred whatever the actions weigh, and `min-w-0` on all
    // three keeps a long channel name truncating instead of shoving the
    // buttons off the edge.
    <div className="flex h-[29px] shrink-0 items-center border-b border-border-default px-1.5">
      <div className="flex min-w-0 flex-1 items-center">
        {/* Back to the tab's home view — the panel has no sidebar to fall back on. */}
        <button
          type="button"
          title="Back to chats"
          onClick={onBack}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
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
        {isChannel ? (
          // Members may rename a channel (the server checks); hover reveals the
          // pencil, and DMs never get one — a name there is refused outright.
          <RenameChannelMenu conv={conv}>
            <button
              type="button"
              title="Rename channel"
              className="group/title flex min-w-0 items-center gap-1 text-left cursor-pointer"
            >
              <span className="min-w-0 truncate text-[11.5px] font-medium text-text-primary">
                {conv.name}
              </span>
              <Pencil
                size={10}
                className="shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover/title:opacity-100"
              />
            </button>
          </RenameChannelMenu>
        ) : (
          <span className="min-w-0 truncate text-[11.5px] font-medium text-text-primary">
            {title}
          </span>
        )}

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
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
        {pinnedCount > 0 && (
          <PinnedMenu
            convId={conv.id}
            count={pinnedCount}
            members={members}
            onJump={onJumpToMessage}
          />
        )}
        {(isChannel || isGroup) && (
          <div className="flex items-center -space-x-1.5 pl-1">
            {others.slice(0, 3).map((id) => (
              <CommsAvatar
                key={id}
                member={members.get(id) ?? null}
                size={16}
                className="ring-2 ring-[var(--comms-surface)] rounded-full"
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

/**
 * Message-shaped placeholders for a transcript that has not arrived.
 *
 * Opacity-only shimmer (`atlas-marker-shimmer`): this renders inside
 * `atlas-vibrant-panel`, whose grain overlay makes WKWebView mis-composite
 * anything animating a transform.
 */
function TranscriptSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-3 py-4">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-2">
          <div
            className="h-[30px] w-[30px] shrink-0 rounded-full bg-[var(--bg-elevated)] opacity-50"
            style={{ animation: "atlas-marker-shimmer 1.4s ease-in-out infinite" }}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
            <div
              className="h-[9px] rounded bg-[var(--bg-elevated)] opacity-50"
              style={{
                width: 90 + ((i * 31) % 50),
                animation: "atlas-marker-shimmer 1.4s ease-in-out infinite",
              }}
            />
            <div
              className="h-[8px] rounded bg-[var(--bg-elevated)] opacity-35"
              style={{
                width: `${58 + ((i * 17) % 34)}%`,
                animation: "atlas-marker-shimmer 1.4s ease-in-out infinite",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
