/**
 * "Applying settings for [All projects ▾]" — the scope picker, as a
 * sentence under the page title rather than a toggle off to one side, so the
 * page says in words what a change will touch.
 *
 * Picking a project makes every per-project row on the page show and edit
 * that project's `.atlas/config.toml`; the rest go read-only. The picked
 * scope is shared by every page that has one, and starts on All projects.
 */

import { useMemo, type ReactNode } from "react";
import { Select, type SelectOption } from "@/ui/select";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useSettingsNav } from "../../stores/settings-nav-store";
import { useProjectSettingsStore } from "../../stores/project-settings-store";
import { useLoadProjectSettings } from "../../lib/use-scoped-setting";

const ALL = "__all__";

export function ScopeSentence({
  lead = "Applying settings for",
  note,
}: {
  /** The words before the picker. */
  lead?: string;
  /** Replaces the settings-file caption under a project, for a page whose
   *  scope means something else (Skills: where a skill is installed). */
  note?: ReactNode;
} = {}) {
  const scope = useSettingsNav((s) => s.scope);
  const setScope = useSettingsNav((s) => s.setScope);
  const projects = useProjectStore.use.projects();
  const orgId = useOrgStore((s) => s.activeOrganisationId);
  const info = useProjectSettingsStore((s) => (scope ? s.byPath[scope] : undefined));
  useLoadProjectSettings(scope);

  const options = useMemo<SelectOption<string>[]>(
    () => [
      { value: ALL, label: "All projects" },
      ...projects
        .filter((p) => !orgId || p.orgId === orgId)
        .map((p) => ({ value: p.path, label: p.name, description: p.path })),
    ],
    [projects, orgId],
  );

  const overrides = info ? Object.keys(info.values).length : 0;
  return (
    <div className="flex flex-col gap-1 pt-2">
      <div className="flex items-center gap-1.5 text-xs text-secondary-foreground">
        <span>{lead}</span>
        <Select
          size="sm"
          variant="ghost"
          value={scope ?? ALL}
          options={options}
          aria-label={lead}
          onValueChange={(next) => setScope(next === ALL ? null : next)}
        />
      </div>
      {scope && note !== undefined && <p className="caption">{note}</p>}
      {scope && note === undefined && (
        <p className="caption">
          {info?.error
            ? `This project's settings file isn't applied: ${info.error}`
            : overrides === 0
              ? "This project uses the settings for all projects. A change here applies to it alone."
              : `${overrides} setting${overrides === 1 ? " differs" : "s differ"} in this project.`}{" "}
          Saved in {info?.path ?? ".atlas/config.toml"}, which only you see.
          {info && info.ignoredKeys.length > 0 && (
            <> Ignored there: {info.ignoredKeys.join(", ")}.</>
          )}
          {info && info.refusedKeys.length > 0 && (
            <>
              {" "}
              Not applied, because a project can only turn them off: {info.refusedKeys.join(", ")}.
            </>
          )}
        </p>
      )}
    </div>
  );
}
