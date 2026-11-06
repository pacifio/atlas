import { describe, expect, it } from "vitest";
import {
  AlertTriangle,
  BellRing,
  Download,
  GitBranch,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import type { NotificationKind } from "./catalog";
import { sourceIconFor } from "./source-icon";

describe("sourceIconFor", () => {
  it.each<[NotificationKind, unknown, string]>([
    ["atlas-signed-out", KeyRound, "primary"],
    ["app-update-ready", Download, "primary"],
    ["model-download-done", Download, "muted"],
    ["model-download-failed", Download, "error"],
    ["git-op-done", GitBranch, "muted"],
    ["git-op-failed", GitBranch, "error"],
    ["git-autofetch-failing", GitBranch, "warning"],
    ["git-behind", GitBranch, "warning"],
    ["config-error", AlertTriangle, "warning"],
    ["agent-update-failed", Download, "warning"],
    ["security-finding", ShieldAlert, "error"],
    ["pull-request-guide", GitPullRequest, "muted"],
    ["terminal-failed", AlertTriangle, "error"],
    ["terminal-attention", BellRing, "warning"],
  ])("%s", (kind, icon, tone) => {
    expect(sourceIconFor(kind)).toEqual({ icon, tone });
  });

  it("falls back to the source's icon, then a sparkle", () => {
    expect(sourceIconFor("chat-dm")).toEqual({ icon: MessageSquare, tone: "primary" });
    expect(sourceIconFor("terminal-done")).toEqual({ icon: SquareTerminal, tone: "muted" });
    expect(sourceIconFor("agent-done")).toEqual({ icon: Sparkles, tone: "muted" });
  });
});
