import { toast } from "sonner";
import { useTipsStore } from "../stores/tips-store";

/** Replay all tips, said aloud: what Settings and ⌘K both run. */
export async function replayAllTips(): Promise<void> {
  try {
    await useTipsStore.getState().actions.replayAll();
    toast.success("Tips will show again as you meet each feature");
  } catch {
    toast.error("Couldn't reset tips");
  }
}
