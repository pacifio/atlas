import { useRemoveAgentConfirmStore } from "../lib/remove-agent-confirm";
import { RemoveAgentDialogView } from "./views/remove-agent-dialog-view";

/**
 * "Remove this agent?" confirmation for Settings → Agents, driven by
 * `useRemoveAgentConfirmStore.ask()`. Mounted once in App. Esc and a click on
 * the backdrop both dismiss, and a dismissal is "Keep".
 */
export function RemoveAgentDialog() {
  const pending = useRemoveAgentConfirmStore.use.pending();
  const { settle } = useRemoveAgentConfirmStore.use.actions();
  if (!pending) return null;

  return (
    <RemoveAgentDialogView
      open
      name={pending.name}
      onKeep={() => settle(false)}
      onRemove={() => settle(true)}
    />
  );
}
