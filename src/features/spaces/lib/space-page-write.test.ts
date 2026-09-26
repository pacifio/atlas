import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { fromBase64, toBase64 } from "@/features/comms/lib/draft-sync";
import { addNode, readEdges, readNodes } from "./space-doc";
import type {
  SpaceBridgeEvent,
  SpaceClientMessage,
  SpaceConnState,
  SpaceSummary,
} from "./spaces-api";
import { decodeSpaceFrame, SPACE_DOC_VERSION, SPACE_FRAME_UPDATE } from "./space-wire";
import { PageWriteRefusal, writeSpacePage, type SpacePageTransport } from "./space-page-write";
import type { Diagram } from "./space-layout";

const diagram: Diagram = {
  nodes: [
    { id: "a", kind: "shape", text: "Client" },
    { id: "b", kind: "shape", text: "Server" },
  ],
  edges: [{ from: "a", to: "b", label: "HTTP" }],
};

function summary(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    protocol: 1,
    doc_version: SPACE_DOC_VERSION,
    space_id: "sp-1",
    conv_id: "c-1",
    pages: [
      {
        id: "p-1",
        kind: "page",
        name: "Architecture",
        icon: null,
        parent_id: null,
        sort: 0,
        created_at: 0,
        updated_at: 0,
      },
      {
        id: "f-1",
        kind: "folder",
        name: "Docs",
        icon: null,
        parent_id: null,
        sort: 1,
        created_at: 0,
        updated_at: 0,
      },
    ],
    active_page_id: null,
    archived: false,
    ...over,
  };
}

/** A Space in memory: a page already drawn on, a socket that opens when
 *  held and answers `page.open` as the server does. */
