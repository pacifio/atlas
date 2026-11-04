// @vitest-environment happy-dom
//
// The Organisation inbox: a page read through Rust, grouped by day, members
// named from the directory and guests from the row; opening a row marks it
// read and lands on the Session's thread on the Timeline; the filters and
// Mark all read go through Rust and decide nothing themselves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as [string, Record<string, unknown>][]);
const page = vi.hoisted(() => ({ entries: [] as unknown[], unread: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === "artifacts_cloud_inbox") {
      return Promise.resolve({ entries: page.entries, unread: page.unread, nextCursor: null });
    }
    if (cmd === "auth_list_members") return Promise.resolve([]);
    return Promise.resolve(undefined);
  }),
  convertFileSrc: (p: string) => p,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
// The days are the Timeline's calendar (`@tryatlas/design/timeline-calendar`): its sticky
// date animates with `motion`, and its list is virtualized — which renders
// nothing in happy-dom, where every element measures zero. As in the board's
// own tests, the animation is passed through and the window made total.
vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
          const { initial, animate, exit, transition, ...rest } = props;
          void initial;
          void animate;
          void exit;
          void transition;
          return createElement(tag, rest, children);
        },
    },
  ),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey: (i: number) => string;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 80,
        size: 80,
        end: index * 80 + 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    // The package calendar indexes this for its end space even with
    // `endSpace` off; a missing array would throw.
    measurementsCache: [],
  }),
}));

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { InboxEntry } from "../lib/inbox-api";
import { InboxPanel } from "./inbox-panel";

function entry(id: string, over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id,
    kind: "artifact_session_comment",
    orgId: "org-1",
    workspaceId: "ws-1",
    workspaceSlug: "atlas",
    sessionId: "ses-1",
    sessionTitle: "Fix the flaky test",
    commentId: `cm-${id}`,
    anchorKind: "tool_call",
    anchorId: "tc-9",
    actorId: "u-priya",
    actorName: null,
    excerpt: "did this one write the file?",
    createdAt: new Date().toISOString(),
    readAt: null,
    path: "",
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  page.entries = [];
  page.unread = 0;
  useOrgStore.setState({
    organisations: [{ id: "org-1", name: "Acme", remoteId: "org-1" }] as never,
    activeOrganisationId: "org-1",
  } as never);
  useMembersStore.setState({
    byOrg: {
      "org-1": {
        members: [
          {
            id: "m-priya",
            userId: "u-priya",
            name: "Priya Raghunathan",
            email: "priya@acme.dev",
            role: null,
            createdAt: null,
            avatarPath: null,
            isOwner: false,
          },
        ],
        invitations: [],
        loadedAt: Date.now(),
        loading: false,
        error: null,
      },
    },
  });
  useArtifactsStore.setState({ open: null } as never);
});
afterEach(cleanup);

const reads = () => calls.filter(([cmd]) => cmd === "artifacts_cloud_inbox");
const marks = () => calls.filter(([cmd]) => cmd === "artifacts_cloud_inbox_read");

describe("InboxPanel", () => {
  it("names a member from the directory and a guest from the row", async () => {
    page.entries = [
      entry("n1"),
      entry("n2", { actorId: "g-1", actorName: "Waiz", kind: "artifact_mention" }),
    ];
    render(<InboxPanel />);
    expect(await screen.findByText("Priya Raghunathan")).toBeTruthy();
    expect(screen.getByText("Waiz")).toBeTruthy();
    expect(screen.getByText("Guest")).toBeTruthy();
    expect(screen.getByText("mentioned you on")).toBeTruthy();
  });

  it("opens a row on the Timeline at its comment's thread, and marks it read", async () => {
    page.entries = [entry("n1")];
    page.unread = 1;
    render(<InboxPanel />);
    await userEvent.click(await screen.findByText("did this one write the file?"));
    expect(marks()).toEqual([["artifacts_cloud_inbox_read", { ids: ["n1"], all: false }]]);
    expect(useArtifactsStore.getState().open).toEqual({
      sessionId: "ses-1",
      projectPath: "",
      remoteProjectId: "ws-1",
      anchor: { kind: "tool_call", id: "tc-9" },
    });
  });

  it("reads each filter through Rust, and marks everything read", async () => {
    page.entries = [entry("n1")];
    page.unread = 1;
    render(<InboxPanel />);
    await screen.findByText("Priya Raghunathan");
    await userEvent.click(screen.getByRole("radio", { name: "Mentions" }));
    expect(reads()[reads().length - 1]?.[1]).toEqual({ filter: "mentions", cursor: null });
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(marks()[marks().length - 1]).toEqual([
      "artifacts_cloud_inbox_read",
      { ids: [], all: true },
    ]);
  });

  it("says when there is nothing", async () => {
    render(<InboxPanel />);
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();
  });
});
