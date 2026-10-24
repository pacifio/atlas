import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { useAppStore } from "@/features/app/stores/app-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { SettingSwitch } from "../layout/setting-controls";
import { EmbeddingModelSection } from "./embedding-model-section";

export function MemoryPage() {
  const settings = useSettingsStore.use.settings();
  // The memory mirror lives outside the project; this shows the open
  // project's copy in the file manager.
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const openMemoryMirror = async () => {
    if (!projectPath) return;
    try {
      const dir = await invoke<string | null>("memory_repo_mirror_dir", { projectPath });
      if (!dir) {
        toast("This project's memory mirror hasn't been written yet");
        return;
      }
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(dir);
    } catch (e) {
      toast.error(`Couldn't open the mirror: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <SettingsPage
      scopeable
      title="Memory"
      description="Shared memory across agents, instructions mirrored for them, and the model memory search runs on."
    >
      <SettingsSection title="Shared memory">
        <SettingsGroup>
          <SettingsRow
            setting="atlasOnlyMemory"
            description="Agents that keep their own memory, such as Claude Code's auto memory, start with it off, so every agent reads and writes the one shared memory."
            control={<SettingSwitch setting="atlasOnlyMemory" />}
          />
          <SettingsRow
            setting="memoryDreams"
            description="Once a day, when there are new sessions, the memory model proposes changes. They wait in Memory › Review; nothing changes without you."
            control={<SettingSwitch setting="memoryDreams" />}
          />
          <SettingsRow
            setting="memoryRepoMirror"
            description="A read-only copy of each project's memory as a local git repository outside the project, in the open Agent Memory Repo format. Nothing is pushed."
            control={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!settings.memoryRepoMirror || !projectPath}
                  onClick={() => void openMemoryMirror()}
                >
                  Open folder
                </Button>
                <SettingSwitch setting="memoryRepoMirror" />
              </>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Instructions">
        <SettingsGroup>
          <SettingsRow
            setting="instructionSync"
            description="Keeps a marked block of the project's AGENTS.md in step with CLAUDE.md and every .claude/rules file. Your text outside the block is never changed; turning this off removes the block."
            control={<SettingSwitch setting="instructionSync" />}
          />
        </SettingsGroup>
      </SettingsSection>

      <EmbeddingModelSection />
    </SettingsPage>
  );
}
