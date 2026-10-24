// What a new chat with an agent starts with: its mode and the options it
// advertises (Fast mode, effort, whatever it offers). Nothing here is
// hand-written per agent — the choices are what the agent advertised in its
// last chat, and the values are the same per-agent picks the composer
// remembers, so changing one in a chat changes it here and the other way
// round. An agent that has never run a chat has nothing to show yet.

import { useState } from "react";
import { Select } from "@/ui/select";
import { parseConfigOptions } from "@/features/chat/lib/acp-config-options";
import { loadCachedAcpConfigOptions } from "@/features/chat/lib/acp-config-options-cache";
import { loadCachedAcpModes } from "@/features/chat/lib/acp-modes-cache";
import {
  clearConfigOptionPref,
  loadConfigOptionPrefs,
  saveConfigOptionPref,
} from "@/features/chat/lib/config-option-prefs";
import { loadLastModePref, saveLastModePref } from "@/features/chat/lib/last-mode-pref";
import { CLAUDE_PERMISSION_MODES, CLAUDE_PERMISSION_MODE_LABEL } from "@/types/agent";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";
import type { AgentItem } from "./agent-install";

const AGENT_DEFAULT = "";

/** The modes a new chat can start in: Claude Code's are fixed, every other
 *  agent's are the ones it last advertised. */
function modesOf(agentType: string): { value: string; label: string }[] {
  if (agentType === "claude-code") {
    // Its own "default" is what "Agent's default" already means.
    return CLAUDE_PERMISSION_MODES.filter((id) => id !== "default").map((id) => ({
      value: id,
      label: CLAUDE_PERMISSION_MODE_LABEL[id],
    }));
  }
  return (
    loadCachedAcpModes(agentType)?.availableModes.map((m) => ({ value: m.id, label: m.name })) ?? []
  );
}

export function AgentDefaultsSection({ item }: { item: AgentItem }) {
  const agentType = item.agentType;
  const [mode, setMode] = useState(() => loadLastModePref(agentType) ?? AGENT_DEFAULT);
  const [prefs, setPrefs] = useState(() => loadConfigOptionPrefs(agentType));
  if (item.state === "native") return null;

  const modes = modesOf(agentType);
  const knobs = parseConfigOptions(loadCachedAcpConfigOptions(agentType) ?? []);
  if (modes.length === 0 && knobs.length === 0) {
    return (
      <SettingsSection title="Defaults">
        <SettingsGroup>
          <SettingsRow
            title="Nothing yet"
            description={`The modes and options ${item.name} offers show here after its first chat.`}
          />
        </SettingsGroup>
      </SettingsSection>
    );
  }

  const setKnob = (id: string, value: boolean | string | null) => {
    if (value === null) clearConfigOptionPref(agentType, id);
    else saveConfigOptionPref(agentType, id, value);
    setPrefs(loadConfigOptionPrefs(agentType));
  };

  return (
    <SettingsSection
      title="Defaults"
      description={`What a new chat with ${item.name} starts with. The choices are what it offered in its last chat; picking one in a chat changes it here too.`}
    >
      <SettingsGroup>
        {modes.length > 0 && (
          <SettingsRow
            title="Mode"
            description="How much it may do before asking."
            control={
              <Select
                size="sm"
                className="w-40 justify-between"
                aria-label={`${item.name}: default mode`}
                value={modes.some((m) => m.value === mode) ? mode : AGENT_DEFAULT}
                options={[{ value: AGENT_DEFAULT, label: "Agent's default" }, ...modes]}
                onValueChange={(next) => {
                  saveLastModePref(agentType, next === AGENT_DEFAULT ? null : next);
                  setMode(next);
                }}
              />
            }
          />
        )}
        {knobs.map((knob) => {
          const pref = prefs[knob.id];
          const label = `${item.name}: default ${knob.name}`;
          if (knob.kind === "boolean") {
            const value = typeof pref === "boolean" ? (pref ? "on" : "off") : AGENT_DEFAULT;
            return (
              <SettingsRow
                key={knob.id}
                title={knob.name}
                description={knob.description ?? undefined}
                control={
                  <Select
                    size="sm"
                    className="w-40 justify-between"
                    aria-label={label}
                    value={value}
                    options={[
                      { value: AGENT_DEFAULT, label: "Agent's default" },
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                    onValueChange={(next) =>
                      setKnob(knob.id, next === AGENT_DEFAULT ? null : next === "on")
                    }
                  />
                }
              />
            );
          }
          const value =
            typeof pref === "string" && knob.choices.some((c) => c.id === pref)
              ? pref
              : AGENT_DEFAULT;
          return (
            <SettingsRow
              key={knob.id}
              title={knob.name}
              description={knob.description ?? undefined}
              control={
                <Select
                  size="sm"
                  className="w-40 justify-between"
                  aria-label={label}
                  value={value}
                  options={[
                    { value: AGENT_DEFAULT, label: "Agent's default" },
                    ...knob.choices.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  onValueChange={(next) => setKnob(knob.id, next === AGENT_DEFAULT ? null : next)}
                />
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
