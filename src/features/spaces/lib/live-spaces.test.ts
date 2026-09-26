import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const api = vi.hoisted(() => ({
  connect: vi.fn<(convId: string) => Promise<void>>(),
  disconnect: vi.fn<(convId: string) => Promise<void>>(),
}));

vi.mock("./spaces-api", () => ({ spacesApi: api }));
vi.mock("./spaces-bus", () => ({
  spaceBusReady: async () => {},
  spaceConnection: () => "open",
  subscribeSpaceBus: () => () => {},
}));

import { acquireSpaceSocket, releaseSpaceSocket } from "./live-spaces";

/** Every queued socket step settled. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  calls.length = 0;
  api.connect.mockReset().mockImplementation(async (convId) => {
    calls.push(`connect ${convId}`);
  });
  api.disconnect.mockReset().mockImplementation(async (convId) => {
    calls.push(`disconnect ${convId}`);
  });
});

describe("the conversation's socket, held through live-spaces", () => {
  it("is closed only by the last holder out", async () => {
    await acquireSpaceSocket("c-last");
    await acquireSpaceSocket("c-last");
    releaseSpaceSocket("c-last");
    await settled();
    expect(calls).toEqual(["connect c-last", "connect c-last"]);
    releaseSpaceSocket("c-last");
    await settled();
    expect(calls).toEqual(["connect c-last", "connect c-last", "disconnect c-last"]);
  });

  it("takes no hold when the connect fails, so a later canvas unmount still disconnects", async () => {
    api.connect.mockRejectedValueOnce("offline");
    await expect(acquireSpaceSocket("c-fail")).rejects.toBe("offline");

    // A write holds it and gives it back: had the failed connect counted, the
    // socket would stay open with nobody holding it.
    await acquireSpaceSocket("c-fail");
    releaseSpaceSocket("c-fail");
    await settled();
    expect(calls).toEqual(["connect c-fail", "disconnect c-fail"]);

    // The canvas whose connect failed unmounts: nothing is held, and the
    // socket is closed rather than left half-open.
    calls.length = 0;
    api.connect.mockRejectedValueOnce("offline");
    await expect(acquireSpaceSocket("c-canvas")).rejects.toBe("offline");
    releaseSpaceSocket("c-canvas");
    await settled();
    expect(calls).toEqual(["disconnect c-canvas"]);
  });

  it("dials again only after a release's disconnect, so it never closes a socket a new holder just took", async () => {
    await acquireSpaceSocket("c-order");
    let finishDisconnect!: () => void;
    api.disconnect.mockImplementationOnce(
      (convId) =>
        new Promise<void>((resolve) => {
          calls.push(`disconnect ${convId} started`);
          finishDisconnect = () => {
            calls.push(`disconnect ${convId} done`);
            resolve();
          };
        }),
    );

    releaseSpaceSocket("c-order");
    const next = acquireSpaceSocket("c-order");
    await settled();
    expect(calls).toEqual(["connect c-order", "disconnect c-order started"]);

    finishDisconnect();
    await next;
    expect(calls).toEqual([
      "connect c-order",
      "disconnect c-order started",
      "disconnect c-order done",
      "connect c-order",
    ]);

    // The new holder's socket stays up until it is given back.
    releaseSpaceSocket("c-order");
    await settled();
    expect(calls[calls.length - 1]).toBe("disconnect c-order");
  });

  it("keeps other conversations' sockets out of one conversation's queue", async () => {
    await acquireSpaceSocket("c-a");
    api.disconnect.mockImplementationOnce(() => new Promise<void>(() => {}));
    releaseSpaceSocket("c-a");
    await acquireSpaceSocket("c-b");
    expect(calls).toContain("connect c-b");
  });
});
