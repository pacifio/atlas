/**
 * Atlas Agent drawing on a Space page (`org_page_write`): the window's half
 * of the organisation call that crosses to it. Rust has checked the document
 * and resolved the conversation; this finds the page, lays the document out
 * (`space-layout.ts`), turns it into one CRDT update through the page codec
 * (`space-diagram.ts`), and sends it on the Space's own sync:
 *
 *  - **the page is open on a canvas here** — the update is applied to that
 *    canvas's doc as a local edit, and the canvas sends it as it sends the
 *    user's own (it is even on their undo stack);
 *  - **it is not** — the page is opened on the conversation's socket (shared
 *    with any canvas on another page, held through `live-spaces`), its
 *    content read from `page.opened` as a canvas reads it, and the update
 *    framed onto the slot the Space gave it.
 *
 * Either way the Space relays the update to every other client with the page
 * open, which is how a teammate watching it sees the diagram appear.
 *
 * A refusal throws a `PageWriteRefusal` in the words the model reads; the
 * page is left as it was.
 */
import * as Y from "yjs";

import { toBase64 } from "@/features/comms/lib/draft-sync";
import { applyPageContent, frameUpdate, LOCAL } from "./space-doc";
import { drawingUpdate } from "./space-diagram";
import { layoutDiagram, type Diagram } from "./space-layout";
import {
  parseServerMessage,
  type SpaceBridgeEvent,
  type SpaceClientMessage,
  type SpaceConnState,
  type SpaceServerMessage,
  type SpaceSummary,
} from "./spaces-api";
import { SPACE_DOC_VERSION, SPACE_FRAME_HEADER_BYTES, SPACE_UPDATE_MAX_BYTES } from "./space-wire";

export class PageWriteRefusal extends Error {}

const NOTHING = "Nothing was drawn.";
const refuse = (words: string): never => {
  throw new PageWriteRefusal(`${words} ${NOTHING}`);
};

/** What a write needs of the Space, as a seam: the app's is
 *  `appSpaceTransport` (`live-spaces.ts`); the tests' is in memory. */
export interface SpacePageTransport {
  /** The Space's summary: its page tree, archive state and doc version. */
  summary(convId: string): Promise<SpaceSummary>;
  /** The page's doc as a canvas here holds it, caught up; else `null`. */
  openPage(convId: string, pageId: string): { doc: Y.Doc; readOnly: string | null } | null;
  /** Hold the conversation's socket (dialling it if nobody does), and give
   *  it back. A rejected hold holds nothing, and is not given back. */
  acquire(convId: string): Promise<void>;
  release(convId: string): void;
  connection(convId: string): SpaceConnState;
  subscribe(convId: string, listener: (ev: SpaceBridgeEvent) => void): () => void;
  sendControl(convId: string, message: SpaceClientMessage): Promise<void>;
  sendBinary(convId: string, data: string): Promise<void>;
}

export interface PageWritten {
  page_id: string;
  name: string;
  nodes_placed: number;
  edges_placed: number;
}

/** How long the whole write may take. Inside the window's own deadline for an
 *  action, so a slow Space is refused here — with the socket given back —
 *  rather than abandoned mid-open; and nothing is sent once it has passed, so
 *  a write the model was told failed never lands late. */
export const PAGE_OPEN_TIMEOUT_MS = 6_000;

/** The Space bounds one update's payload; the frame adds its header. */
const UPDATE_MAX = SPACE_UPDATE_MAX_BYTES - SPACE_FRAME_HEADER_BYTES;

function checkSize(update: Uint8Array): void {
  if (update.length > UPDATE_MAX) {
    refuse(
      `the drawing is ${Math.ceil(update.length / 1024)} KiB, over the Space's ${Math.floor(UPDATE_MAX / 1024)} KiB ` +
        "for one update; draw fewer nodes or shorter text.",
    );
  }
}

type Opened = Extract<SpaceServerMessage, { t: "page.opened" }>;

/** Open `pageId` on the conversation's socket and answer what `page.opened`
 *  carried. The caller holds the socket and has subscribed `events`. */
