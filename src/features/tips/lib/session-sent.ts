import { captureBinding } from "@/features/capture/lib/capture-api";
import { useTipsStore } from "../stores/tips-store";

/**
 * The user sent a message in a session: Get started's "Run a session" is
 * done, and if this project isn't capturing, the capture tip is due — that
 * session is about to go unrecorded.
 */
export function noteSessionSent(projectPath: string | null): void {
  const { seen, actions } = useTipsStore.getState();
  void actions.completeItem("run-session");
  if (!projectPath || seen.includes("capture")) return;
  void captureBinding(projectPath)
    .then((binding) => {
      if (!binding?.enabled) actions.request("capture");
    })
    .catch(() => {});
}
