import { useEffect } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectFacts } from "@/features/capture/lib/project-facts";
import { reportTipShown } from "../lib/tips-api";
import { openExternal } from "@/features/feedback/lib/feedback-links";
import { STAR_PROMPT_ID } from "../lib/tip-registry";
import { useTipsStore } from "../stores/tips-store";

/**
 * The tips that are not a place the user reaches, so no panel can ask for
 * them on mount. Mounted once per window, beside `TipHost`.
 *
 * - **surfaces**: after the first agent turn that finishes, when the user has
 *   seen the agent work and is ready for what sits beside it.
 * - **sign-in**: once the first checkpoint exists, while signed out. Asked
 *   once, ever (the registry marks it unreplayable).
 * - **Get started's "Add a project"**: ticked as soon as a project exists,
 *   for anyone Get started is for.
 * - **The star prompt**: not a tip — a toast, since it points at nothing —
 *   once the user has come back on STAR_AFTER_DAYS days and reached their
 *   first checkpoint, at the end of a turn. Recorded when answered: closing
 *   Atlas with it unanswered means it asks once more next time.
 */

/** Days Atlas must have been opened on before asking for a star. */
const STAR_AFTER_DAYS = 3;
const REPO_URL = "https://github.com/tryatlas/atlas";

export function TipTriggers() {
  const loaded = useTipsStore.use.loaded();
  const checkpointDone = useTipsStore((s) => s.checklist.includes("checkpoint"));
  const signedIn = useAuthStore((s) => s.snapshot.status === "signed-in");
  const hasProject = useProjectStore((s) => s.projects.length > 0);
  const hydrated = useAppStore.use.hydrated();
  const skipped = useTipsStore.use.getStartedSkipped();
  const projectPath = useAppStore((s) => s.currentProject?.path ?? null);
  const capturing = useProjectFacts(projectPath)?.binding?.enabled ?? false;

  // Before the project list arrives every upgrader looks project-less.
  useEffect(() => {
    if (loaded && hydrated) useTipsStore.getState().actions.decideGetStarted(hasProject);
  }, [loaded, hydrated, hasProject]);

  useEffect(() => {
    if (skipped === false && hasProject)
      void useTipsStore.getState().actions.completeItem("add-project");
  }, [skipped, hasProject]);

  // Auth starts out "signed-out" until it hydrates, so a request made in that
  // gap is withdrawn the moment the real answer arrives.
  useEffect(() => {
    const { request, withdraw } = useTipsStore.getState().actions;
    if (signedIn) withdraw("sign-in");
    else if (loaded && checkpointDone) request("sign-in");
  }, [loaded, checkpointDone, signedIn]);

  // The capture tip says capture is off; once it is on, that is no longer true.
  useEffect(() => {
    if (capturing) useTipsStore.getState().actions.withdraw("capture");
  }, [capturing]);

  // A turn finishing: any session leaving "running" for "idle".
  useEffect(
    () =>
      useChatStore.subscribe((state, prev) => {
        const finished = Object.entries(state.sessions).some(
          ([id, s]) => s.status === "idle" && prev.sessions[id]?.status === "running",
        );
        if (!finished) return;
        useTipsStore.getState().actions.request("surfaces");
        maybeAskForStar();
      }),
    [],
  );

  return null;
}

let starShown = false;

function maybeAskForStar() {
  const s = useTipsStore.getState();
  const due =
    s.loaded &&
    !starShown &&
    !s.seen.includes(STAR_PROMPT_ID) &&
    s.activeDays.length >= STAR_AFTER_DAYS &&
    s.checklist.includes("checkpoint") &&
    s.active === null &&
    document.hasFocus();
  if (!due) return;
  starShown = true;
  void reportTipShown(STAR_PROMPT_ID).catch(() => {});

  // The first way it closes is the one recorded.
  let settled = false;
  const settle = (outcome: "done" | "dismissed") => {
    if (settled) return;
    settled = true;
    void useTipsStore.getState().actions.markSeen(STAR_PROMPT_ID, outcome);
  };

  // DRAFT COPY.
  toast("Enjoying Atlas?", {
    description: "A star on GitHub helps other teams find it.",
    icon: <Star className="size-4 text-warning" />,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Star on GitHub",
      onClick: () => {
        settle("done");
        void openExternal(REPO_URL);
      },
    },
    cancel: { label: "Dismiss", onClick: () => settle("dismissed") },
    onDismiss: () => settle("dismissed"),
  });
}