async function openOnSocket(
  transport: SpacePageTransport,
  convId: string,
  pageId: string,
  events: EventQueue,
  deadline: number,
): Promise<Opened> {
  if (transport.connection(convId) !== "open") {
    await events.next(deadline, (ev) => {
      if (ev.kind !== "connection") return undefined;
      if (ev.state === "open") return true;
      if (ev.state === "unavailable") {
        return refuse(
          "the Space would not let you in: you may no longer be a member of the conversation.",
        );
      }
      return undefined;
    });
  }
  await transport.sendControl(convId, { t: "page.open", page_id: pageId });
  return events.next(deadline, (ev) => {
    if (ev.kind !== "control") return undefined;
    const msg = parseServerMessage(ev.frame);
    if (msg?.t === "page.opened" && msg.page_id === pageId) return msg;
    if (msg?.t === "error")
      return refuse(`the Space refused the page: ${msg.error.message || msg.error.code}.`);
    return undefined;
  });
}

/** The socket's events as they come, read in order by whoever waits next. */
class EventQueue {
  private readonly buffer: SpaceBridgeEvent[] = [];
  private wake: (() => void) | null = null;

  push = (ev: SpaceBridgeEvent) => {
    this.buffer.push(ev);
    this.wake?.();
  };

  /** The first event (from here on) `pick` answers for; `pick` may throw to
   *  refuse. */
  async next<T>(deadline: number, pick: (ev: SpaceBridgeEvent) => T | undefined): Promise<T> {
    for (;;) {
      while (this.buffer.length > 0) {
        const found = pick(this.buffer.shift()!);
        if (found !== undefined) return found;
      }
      const left = deadline - Date.now();
      if (left <= 0) return refuse("the Space did not open the page in time; try again.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }
}

export async function writeSpacePage(
  transport: SpacePageTransport,
  target: { convId: string; pageId: string },
  diagram: Diagram,
  timeoutMs = PAGE_OPEN_TIMEOUT_MS,
): Promise<PageWritten> {
  const { convId, pageId } = target;
  const deadline = Date.now() + timeoutMs;
  const inTime = () => {
    if (Date.now() > deadline) refuse("the Space did not open the page in time; try again.");
  };
  let summary: SpaceSummary;
  try {
    summary = await transport.summary(convId);
  } catch (e) {
    return refuse(
      `the conversation's Space could not be read: ${typeof e === "string" ? e : String(e)}.`,
    );
  }
  const page = summary.pages.find((p) => p.id === pageId);
  if (!page)
    refuse(`the conversation's Space has no page ${pageId}; org_page_create answers a page's id.`);
  if (page!.kind !== "page")
    refuse(`"${page!.name}" is a folder, not a page; draw on a page in it.`);
  if (summary.archived) refuse("the conversation is archived, so its Space is read-only.");
  if (summary.doc_version > SPACE_DOC_VERSION) {
    refuse("a newer Atlas wrote this Space's pages; update Atlas to draw on them.");
  }

  inTime();
  const placed = layoutDiagram(diagram);
  const answer: PageWritten = {
    page_id: pageId,
    name: page!.name,
    nodes_placed: placed.nodes.length,
    edges_placed: placed.edges.length,
  };

  const live = transport.openPage(convId, pageId);
  if (live) {
    if (live.readOnly !== null) refuse(`the page is read-only (${live.readOnly}).`);
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(live.doc));
    const update = drawingUpdate(scratch, placed);
    scratch.destroy();
    checkSize(update);
    // A local edit to the canvas's doc: the canvas sends it on its slot.
    Y.applyUpdate(live.doc, update, LOCAL);
    return answer;
  }

  const events = new EventQueue();
  const unsubscribe = transport.subscribe(convId, events.push);
  // A hold is given back only once taken: a connect that fails takes none.
  let held = false;
  try {
    try {
      await transport.acquire(convId);
    } catch (e) {
      return refuse(
        `the conversation's Space could not be reached: ${typeof e === "string" ? e : String(e)}.`,
      );
    }
    held = true;
    const opened = await openOnSocket(transport, convId, pageId, events, deadline);
    if (opened.read_only !== null) refuse(`the page is read-only (${opened.read_only}).`);
    const scratch = new Y.Doc();
    applyPageContent(scratch, opened);
    const update = drawingUpdate(scratch, placed);
    scratch.destroy();
    checkSize(update);
    inTime();
    await transport.sendBinary(convId, toBase64(frameUpdate(opened.slot, update)));
    return answer;
  } finally {
    // Queued frames still go out: the socket drains before it closes.
    if (held) transport.release(convId);
    unsubscribe();
  }
}
