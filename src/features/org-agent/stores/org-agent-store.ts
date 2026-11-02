// The Organisation agent on the desktop: a mirror of the member's Asks on the
// server, and where each one is on screen.
//
// **The server holds the conversations.** Each Ask is an event log
// (`org-agent-log.ts`); this store keeps the logs it has read, applies socket
// frames to them in `seq` order, and resumes any log that skipped a frame. It
// is the web's `AtlasSession` (`apps/web/src/lib/atlas/socket.ts`) over a
// zustand store instead of the query cache, rule for rule:
//
//  - **Sends are optimistic and idempotent.** A message is drawn at once and
//    held in the outbox until its `user_message` echo carries the same
//    `client_msg_id` back. The outbox survives a reconnect and is sent again;
//    the server answers a repeat with the stored event, never a second message.
//  - **A new chat has no Ask yet.** It is a temp id (`new-…`) until its first
//    message's echo names the real one, which then takes its place
//    everywhere — tabs, the messenger, the page, pins.
//  - **Every reconnect resumes** each log held from its last `seq`, re-sends
//    the outbox, and re-reads the list, because frames sent while the socket
//    was down are gone (but every one is in the log).
//
// Where a conversation is on screen — one place at a time:
//
//   panel     the side panel, its home: open conversations are tabs (`tabs`),
//             one of them active (`activeId`)
//   floating  the messenger over the shell (`floatingId`), from Minimise
//   page      the full page (`pageId`), from Full screen or the sidebar
//
// Placement is persisted; the server mirror is not (it is re-read on launch).

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

import {
  OrgAgentError,
  orgAgent,
  type AgentConnState,
  type AgentEnvelope,
} from "../lib/org-agent-api";
import { appendEvents, isEvent, lastSeq, mergeFresh, statusAfter } from "../lib/org-agent-log";
import type {
  AskContext,
  AskDetail,
  AskSummary,
  AtlasEffort,
  AtlasEvent,
  AtlasNotification,
  AtlasStatus,
  ClientFrame,
  CreateLoopRequest,
  EffortResponse,
  Loop,
  Mention,
} from "../lib/org-agent-types";
import { ATLAS_LIMITS } from "../lib/org-agent-types";

export const NEW_CHAT_TITLE = "New chat";

const TEMP_PREFIX = "new-";

/** A conversation that has no Ask on the server yet. */
export function isTempAsk(id: string): boolean {
  return id.startsWith(TEMP_PREFIX);
}

/** Socket refusals that answer an `ask.send`: that message was not stored. */
const SEND_REFUSALS = new Set([
  "turns_per_day",
  "deep_research_per_day",
  "rate_limited",
  "bad_request",
  "atlas_off",
  "unavailable",
]);

/** A message on its way, drawn as pending until its echo replaces it. */
export interface PendingSend {
  clientMsgId: string;
  text: string;
  /** The real Ask, or `null` while this message starts one. */
  askId: string | null;
  /** The temp id standing in for the Ask this message starts. */
  tempAskId: string | null;
  /** Why it was refused, when it was: drawn with Retry. */
  failed: string | null;
  context?: AskContext;
  mentions?: Mention[];
  effort?: AtlasEffort;
  mode?: "deep_research";
}

export interface SendOptions {
  mentions?: Mention[];
  effort?: AtlasEffort;
  deepResearch?: boolean;
}

interface OrgAgentState {
  // ── The server's, mirrored ────────────────────────────────────────────────
  /** The Organisation the socket is for; a change resets the mirror. */
  orgId: string | null;
  connection: AgentConnState;
  /** Every Ask listed, by id — temp ones included while they start. */
  asks: Record<string, AskSummary>;
  asksLoaded: boolean;
  asksCursor: string | null;
  /** "Show older" has read past the first page. */
  asksOlderLoaded: boolean;
  asksError: string | null;
  /** Event logs read so far. */
  logs: Record<string, AskDetail>;
  /** Asks whose log is being read. */
  loading: string[];
  /** Why an Ask's log could not be read. */
  loadErrors: Record<string, string>;
  /** The member's ratings: Ask → `answer_done` seq → rating. */
  votes: Record<string, Record<number, "up" | "down">>;
  outbox: PendingSend[];
  /** Approvals decided here and not yet resolved by the server. */
  deciding: string[];
  /** Questions answered here and not yet moved past. */
  answering: string[];
  /** A socket refusal that answered nothing in the outbox. */
  error: { code: string; message: string } | null;
  atlas: AtlasStatus | null;
  effortInfo: EffortResponse | null;
  notifications: { items: AtlasNotification[]; unread: number } | null;
  loops: Loop[] | null;
  loopsError: string | null;

