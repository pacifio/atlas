import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useComposerFileDrop } from "@/features/chat/hooks/use-composer-file-drop";
import { openSpaceTab } from "@/features/spaces/lib/open-space";
import { CommsComposer } from "./comms-composer";
import { MessageGroup } from "./message-group";
import { PinnedMenu } from "./pinned-menu";
import { CallMenu } from "./call-menu";
import { DraftsTab } from "./drafts-tab";
import { FilesTab } from "./files-tab";
import { RenameChannelMenu } from "./rename-channel-menu";
import { CallActivity } from "./call-activity";
import { ConversationHeaderView, ConversationTabsView } from "./views/conversation-header-view";
import {
  ConversationTranscriptView,
  type TranscriptHandle,
} from "./views/conversation-transcript-view";
import { useCommsStore } from "../stores/comms-store";
import {
  conversationTitle,
  dmCounterpart,
  groupMessages,
  isNewDay,
  typingLabel,
  type MessageGroup as MessageGroupData,
} from "../lib/derive";
import type { ChatCall, ChatConversation } from "../types";

type Item =
  | {
      kind: "group";
      key: string;
      seq: number;
      newDay: boolean;
      dayAt: number;
      group: MessageGroupData;
    }
  | { kind: "call"; key: string; seq: number; call: ChatCall };

