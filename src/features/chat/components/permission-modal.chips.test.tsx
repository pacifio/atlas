// @vitest-environment happy-dom
//
// The permission prompt draws an agent's plan, but must never offer a click on
// a path in it: the user is being asked to approve, and a chip there would put
// a file a click away from the Allow button. The same text in the plans panel
// does get chips, which this pins beside it so the negative means something.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/features/app/stores/app-store";
import { Markdown } from "@/lib/markdown";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

const PROJECT = "/Users/dev/acme-app";
const PLAN = "1. Edit `src/lib/api.ts:12`\n2. Then [the helper](src/lib/utils.ts)";

beforeAll(async () => {
  await import("@/lib/markdown-impl");
}, 30_000);

afterEach(cleanup);

describe("file chips and the permission prompt", () => {
  it("draws a plan in the permission prompt with no chips", async () => {
    useAppStore.setState({ currentProject: { path: PROJECT, name: "acme-app" } as never });
    useChatStore.setState({
      sessions: {
        "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
      } as never,
      pendingPermissions: {
        "sess-1": [
          {
            agentId: "atlas-agent",
            acpSessionId: "sess-1",
            requestId: "req-1",
            toolCall: {
              toolCallId: "call-1",
              title: "Ready to code?",
              kind: "switch_mode",
              toolName: "ExitPlanMode",
              rawInput: { plan: PLAN },
              content: [],
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Decline", kind: "reject_once" },
            ],
          },
        ],
      } as never,
    });
    const { container } = render(<PermissionModal tabId="chat-1" />);
    await waitFor(() => expect(screen.getByText("src/lib/api.ts:12").tagName).toBe("CODE"));
    expect(container.querySelector(".atlas-file-chip")).toBeNull();
    expect(container.querySelector("[data-file-path]")).toBeNull();
  });

  it("draws the same plan with chips where a surface asks for them", async () => {
    const { container } = render(<Markdown fileRoot={PROJECT}>{PLAN}</Markdown>);
    await waitFor(() => expect(container.querySelectorAll(".atlas-file-chip")).toHaveLength(2));
  });
});