  // ── Placement and the composer, persisted ────────────────────────────────
  tabs: string[];
  activeId: string | null;
  floatingId: string | null;
  pageId: string | null;
  /** The full page's view: a conversation, or the Loops. */
  pageView: "chat" | "loops";
  /** Conversations with an answer the person has not looked at. */
  unread: string[];
  /** Kept at the top of the history, in the order they were pinned. */
  pinned: string[];
  /** The composer's level for the next message; the member's saved default. */
  effort: AtlasEffort;
  /** Deep research for the next message. */
  deepResearch: boolean;

  actions: {
    /** One envelope off Rust's `atlas:org-agent` channel. */
    onEnvelope: (envelope: AgentEnvelope) => void;
    /** Where the socket stands, read once at start. */
    adopt: (org: string | null, state: AgentConnState) => void;

    loadAsks: () => Promise<void>;
    loadMoreAsks: () => Promise<void>;
    /** Read one Ask's log (again). */
    openAsk: (id: string) => Promise<void>;
    refreshStatus: () => Promise<void>;
    refreshEffort: () => Promise<void>;
    refreshNotifications: () => Promise<void>;
    loadLoops: () => Promise<void>;
    createLoop: (body: CreateLoopRequest) => Promise<Loop>;
    setLoopStatus: (id: string, status: "active" | "paused") => Promise<void>;
    deleteLoop: (id: string) => Promise<void>;

    /** Send a message in conversation `id` (temp or real). */
    send: (id: string, text: string, options?: SendOptions) => void;
    /** Send a refused message again, under the same `client_msg_id`. */
    retrySend: (clientMsgId: string) => void;
    /** Give up on a refused message. */
    discardSend: (clientMsgId: string) => void;
    /** Ask the last question again, at the same level, with the same mentions. */
    regenerate: (id: string) => void;
    /** Stop the running turn. */
    stop: (id: string) => void;
    cancelResearch: (id: string, jobId: string) => void;
    decide: (frame: Omit<Extract<ClientFrame, { t: "approval.decide" }>, "t">) => boolean;
    answer: (questionId: string, answer: { choice?: string; text?: string }) => boolean;
    vote: (id: string, eventSeq: number, rating: "up" | "down") => void;
    clearError: () => void;

    togglePin: (id: string) => void;
    setEffort: (effort: AtlasEffort) => void;
    setDeepResearch: (on: boolean) => void;
    setPageView: (view: "chat" | "loops") => void;
    /** A new conversation: a tab in the panel, active — or the full page's. */
    newChat: (opts?: { on?: "panel" | "page" }) => string;
    /** Show `id` in the panel (opening its tab if it has none). */
    activate: (id: string) => void;
    closeTab: (id: string) => void;
    minimise: (id: string) => void;
    restoreToPanel: (id: string) => void;
    fullScreen: (id: string) => void;
    openOnPage: (id: string | null) => void;
    closeFloating: () => void;
    markRead: (id: string) => void;
    deleteConversation: (id: string) => Promise<void>;
  };
}

