import { useEffect } from "react";
import { confirm } from "@/lib/confirm";
import { busySessions } from "@/features/projects/lib/stop-agents-confirm";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { onQuitRequested, quitGuardAnswer, quitGuardReady } from "./quit-guard-api";

/**
 * Answer a held quit (`confirmQuitWhileRunning`): straight away when no agent
 * is mid-turn, and otherwise only once the user says so. Quitting again while
 * the question is open quits anyway — Rust lets the second one through.
 */
export function useQuitGuard() {
  useEffect(() => {
    let disposed = false;
    const unlisten = onQuitRequested(() => {
      const running = busySessions().length;
      if (running === 0) {
        void quitGuardAnswer(true);
        return;
      }
      // With continuation on, the cut-short turns carry on at the next launch
      // (`restart_continuation.rs`), so quitting pauses rather than loses.
      const continues = useSettingsStore.getState().settings.continueSessionsAfterRestart;
      const them = running === 1 ? "it" : "them";
      void confirm({
        title: running === 1 ? "An agent is still running" : `${running} agents are still running`,
        body: continues
          ? `Quitting stops ${them} for now. When Atlas opens again, ${running === 1 ? "its session continues" : "their sessions continue"} where ${running === 1 ? "it" : "they"} left off. Quit again to skip this.`
          : `Quitting stops ${them}. The conversation${running === 1 ? " stays" : "s stay"} in history, but the work in progress is lost. Quit again to skip this.`,
        confirmLabel: "Quit",
        destructive: true,
      }).then((quit) => quitGuardAnswer(quit));
    });
    void unlisten.then(() => {
      if (!disposed) void quitGuardReady();
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
}