export const CommsConversation = memo(function CommsConversation({
  conv,
  showBack = true,
}: {
  conv: ChatConversation;
  /** The header's "Back to chats". Off beside the split view's sidebar,
   *  which is the way back. */
  showBack?: boolean;
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

  // The whole projection — grouping, day dividers, calls — is computed once
  // per messages change, not once per render. It was ~200 Date/Intl
  // operations inline in JSX before, re-run on every keystroke.
  //
  // Calls belong to the same timeline as messages and are ordered by the same
  // org-wide `seq`, so they interleave rather than sitting in a sidebar. Ended
  // calls stay: the row IS the record that the call happened.
  const items = useMemo(() => {
    const grouped = groupMessages(messages, me);
    const out: Item[] = grouped.map((group, i) => {
      const prevGroup = grouped[i - 1];
      const prev = prevGroup?.messages[prevGroup.messages.length - 1];
      const head = group.messages[0];
      return {
        kind: "group",
        key: group.key,
        seq: head.seq,
        newDay: isNewDay(prev, head),
        dayAt: head.created_at,
        group,
      };
    });
    const callRows = Object.values(calls).filter((c) => c.conv_id === conv.id);
    if (callRows.length === 0) return out;
    for (const call of callRows)
      out.push({ kind: "call", key: `call:${call.id}`, seq: call.seq, call });
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }, [messages, me, calls, conv.id]);

  // Stable identities so MessageGroup's memo actually engages — inline arrows
  // gave every group new props on every render, which made the memo 100% dead
  // and every store write a full-transcript repaint.
  const onReply = useCallback((id: string) => actions.setReplyTo(conv.id, id), [actions, conv.id]);
  const onEdit = useCallback((id: string) => actions.beginEdit(conv.id, id), [actions, conv.id]);
  const onDelete = useCallback(
    (id: string) => actions.deleteMessage(conv.id, id),
    [actions, conv.id],
  );

  const transcriptRef = useRef<TranscriptHandle>(null);

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
          transcriptRef.current?.scrollToMessage(messageId);
        });
      });
    },
    [conv.id],
  );

  // A jump asked for from outside (the organisation agent opening a message
  // it cited): only the conversation it names takes it.
  useEffect(() => {
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ convId?: string; messageId?: string }>).detail;
      if (detail?.convId === conv.id && detail.messageId) void jumpToMessage(detail.messageId);
    };
    window.addEventListener("atlas:comms-jump-to-message", onJump);
    return () => window.removeEventListener("atlas:comms-jump-to-message", onJump);
  }, [conv.id, jumpToMessage]);

  // Tell the server we are caught up on a conversation switch. The badge
  // itself comes back from the server, never from here. (The transcript lands
  // at the live edge on its own, keyed on the conversation.)
  useEffect(() => {
    actions.markRead(conv.id);
    // Warm the drafts cache in the background so the FIRST visit to that tab
    // paints instantly too, not just returns to it. Cheap (a small list) and
    // silent — nothing renders until the user goes looking.
    void actions.loadDrafts(conv.id);
  }, [conv.id, actions]);

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
  const isGroup = conv.kind === "group_dm";
  const title = conversationTitle(conv, members, me);
  const counterpart = dmCounterpart(conv, members, me);
  const pinnedCount = useMemo(
    () => messages.reduce((n, m) => n + (pinned.includes(m.id) ? 1 : 0), 0),
    [messages, pinned],
  );
  const otherMembers = useMemo(() => memberList.filter((m) => m.id !== me), [memberList, me]);
  const others = useMemo(
    () => (conv.member_ids ?? []).filter((id) => id !== me),
    [conv.member_ids, me],
  );
  const avatars = useMemo(
    () =>
      isChannel || isGroup
        ? others.slice(0, 3).map((id) => ({ id, member: members.get(id) ?? null }))
        : [],
    [isChannel, isGroup, others, members],
  );

  // The WHOLE conversation column is the drop target, not just the composer
  // shell: a file dragged in from Finder lands wherever the hand happens to
  // be. The composer only renders the highlight (`dropActive`).
  const columnRef = useRef<HTMLDivElement>(null);
  const onDropFiles = useCallback(
    (paths: string[]) => actions.attachFiles(conv.id, paths),
    [actions, conv.id],
  );
  const { isDropTarget } = useComposerFileDrop({
    targetRef: columnRef,
    enabled: subTab === "messages",
    onDropFiles,
  });

  const status =
    messages.length === 0 && (loading || (!hydrated && !loadError))
      ? "loading"
      : messages.length === 0 && loadError
        ? "error"
        : "ready";

  const renderItem = (item: Item) =>
    item.kind === "call" ? (
      <CallActivity call={item.call} author={members.get(item.call.started_by) ?? null} />
    ) : (
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
    );

  return (
    <div ref={columnRef} className="flex min-w-0 flex-1 flex-col">
      <ConversationHeaderView
        kind={conv.kind}
        visibility={conv.visibility}
        title={isChannel ? (conv.name ?? "") : title}
        counterpart={counterpart}
        counterpartOnline={counterpart ? online.includes(counterpart.id) : false}
        groupSize={others.length + 1}
        projectCount={conv.workspace_ref_ids.length}
        avatars={avatars}
        onBack={showBack ? actions.goHome : undefined}
        pinnedSlot={
          pinnedCount > 0 ? (
            <PinnedMenu
              convId={conv.id}
              count={pinnedCount}
              members={members}
              onJump={jumpToMessage}
            />
          ) : null
        }
        callSlot={
          <>
            <CallMenu convId={conv.id} mode="audio" />
            <CallMenu convId={conv.id} mode="video" />
          </>
        }
        renameMenu={
          isChannel ? (t) => <RenameChannelMenu conv={conv}>{t}</RenameChannelMenu> : undefined
        }
      />

      <ConversationTabsView
        active={subTab}
        onSelect={(tab) => actions.setConvTab(conv.id, tab)}
        onOpenSpace={() => openSpaceTab(conv.id, title)}
      />

      {subTab === "drafts" && <DraftsTab conv={conv} />}
      {subTab === "files" && <FilesTab convId={conv.id} />}

      {/* The messages subtree UNMOUNTS on other tabs rather than hiding with
          display:none — the transcript's measurement path must never observe
          a zero-height layout (the hidden-measure poison), and re-entry lands
          at the live edge exactly like a conversation switch. */}
      {subTab === "messages" && (
        <ConversationTranscriptView
          ref={transcriptRef}
          items={items}
          renderItem={renderItem}
          status={status}
          error={loadError ?? undefined}
          onRetry={() => actions.retryConversation(conv.id)}
          intro={
            hydrated
              ? {
                  title: isChannel ? `#${conv.name}` : title,
                  body: isChannel
                    ? "This is the beginning of the channel. Anyone in the organization can be invited, and an invitee sees the full history."
                    : conv.kind === "group_dm"
                      ? "Group membership is fixed for the life of the conversation — adding someone means starting a new group."
                      : "This conversation is between the two of you.",
                }
              : null
          }
          typingLabel={
            typers.length > 0
              ? typingLabel(typers.map((id) => members.get(id)?.name ?? "Someone"))
              : null
          }
          messageCount={messages.length}
          dropActive={isDropTarget}
          convKey={conv.id}
          composer={
            <CommsComposer
              convId={conv.id}
              members={otherMembers}
              memberMap={members}
              lookup={lookup}
              placeholder={isChannel ? `Message #${conv.name}` : `Message ${title}`}
              dropActive={isDropTarget}
            />
          }
        />
      )}
    </div>
  );
});

const EMPTY_MESSAGES: never[] = [];