function tempId(): string {
  return `${TEMP_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function clientMsgId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof OrgAgentError ? e.message : e instanceof Error ? e.message : fallback;
}

/** The context every desktop message carries: where it was asked from, and
 *  the member's time zone, which is what makes "this week" mean their week. */
function desktopContext(): AskContext {
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    tz = undefined;
  }
  return { route: "/agent", ...(tz ? { tz } : {}) };
}

/** The ids `old` is known by in placement, swapped for `next`. */
function swapId(list: string[], old: string, next: string): string[] {
  return [...new Set(list.map((x) => (x === old ? next : x)))];
}

/** The last `after_seq` each Ask was resumed from, so one hole is asked about
 *  once. Module state, like the web session's: cleared on every reconnect. */
const resumed = new Map<string, number>();
/** Debounced refreshes after a turn ends. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function later(key: string, ms: number, fn: () => void) {
  const prev = refreshTimers.get(key);
  if (prev) clearTimeout(prev);
  refreshTimers.set(
    key,
    setTimeout(() => {
      refreshTimers.delete(key);
      fn();
    }, ms),
  );
}

/** Reset the module's bookkeeping (tests). */
export function resetOrgAgentSessionForTests(): void {
  resumed.clear();
  for (const t of refreshTimers.values()) clearTimeout(t);
  refreshTimers.clear();
}

const SERVER_MIRROR = {
  asks: {},
  asksLoaded: false,
  asksCursor: null,
  asksOlderLoaded: false,
  asksError: null,
  logs: {},
  loading: [],
  loadErrors: {},
  votes: {},
  outbox: [],
  deciding: [],
  answering: [],
  error: null,
  atlas: null,
  effortInfo: null,
  notifications: null,
  loops: null,
  loopsError: null,
} satisfies Partial<OrgAgentState>;

export const useOrgAgentStore = createSelectors(
  create<OrgAgentState>()(
    persist(
      (set, get) => {
        const send = (frame: ClientFrame) => orgAgent.send(frame);

        const resume = (askId: string, after: number) => {
          if (isTempAsk(askId) || resumed.get(askId) === after) return;
          resumed.set(askId, after);
          void send({ t: "resume", ask_id: askId, after_seq: after }).then((ok) => {
            if (!ok) resumed.delete(askId);
          });
        };

        const transmit = (entry: PendingSend) => {
          void send({
            t: "ask.send",
            ...(entry.askId ? { ask_id: entry.askId } : {}),
            client_msg_id: entry.clientMsgId,
            text: entry.text.slice(0, ATLAS_LIMITS.messageChars),
            ...(entry.context ? { context: entry.context } : {}),
            ...(entry.mentions && entry.mentions.length > 0 ? { mentions: entry.mentions } : {}),
            ...(entry.mode ? { mode: entry.mode } : entry.effort ? { effort: entry.effort } : {}),
          });
        };

        /** On screen right now, so an answer landing there is not unread. */
        const seen = (s: OrgAgentState, id: string) =>
          s.activeId === id || s.floatingId === id || s.pageId === id;

        /** A message that started an Ask came back: the temp Ask becomes the
         *  real one, everywhere it was shown. */
        const onCreated = (tempAskId: string, event: AtlasEvent) => {
          const real = event.ask_id;
          set((s) => {
            const temp = s.asks[tempAskId];
            const row: AskSummary = {
              id: real,
              title: temp?.title ?? NEW_CHAT_TITLE,
              kind: "ask",
              created_at: temp?.created_at ?? event.at,
              updated_at: event.at,
              status: "running",
            };
            const asks = { ...s.asks, [real]: s.asks[real] ?? row };
            delete asks[tempAskId];
            const seeded = appendEvents({ ask: row, events: [] }, [event]);
            const logs = { ...s.logs };
            // Not the Ask's first event (a resent message on a reconnect):
            // read the whole log instead of seeding it.
            if (!seeded.gap && !logs[real]) logs[real] = seeded.log;
            return {
              asks,
              logs,
              tabs: swapId(s.tabs, tempAskId, real),
              pinned: swapId(s.pinned, tempAskId, real),
              unread: swapId(s.unread, tempAskId, real),
              activeId: s.activeId === tempAskId ? real : s.activeId,
              floatingId: s.floatingId === tempAskId ? real : s.floatingId,
              pageId: s.pageId === tempAskId ? real : s.pageId,
              outbox: s.outbox.map((p) =>
                p.tempAskId === tempAskId ? { ...p, askId: real, tempAskId: null } : p,
              ),
            };
          });
          if (!get().logs[real]) void get().actions.openAsk(real);
        };

        const onEvent = (event: AtlasEvent) => {
          if (event.kind === "user_message") {
            const entry = get().outbox.find((p) => p.clientMsgId === event.payload.client_msg_id);
            if (entry) {
              set((s) => ({ outbox: s.outbox.filter((p) => p.clientMsgId !== entry.clientMsgId) }));
              if (entry.tempAskId) return onCreated(entry.tempAskId, event);
            }
          }
          if (event.kind === "approval_resolved") {
            set((s) => ({ deciding: s.deciding.filter((d) => d !== event.payload.approval_id) }));
            // Something may have been done: today's count moves.
            if (event.payload.executed)
              later("status", 400, () => void get().actions.refreshStatus());
          }
          if (event.kind === "answer_done" || event.kind === "limit_reached") {
            later("status", 400, () => void get().actions.refreshStatus());
            later("effort", 400, () => void get().actions.refreshEffort());
          }
          if (
            event.kind === "research" &&
            (event.payload.status === "queued" || event.payload.status === "planning")
          ) {
            later("effort", 400, () => void get().actions.refreshEffort());
          }
          if (
            event.kind === "report" ||
            (event.kind === "research" && event.payload.status === "failed")
          ) {
            later("effort", 400, () => void get().actions.refreshEffort());
            later("notifications", 400, () => void get().actions.refreshNotifications());
            if (event.kind === "report") {
              window.dispatchEvent(
                new CustomEvent("atlas:org-agent-report", {
                  detail: {
                    askId: event.ask_id,
                    title: event.payload.title,
                    partial: event.payload.partial,
                  },
                }),
              );
            }
          }
          const ended =
            event.kind === "answer_done" ||
            event.kind === "report" ||
            event.kind === "error" ||
            (event.kind === "limit_reached" && !event.payload.can_continue) ||
            event.kind === "approval_required" ||
            event.kind === "question";

          const log = get().logs[event.ask_id];
          if (log) {
            const result = appendEvents(log, [event]);
            if (result.added > 0) {
              set((s) => {
                const summary: AskSummary = {
                  ...(s.asks[event.ask_id] ?? result.log.ask),
                  status: result.log.ask.status,
                  updated_at: result.log.ask.updated_at,
                };
                return {
                  logs: { ...s.logs, [event.ask_id]: result.log },
                  asks: { ...s.asks, [event.ask_id]: summary },
                  // Whatever the turn does next moves past an answered
                  // question (the fold marks it answered), so nothing is in
                  // flight any more.
                  answering: event.kind === "question" ? s.answering : [],
                  unread:
                    ended && !seen(s, event.ask_id) && !s.unread.includes(event.ask_id)
                      ? [...s.unread, event.ask_id]
                      : s.unread,
                };
              });
            }
            if (result.gap) resume(event.ask_id, lastSeq(result.log));
            return;
          }

          // Not read on this desktop: keep the list honest without the log.
          const listed = get().asks[event.ask_id];
          if (listed) {
            set((s) => ({
              asks: {
                ...s.asks,
                [event.ask_id]: {
                  ...listed,
                  status: statusAfter(event, listed.status),
                  updated_at: Math.max(listed.updated_at, event.at),
                },
              },
              unread:
                ended && !seen(s, event.ask_id) && !s.unread.includes(event.ask_id)
                  ? [...s.unread, event.ask_id]
                  : s.unread,
            }));
          } else if (event.kind === "user_message") {
            // An Ask started somewhere else: the web, or another window.
            later("asks", 300, () => void get().actions.loadAsks());
          }
        };

        /** A refusal that names no Ask. One that answers a message marks the
         *  oldest message still on its way as not sent — the server handles one
         *  socket's frames in order, so that is the one it refused. */
        const onRefusal = (code: string, message: string) => {
          if (SEND_REFUSALS.has(code)) {
            const waiting = get().outbox.find((p) => !p.failed);
            if (waiting) {
              set((s) => ({
                outbox: s.outbox.map((p) =>
                  p.clientMsgId === waiting.clientMsgId ? { ...p, failed: message || code } : p,
                ),
              }));
              return;
            }
          }
          if (code === "not_found") set({ deciding: [], answering: [] });
          set({ error: { code, message: message || code } });
        };

        const onFrame = (raw: string) => {
          let frame: unknown;
          try {
            frame = JSON.parse(raw);
          } catch {
            return;
          }
          if (typeof frame !== "object" || frame === null) return;
          const t = (frame as { t?: unknown }).t;
          if (t === "pong") return;
          if (t === "error") {
            const f = frame as { code?: unknown; message?: unknown };
            return onRefusal(
              typeof f.code === "string" ? f.code : "error",
              typeof f.message === "string" ? f.message : "",
            );
          }
          if (t === "event" && isEvent(frame)) onEvent(frame);
        };

        /** The socket (re)opened: send what is still owed, resume every log
         *  held from its last event, and read the list again. */
        const onOpen = () => {
          resumed.clear();
          for (const entry of get().outbox) if (!entry.failed) transmit(entry);
          for (const [id, log] of Object.entries(get().logs)) resume(id, lastSeq(log));
          void get().actions.loadAsks();
          void get().actions.refreshStatus();
          void get().actions.refreshEffort();
          void get().actions.refreshNotifications();
        };

        const switchOrg = (org: string | null) => {
          if (get().orgId === org) return;
          resetOrgAgentSessionForTests();
          // Another Organisation's Asks are not this one's: placement keeps
          // only what has not started yet.
          set((s) => ({
            ...SERVER_MIRROR,
            orgId: org,
            tabs: s.orgId === null ? s.tabs : s.tabs.filter(isTempAsk),
            pinned: s.orgId === null ? s.pinned : [],
            unread: s.orgId === null ? s.unread : [],
            activeId: s.orgId === null || (s.activeId && isTempAsk(s.activeId)) ? s.activeId : null,
            floatingId: s.orgId === null ? s.floatingId : null,
            pageId: s.orgId === null || (s.pageId && isTempAsk(s.pageId)) ? s.pageId : null,
          }));
        };

        return {
          orgId: null,
          connection: "disconnected",
          ...SERVER_MIRROR,
          tabs: [],
          activeId: null,
          floatingId: null,
          pageId: null,
          pageView: "chat",
          unread: [],
          pinned: [],
          effort: "medium",
          deepResearch: false,

          actions: {
            onEnvelope: (envelope) => {
              const org = envelope.org || null;
              if (envelope.ev.kind === "connection") {
                const state = envelope.ev.state;
                if (state === "disconnected") {
                  switchOrg(null);
                  set({ connection: state });
                  return;
                }
                switchOrg(org);
                set({ connection: state });
                if (state === "open") onOpen();
                return;
              }
              if (org && org !== get().orgId) return; // a stale socket's frame
              onFrame(envelope.ev.frame);
            },
            adopt: (org, state) => {
              switchOrg(org);
              set({ connection: state });
              if (state === "open") onOpen();
            },

            loadAsks: async () => {
              try {
                const page = await orgAgent.asks(null);
                set((s) => {
                  const asks: Record<string, AskSummary> = {};
                  // Temp rows stay until their echo; logs read ahead of the list
                  // keep their own (fresher) summary.
                  for (const [id, a] of Object.entries(s.asks)) if (isTempAsk(id)) asks[id] = a;
                  for (const a of page.asks) {
                    const log = s.logs[a.id];
                    asks[a.id] =
                      log && log.ask.updated_at > a.updated_at ? { ...a, ...log.ask } : a;
                  }
                  for (const [id, a] of Object.entries(s.asks)) {
                    if (asks[id] || isTempAsk(id)) continue;
                    // Older pages already read stay, and so does an Ask this
                    // window holds the log of (one the list has not caught
                    // up with yet).
                    if (s.asksOlderLoaded || s.logs[id]) asks[id] = a;
                  }
                  return {
                    asks,
                    asksLoaded: true,
                    // Reading the first page again does not undo "Show older".
                    asksCursor: s.asksOlderLoaded ? s.asksCursor : page.next_cursor,
                    asksError: null,
                  };
                });
              } catch (e) {
                set({
                  asksLoaded: true,
                  asksError: errorText(e, "Could not read your conversations."),
                });
              }
            },
            loadMoreAsks: async () => {
              const cursor = get().asksCursor;
              if (!cursor) return;
              try {
                const page = await orgAgent.asks(cursor);
                set((s) => {
                  const asks = { ...s.asks };
                  for (const a of page.asks) if (!asks[a.id]) asks[a.id] = a;
                  return { asks, asksCursor: page.next_cursor, asksOlderLoaded: true };
                });
              } catch (e) {
                set({ asksError: errorText(e, "Could not read older conversations.") });
              }
            },
            openAsk: async (id) => {
              if (isTempAsk(id) || get().loading.includes(id)) return;
              set((s) => ({ loading: [...s.loading, id] }));
              try {
                const fresh = await orgAgent.ask(id);
                set((s) => {
                  const merged = mergeFresh(s.logs[id], fresh);
                  const votes: Record<number, "up" | "down"> = { ...s.votes[id] };
                  for (const f of fresh.feedback ?? []) votes[f.event_seq] = f.rating;
                  const loadErrors = { ...s.loadErrors };
                  delete loadErrors[id];
                  return {
                    logs: { ...s.logs, [id]: merged },
                    asks: { ...s.asks, [id]: { ...s.asks[id], ...merged.ask } },
                    votes: { ...s.votes, [id]: votes },
                    loading: s.loading.filter((l) => l !== id),
                    loadErrors,
                  };
                });
                // Anything the socket announced while the read was in flight.
                resume(id, lastSeq(get().logs[id]));
                // A finished report in it is read now.
                const unreadNotes =
                  get().notifications?.items.filter((n) => n.ask_id === id && !n.read) ?? [];
                if (unreadNotes.length > 0) {
                  void orgAgent
                    .markNotificationsRead({ ids: unreadNotes.map((n) => n.id) })
                    .then(() => get().actions.refreshNotifications())
                    .catch(() => {});
                }
              } catch (e) {
                set((s) => ({
                  loading: s.loading.filter((l) => l !== id),
                  loadErrors: {
                    ...s.loadErrors,
                    [id]: errorText(e, "Could not read this conversation."),
                  },
                }));
              }
            },
            refreshStatus: async () => {
              try {
                set({ atlas: await orgAgent.atlasStatus() });
              } catch {
                // Kept as it was; the next turn reads it again.
              }
            },
            refreshEffort: async () => {
              try {
                const info = await orgAgent.effort();
                set((s) => ({
                  effortInfo: info,
                  // The saved default is the web's and the desktop's shared pick.
                  effort: s.effortInfo === null ? info.default : s.effort,
                  deepResearch:
                    s.deepResearch &&
                    info.deep_research.allowed &&
                    info.deep_research.remaining > 0,
                }));
              } catch {
                // The picker falls back to the built-in levels.
              }
            },
            refreshNotifications: async () => {
              try {
                set({ notifications: await orgAgent.notifications() });
              } catch {
                // Nothing to show is the same as nothing new.
              }
            },
            loadLoops: async () => {
              try {
                const res = await orgAgent.loops(get().atlas?.admin ?? false);
                set({ loops: res.loops, loopsError: null });
              } catch (e) {
                set({
                  loopsError: errorText(e, "Could not read Loops."),
                  loops: get().loops ?? [],
                });
              }
            },
            createLoop: async (body) => {
              const loop = await orgAgent.createLoop(body);
              set((s) => ({ loops: [loop, ...(s.loops ?? []).filter((l) => l.id !== loop.id)] }));
              return loop;
            },
            setLoopStatus: async (id, status) => {
              const before = get().loops;
              set((s) => ({
                loops: (s.loops ?? []).map((l) => (l.id === id ? { ...l, status } : l)),
              }));
              try {
                const loop = await orgAgent.setLoopStatus(id, status);
                set((s) => ({ loops: (s.loops ?? []).map((l) => (l.id === id ? loop : l)) }));
              } catch (e) {
                set({ loops: before });
                throw e;
              }
            },
            deleteLoop: async (id) => {
              const before = get().loops;
              set((s) => ({ loops: (s.loops ?? []).filter((l) => l.id !== id) }));
              try {
                await orgAgent.deleteLoop(id);
              } catch (e) {
                set({ loops: before });
                throw e;
              }
            },

            send: (id, text, options = {}) => {
              const body = text.trim();
              if (!body) return;
              const temp = isTempAsk(id);
              const entry: PendingSend = {
                clientMsgId: clientMsgId(),
                text: body.slice(0, ATLAS_LIMITS.messageChars),
                askId: temp ? null : id,
                tempAskId: temp ? id : null,
                failed: null,
                context: desktopContext(),
                ...(options.mentions && options.mentions.length > 0
                  ? { mentions: options.mentions.slice(0, ATLAS_LIMITS.mentions) }
                  : {}),
                ...(options.deepResearch
                  ? { mode: "deep_research" as const }
                  : { effort: options.effort ?? get().effort }),
              };
              set((s) => {
                const now = Date.now();
                const asks = { ...s.asks };
                if (temp && !asks[id]) {
                  asks[id] = {
                    id,
                    title: body.split("\n")[0]!.slice(0, 80),
                    kind: "ask",
                    created_at: now,
                    updated_at: now,
                    status: "running",
                  };
                } else if (asks[id]) {
                  asks[id] = { ...asks[id], updated_at: now };
                }
                return {
                  asks,
                  outbox: [...s.outbox, entry],
                  error: null,
                  // Deep research is one message's choice, not a mode that sticks.
                  deepResearch: options.deepResearch ? false : s.deepResearch,
                };
              });
              transmit(entry);
            },
            retrySend: (id) => {
              const entry = get().outbox.find((p) => p.clientMsgId === id);
              if (!entry) return;
              set((s) => ({
                outbox: s.outbox.map((p) => (p.clientMsgId === id ? { ...p, failed: null } : p)),
              }));
              transmit({ ...entry, failed: null });
            },
            discardSend: (id) => {
              const entry = get().outbox.find((p) => p.clientMsgId === id);
              if (!entry) return;
              set((s) => {
                const asks = { ...s.asks };
                // A temp Ask it would have started goes with it, unless the
                // tab is still open to try again.
                if (
                  entry.tempAskId &&
                  !s.outbox.some((p) => p !== entry && p.tempAskId === entry.tempAskId)
                ) {
                  delete asks[entry.tempAskId];
                }
                return { outbox: s.outbox.filter((p) => p.clientMsgId !== id), asks };
              });
            },
            regenerate: (id) => {
              const log = get().logs[id];
              const last = [...(log?.events ?? [])]
                .reverse()
                .find((e) => e.kind === "user_message");
              if (!last || last.kind !== "user_message") return;
              get().actions.send(id, last.payload.text, {
                mentions: last.payload.mentions,
                deepResearch: last.payload.mode === "deep_research",
                ...(last.payload.effort ? { effort: last.payload.effort } : {}),
              });
            },
            stop: (id) => {
              if (isTempAsk(id)) return;
              void send({ t: "ask.stop", ask_id: id }).then((ok) => {
                if (!ok) return;
                set((s) => ({
                  asks: s.asks[id]
                    ? { ...s.asks, [id]: { ...s.asks[id], status: "idle" } }
                    : s.asks,
                  logs: s.logs[id]
                    ? {
                        ...s.logs,
                        [id]: { ...s.logs[id], ask: { ...s.logs[id].ask, status: "idle" } },
                      }
                    : s.logs,
                }));
                // A stop is not itself an event: read the server's account.
                later(`stop:${id}`, 1_500, () => void get().actions.openAsk(id));
              });
            },
            cancelResearch: (id, jobId) => {
              void send({ t: "research.cancel", ask_id: id, job_id: jobId });
            },
            decide: (frame) => {
              if (get().connection !== "open") return false;
              void send({ t: "approval.decide", ...frame }).then((ok) => {
                if (!ok)
                  set((s) => ({ deciding: s.deciding.filter((d) => d !== frame.approval_id) }));
              });
              set((s) => ({ deciding: [...s.deciding, frame.approval_id] }));
              return true;
            },
            answer: (questionId, answer) => {
              if (get().connection !== "open") return false;
              void send({ t: "question.answer", question_id: questionId, ...answer }).then((ok) => {
                if (!ok) set((s) => ({ answering: s.answering.filter((q) => q !== questionId) }));
              });
              set((s) => ({ answering: [...s.answering, questionId] }));
              return true;
            },
            vote: (id, eventSeq, rating) => {
              const before = get().votes[id]?.[eventSeq];
              set((s) => ({ votes: { ...s.votes, [id]: { ...s.votes[id], [eventSeq]: rating } } }));
              void orgAgent.rate(id, eventSeq, rating).catch(() => {
                set((s) => {
                  const votes = { ...s.votes[id] };
                  if (before) votes[eventSeq] = before;
                  else delete votes[eventSeq];
                  return { votes: { ...s.votes, [id]: votes } };
                });
              });
            },
            clearError: () => set({ error: null }),

            togglePin: (id) =>
              set((s) => ({
                pinned: s.pinned.includes(id)
                  ? s.pinned.filter((p) => p !== id)
                  : [...s.pinned, id],
              })),
            setEffort: (effort) => {
              set({ effort });
              // The pick becomes the default, shared with the web.
              void orgAgent.saveDefaultEffort(effort).catch(() => {});
            },
            setDeepResearch: (deepResearch) => set({ deepResearch }),
            setPageView: (pageView) => set({ pageView }),
            newChat: (opts) => {
              const id = tempId();
              set((s) =>
                opts?.on === "page"
                  ? { pageId: id, pageView: "chat" }
                  : { tabs: [...s.tabs, id], activeId: id },
              );
              return id;
            },
            activate: (id) =>
              set((s) => ({
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                activeId: id,
                unread: s.unread.filter((u) => u !== id),
              })),
            closeTab: (id) =>
              set((s) => {
                const tabs = s.tabs.filter((t) => t !== id);
                const at = s.tabs.indexOf(id);
                return {
                  tabs,
                  // The neighbour takes over, as a closed tab's does anywhere.
                  activeId:
                    s.activeId === id ? (tabs[Math.min(at, tabs.length - 1)] ?? null) : s.activeId,
                  floatingId: s.floatingId === id ? null : s.floatingId,
                  pageId: s.pageId === id ? null : s.pageId,
                };
              }),
            minimise: (id) =>
              set((s) => ({
                floatingId: id,
                pageId: s.pageId === id ? null : s.pageId,
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                unread: s.unread.filter((u) => u !== id),
              })),
            restoreToPanel: (id) =>
              set((s) => ({
                floatingId: s.floatingId === id ? null : s.floatingId,
                pageId: s.pageId === id ? null : s.pageId,
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                activeId: id,
                unread: s.unread.filter((u) => u !== id),
              })),
            fullScreen: (id) =>
              set((s) => ({
                pageId: id,
                pageView: "chat",
                floatingId: s.floatingId === id ? null : s.floatingId,
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                unread: s.unread.filter((u) => u !== id),
              })),
            openOnPage: (id) =>
              set((s) => ({
                pageId: id,
                pageView: "chat",
                floatingId: id && s.floatingId === id ? null : s.floatingId,
                unread: id ? s.unread.filter((u) => u !== id) : s.unread,
              })),
            closeFloating: () => set({ floatingId: null }),
            markRead: (id) => set((s) => ({ unread: s.unread.filter((u) => u !== id) })),
            deleteConversation: async (id) => {
              if (!isTempAsk(id)) {
                await orgAgent.deleteAsk(id);
              }
              set((s) => {
                const asks = { ...s.asks };
                delete asks[id];
                const logs = { ...s.logs };
                delete logs[id];
                const tabs = s.tabs.filter((t) => t !== id);
                return {
                  asks,
                  logs,
                  tabs,
                  activeId: s.activeId === id ? (tabs[tabs.length - 1] ?? null) : s.activeId,
                  floatingId: s.floatingId === id ? null : s.floatingId,
                  pageId: s.pageId === id ? null : s.pageId,
                  unread: s.unread.filter((u) => u !== id),
                  pinned: s.pinned.filter((p) => p !== id),
                };
              });
            },
          },
        };
      },
      {
        name: "atlas-org-agent",
        version: 3,
        // Versions 1 and 2 kept conversations on this machine, before the
        // server held them; their ids name nothing on the server. Only where
        // things were shown carries over, and only the parts that still mean
        // something: the composer's level.
        migrate: (persisted, version) => {
          const p = (persisted ?? {}) as Partial<OrgAgentState>;
          if (version < 3) return { effort: p.effort ?? "medium" } as OrgAgentState;
          return p as OrgAgentState;
        },
        partialize: (s) => ({
          orgId: s.orgId,
          tabs: s.tabs,
          activeId: s.activeId,
          floatingId: s.floatingId,
          pageId: s.pageId,
          unread: s.unread,
          pinned: s.pinned,
          effort: s.effort,
        }),
      },
    ),
  ),
);

/** Every conversation, most recently active first — the history. Loop runs
 *  and conversations that have not started are left out. */
export function asksByRecent(asks: Record<string, AskSummary>): AskSummary[] {
  return Object.values(asks)
    .filter((a) => a.kind === "ask")
    .sort((a, b) => b.updated_at - a.updated_at);
}

/** Messages still on their way for this conversation, oldest first. */
export function pendingFor(outbox: PendingSend[], id: string): PendingSend[] {
  return outbox.filter((p) => p.askId === id || p.tempAskId === id);
}

type Snapshot = ReturnType<typeof useOrgAgentStore.getState>;

/** A conversation's title: the server's, "New chat" until its first message
 *  names it. Selector-shaped. */
export function askTitle(s: Snapshot, id: string): string {
  const title = s.asks[id]?.title?.trim();
  return title || NEW_CHAT_TITLE;
}

/** Whether Atlas is working on a conversation, or a message to it is on its
 *  way. Selector-shaped. */
export function askBusy(s: Snapshot, id: string): boolean {
  const sending = s.outbox.some((p) => !p.failed && (p.askId === id || p.tempAskId === id));
  // A conversation that has not started has only its outbox to go on: a
  // refused first message leaves it waiting for Retry, not working.
  if (isTempAsk(id)) return sending;
  const status = s.logs[id]?.ask.status ?? s.asks[id]?.status ?? "idle";
  return status === "running" || sending;
}

/** Whether a conversation is waiting on the member: an approval or a question. */
export function askWaiting(s: Snapshot, id: string): boolean {
  const status = s.logs[id]?.ask.status ?? s.asks[id]?.status ?? "idle";
  return status === "waiting_approval" || status === "waiting_answer";
}