function fakeSpace(
  opts: { connection?: SpaceConnState; readOnly?: "archived" | null; summary?: SpaceSummary } = {},
) {
  const page = new Y.Doc();
  addNode(page, { kind: "note", x: 0, y: 0, title: "old" });
  const listeners = new Set<(ev: SpaceBridgeEvent) => void>();
  const emit = (ev: SpaceBridgeEvent) => queueMicrotask(() => listeners.forEach((l) => l(ev)));
  const log = {
    control: [] as SpaceClientMessage[],
    binary: [] as Uint8Array[],
    holds: 0,
    released: 0,
  };
  let connection: SpaceConnState = opts.connection ?? "disconnected";
  const transport: SpacePageTransport = {
    summary: async () => opts.summary ?? summary(),
    openPage: () => null,
    acquire: async () => {
      log.holds += 1;
      if (connection !== "open") {
        emit({ kind: "connection", state: "connecting" });
        connection = "open";
        emit({ kind: "connection", state: "open" });
      }
    },
    release: () => {
      log.released += 1;
    },
    connection: () => connection,
    subscribe: (_conv, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendControl: async (_conv, message) => {
      log.control.push(message);
      if (message.t === "page.open") {
        // Another page's answer first: it is not this write's.
        emit({
          kind: "control",
          frame: JSON.stringify({
            t: "page.opened",
            page_id: "p-other",
            slot: 1,
            resume: false,
            snapshot: null,
            index: 0,
            updates: [],
            read_only: null,
          }),
        });
        emit({
          kind: "control",
          frame: JSON.stringify({
            t: "page.opened",
            page_id: message.page_id,
            slot: 7,
            resume: false,
            snapshot: toBase64(Y.encodeStateAsUpdate(page)),
            index: 3,
            updates: [],
            read_only: opts.readOnly ?? null,
          }),
        });
      }
    },
    sendBinary: async (_conv, data) => {
      log.binary.push(fromBase64(data)!);
    },
  };
  return { page, transport, log };
}

describe("drawing on a page no canvas here has open", () => {
  it("opens it on the socket, replaces its content in one update on its slot, and gives the socket back", async () => {
    const { page, transport, log } = fakeSpace();
    const answer = await writeSpacePage(transport, { convId: "c-1", pageId: "p-1" }, diagram);
    expect(answer).toEqual({
      page_id: "p-1",
      name: "Architecture",
      nodes_placed: 2,
      edges_placed: 1,
    });
    expect(log.control).toEqual([{ t: "page.open", page_id: "p-1" }]);
    expect(log.binary).toHaveLength(1);
    const frame = decodeSpaceFrame(log.binary[0])!;
    expect(frame).toMatchObject({ type: SPACE_FRAME_UPDATE, slot: 7 });

    // What the Space relays to a teammate with the page open.
    Y.applyUpdate(page, frame.payload);
    expect(
      readNodes(page)
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Client", "Server"]);
    expect(readEdges(page)[0].text).toBe("HTTP");
    expect([log.holds, log.released]).toEqual([1, 1]);
  });

  it("sends at once on a socket a canvas already has open", async () => {
    const { transport, log } = fakeSpace({ connection: "open" });
    await writeSpacePage(transport, { convId: "c-1", pageId: "p-1" }, diagram);
    expect(log.binary).toHaveLength(1);
  });

  it("refuses a read-only page and sends nothing", async () => {
    const { transport, log } = fakeSpace({ readOnly: "archived" });
    await expect(
      writeSpacePage(transport, { convId: "c-1", pageId: "p-1" }, diagram),
    ).rejects.toThrow(/read-only.*Nothing was drawn/);
    expect(log.binary).toHaveLength(0);
    expect(log.released).toBe(1);
  });

  it("refuses in words when the socket cannot be dialled, and gives back no hold it never took", async () => {
    const { transport, log } = fakeSpace();
    transport.acquire = async () => {
      throw "the Space is unreachable";
    };
    const write = writeSpacePage(transport, { convId: "c-1", pageId: "p-1" }, diagram);
    await expect(write).rejects.toBeInstanceOf(PageWriteRefusal);
    await expect(
      writeSpacePage(transport, { convId: "c-1", pageId: "p-1" }, diagram),
    ).rejects.toThrow(/could not be reached: the Space is unreachable.*Nothing was drawn/);
    expect(log.released).toBe(0);
    expect(log.binary).toHaveLength(0);
  });

  it("refuses when the page never opens, in time, and gives the socket back", async () => {
    const { transport, log } = fakeSpace();
    transport.sendControl = async () => {};
    await expect(
      writeSpacePage(transport, { convId: "c-1", pageId: "p-1" }, diagram, 30),
    ).rejects.toThrow(/did not open the page in time/);
    expect(log.released).toBe(1);
  });
});

describe("drawing on a page a canvas here has open", () => {
  it("goes into the canvas's doc as a local edit, for the canvas to send", async () => {
    const { transport, log } = fakeSpace();
    const live = new Y.Doc();
    addNode(live, { kind: "note", x: 0, y: 0, title: "old" });
    const origins: unknown[] = [];
    live.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    transport.openPage = () => ({ doc: live, readOnly: null });
    await writeSpacePage(transport, { convId: "c-1", pageId: "p-1" }, diagram);
    expect(
      readNodes(live)
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Client", "Server"]);
    expect(origins).toEqual(["local"]);
    expect(log.control).toEqual([]);
    expect(log.holds).toBe(0);
  });
});

describe("a page that cannot be drawn on", () => {
  it.each([
    ["missing", { pageId: "p-nope" }, summary(), /has no page p-nope/],
    ["a folder", { pageId: "f-1" }, summary(), /"Docs" is a folder/],
    ["archived", { pageId: "p-1" }, summary({ archived: true }), /archived/],
    ["newer", { pageId: "p-1" }, summary({ doc_version: SPACE_DOC_VERSION + 1 }), /newer Atlas/],
  ])("is refused when %s", async (_what, target, s, words) => {
    const { transport, log } = fakeSpace({ summary: s });
    const write = writeSpacePage(transport, { convId: "c-1", ...target }, diagram);
    await expect(write).rejects.toBeInstanceOf(PageWriteRefusal);
    await expect(writeSpacePage(transport, { convId: "c-1", ...target }, diagram)).rejects.toThrow(
      words,
    );
    expect(log.holds).toBe(0);
  });
});
