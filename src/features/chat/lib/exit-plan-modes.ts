import type { ClaudePermissionMode } from "@/types/agent";

/**
 * What a Claude Code plan-approval choice does to the session's permission
 * mode — the half of the answer the adapter never tells us.
 *
 * The official Claude ACP adapter (`@agentclientprotocol/claude-agent-acp`)
 * answers an ExitPlanMode prompt with option ids that encode a mode. On
 * selection it hands Claude Code a `setMode` permission update and lets the
 * CLI switch itself; it neither calls its own set-mode path nor emits a
 * `current_mode_update`, so nothing on the wire says the mode changed. The
 * pill stayed on "Plan Mode" and, because Atlas's own bookkeeping still said
 * plan, later pushes could drag the agent back. Mapping the option here is
 * what keeps Atlas, the adapter and the CLI on the same mode.
 *
 * The elevated option is `auto` on models that support auto mode (Fable 5.1+)
 * and `bypass` only where auto is unavailable — auto still prompts for risky
 * tools, which is why "I picked bypass and it still asks" was really "there
 * was no bypass to pick".
 */
const EXIT_PLAN_OPTION_MODE: Record<string, ClaudePermissionMode> = {
  "exit-plan-default": "default",
  "exit-plan-accept-edits": "acceptEdits",
  "exit-plan-auto": "auto",
  "exit-plan-bypass": "bypassPermissions",
  "exit-plan-clear-accept-edits": "acceptEdits",
  "exit-plan-clear-auto": "auto",
  "exit-plan-clear-bypass": "bypassPermissions",
};

/** The mode a plan-approval option switches the session to, or `null` for a
 *  rejection / an option this build does not know. */
export function exitPlanModeForOption(optionId: string): ClaudePermissionMode | null {
  return EXIT_PLAN_OPTION_MODE[optionId] ?? null;
}

/** Clear-context variants restart the session in a fresh context; the adapter
 *  republishes the mode itself once the replacement session is up, and a
 *  `session/set_mode` sent into that restart is refused. Label only. */
export function exitPlanOptionRestartsSession(optionId: string): boolean {
  return optionId.startsWith("exit-plan-clear-");
}

/** Does this approval prompt already offer a bypass choice? When it does not
 *  (an auto-capable model), Atlas adds its own "approve and bypass" action. */
export function exitPlanOffersBypass(optionIds: readonly string[]): boolean {
  return optionIds.some((id) => exitPlanModeForOption(id) === "bypassPermissions");
}
