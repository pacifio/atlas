// Settings → Skills. One home for two surfaces: "My Skills" (author/adopt the
// canonical `.atlas/skills` store, the `#skill:` invoke source) and "Packs"
// (install multi-component packs from the registry and project them). Both are
// full-bleed; this wrapper owns the sub-tab switch and the shared scope control
// so the two surfaces read as one family.

import { useState } from "react";

import { cn } from "@/lib/utils";
import { AtlasIcon } from "@/components/atlas-icon";
import { useProjectStore } from "@/features/project/stores/project-store";
import type { Scope } from "@/features/skills/lib/types";

import { SkillsMarketplace } from "./marketplace/skills-marketplace";
import { InstalledSkills } from "./marketplace/installed-skills";

type SubTab = "discover" | "installed";

const TABS: { id: SubTab; label: string }[] = [
  { id: "discover", label: "Discover" },
  { id: "installed", label: "My Skills" },
];

export function SkillsAndPacks() {
  const [tab, setTab] = useState<SubTab>("discover");
  const [scope, setScope] = useState<Scope>("global");
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
  const hasProject = projectPath != null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Header — Atlas logo + title, then underline/bottom-border tab switchers
          (like the API Keys table) for Discover/My Skills and Global/Project.
          Height matches the Source Control panel header (h-[29px]). */}
      <div className="flex h-[29px] shrink-0 items-center gap-1 border-b border-border-default px-2">
        <div className="flex items-center gap-1.5 px-1.5">
          <AtlasIcon size={13} />
          <span className="text-[12px] font-semibold text-text-primary">
            Skills
          </span>
        </div>
        <span className="mx-1 h-3.5 w-px bg-border-default" />
        {TABS.map((t) => (
          <UnderlineTab
            key={t.id}
            active={tab === t.id}
            onClick={() => setTab(t.id)}
            label={t.label}
          />
        ))}

        {/* Shared scope control — drives install/projection + default scope. */}
        <div className="ml-auto flex items-center">
          {(["global", "project"] as Scope[]).map((s) => {
            const disabled = s === "project" && !hasProject;
            return (
              <UnderlineTab
                key={s}
                active={scope === s}
                disabled={disabled}
                title={
                  disabled ? "Open a project to use project scope" : undefined
                }
                onClick={() => setScope(s)}
                label={s}
              />
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "discover" ? (
          <SkillsMarketplace scope={scope} projectPath={projectPath} />
        ) : (
          <InstalledSkills scope={scope} projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

/** One underline/bottom-border tab (mirrors the API Keys table tabs). The
 *  active tab shows an accent bottom border flush with the header's border. */
function UnderlineTab({
  active,
  onClick,
  label,
  disabled,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-[29px] items-center gap-1.5 px-2.5 text-[11px] font-medium capitalize transition-colors border-b-2 -mb-px cursor-pointer",
        active
          ? "text-text-primary border-b-[var(--accent-primary)]"
          : "text-text-secondary hover:text-text-primary border-b-transparent",
        disabled && "cursor-not-allowed opacity-40 hover:text-text-secondary",
      )}
    >
      {label}
    </button>
  );
}
