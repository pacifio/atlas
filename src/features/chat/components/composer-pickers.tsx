// The composer's two pickers, mounted once their lazy chunks have landed:
// the `@` mention picker and the `/` command picker.

import { agentMeta } from "@/features/agents/lib/agent-meta";
import type { MentionPicker as MentionPickerComponent } from "@/features/mentions/components/mention-picker";
import type { AgentType } from "@/types/agent";
import type { useComposerPickers } from "../hooks/use-composer-pickers";
import type { SlashCommandPicker as SlashCommandPickerComponent } from "./slash-command-picker";
import { SlashPickerHost } from "./slash-picker-host";

export function ComposerPickers({
  tabId,
  agentType,
  projectPath,
  pickers,
  LazyMentionPicker,
  LazySlashPicker,
}: {
  tabId: string;
  agentType: AgentType;
  projectPath: string | null;
  pickers: ReturnType<typeof useComposerPickers>;
  LazyMentionPicker: typeof MentionPickerComponent | null;
  LazySlashPicker: typeof SlashCommandPickerComponent | null;
}) {
  const { trigger } = pickers;
  return (
    <>
      {LazyMentionPicker && (
        <LazyMentionPicker
          ref={pickers.pickerRef}
          open={trigger !== null}
          query={trigger?.query ?? ""}
          anchor={trigger?.anchor ?? null}
          initialScope={trigger?.scope ?? null}
          projectPath={projectPath}
          // Per-agent component gating: pack components (command/agent/rule)
          // only list ones enabled for the active agent (registry ids
          // "claude-code" / "codex" match agentType).
          agentId={agentType}
          tabId={tabId}
          onSelect={pickers.handleMentionSelect}
          onClose={() => pickers.setTrigger(null)}
        />
      )}
      {LazySlashPicker && (
        <SlashPickerHost
          Picker={LazySlashPicker}
          store={pickers.slashStore}
          pickerRef={pickers.slashPickerRef}
          onSelect={pickers.handleSlashSelect}
          commands={pickers.agentSlashCommands}
          loading={pickers.slashCommandsLoading}
          // One resolver instead of an if-ladder that missed the native agent
          // (it fell through to the picker's "Claude Code commands" default).
          footerLabel={`${agentMeta(agentType).label} commands`}
        />
      )}
    </>
  );
}
