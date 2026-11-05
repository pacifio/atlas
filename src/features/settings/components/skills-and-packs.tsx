// Settings → Skills: what is installed, then the registry to install more.
// The scope is the one every settings page shares: All projects installs a
// skill for every project, a picked project installs it there alone.

import type { Scope } from "@/features/skills/lib/types";
import { useSettingsNav } from "../stores/settings-nav-store";
import { SettingsPage } from "./layout/settings-layout";
import { ScopeSentence } from "./layout/scope-sentence";
import { InstalledSkills } from "./marketplace/installed-skills";
import { SkillsMarketplace } from "./marketplace/skills-marketplace";

export function SkillsAndPacks() {
  const projectPath = useSettingsNav((s) => s.scope);
  const scope: Scope = projectPath ? "project" : "global";

  return (
    <SettingsPage
      title="Skills"
      description="Instructions agents load when a task calls for them. Atlas keeps one copy and delivers it to each agent tool."
      header={
        <ScopeSentence
          lead="Showing skills for"
          note="Skills installed here apply to this project alone, and live in its folder."
        />
      }
    >
      <InstalledSkills scope={scope} projectPath={projectPath} />
      <SkillsMarketplace scope={scope} projectPath={projectPath} />
    </SettingsPage>
  );
}
