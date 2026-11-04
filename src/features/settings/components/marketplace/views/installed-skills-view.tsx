// Settings → Skills → Installed, rendered from props: the list, and the pack
// and skill dialogs Manage opens. `installed-skills.tsx` owns the reconcile,
// the mutations and the optimistic toggles.

import type { ReactNode } from "react";
import {
  ArrowUpCircle,
  ChevronRight,
  Copy,
  ExternalLink,
  Package,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button, Icon } from "@tryatlas/design";

import { AtlasLoader } from "@/components/atlas-loader";
import { GithubIcon } from "@/components/brand-marks";
import type { InstalledPack } from "@/features/packs/lib/types";
import { kindCounts, type ModalSkill } from "@/features/skills/lib/skills-view-model";
import type { ProjectionStatus, ReconciledSkill, ToolInfo } from "@/features/skills/lib/types";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "../../layout/settings-layout";
import { DeliverTo, SkillDescriptions, SkillDialog } from "./skill-modal-view";

export interface InstalledSkillRow {
  skill: ReconciledSkill;
  /** "From <pack>", "Your skill" or "Found in an agent's folder". */
  origin: string;
  /** Display names of the tools it is delivered to. */
  toolNames: string[];
}

export function InstalledSkillsView({
  loaded,
  loadError,
  packsNoSkills,
  skills,
  onManagePack,
  onManageSkill,
  children,
}: {
  /** False until the first reconcile lands (or a cached one paints). */
  loaded: boolean;
  loadError: string | null;
  /** Packs that ship no skills (commands, agents or rules only). */
  packsNoSkills: InstalledPack[];
  skills: InstalledSkillRow[];
  onManagePack: (name: string) => void;
  onManageSkill: (skill: ReconciledSkill) => void;
  /** The open dialog. */
  children?: ReactNode;
}) {
  const empty = skills.length === 0 && packsNoSkills.length === 0;
  return (
    <SettingsSection
      title="Installed"
      description="Skills Atlas keeps, and the agent tools each one is delivered to."
    >
      <SettingsGroup>
        {!loaded ? (
          <SettingsNote>
            {loadError ? `Couldn't read the installed skills: ${loadError}` : "Loading skills…"}
          </SettingsNote>
        ) : empty ? (
          <SettingsNote>Nothing installed here yet. Find skills below.</SettingsNote>
        ) : (
          <>
            {packsNoSkills.map((p) => (
              <SettingsRow
                key={`pack:${p.pack.name}`}
                title={
                  <span className="flex items-center gap-1.5">
                    <Icon icon={Package} size="xs" className="text-muted-foreground" />
                    {p.pack.name}
                  </span>
                }
                description={kindCounts(p.pack.components) || undefined}
                status={<span className="font-mono">{p.source}</span>}
                control={
                  <ManageButton name={p.pack.name} onClick={() => onManagePack(p.pack.name)} />
                }
              />
            ))}

            {/* Every installed skill, by its real name. A pack's skill is
                managed through its pack, the unit it installs as. */}
            {skills.map(({ skill: s, origin, toolNames }) => (
              <SettingsRow
                key={`skill:${s.pack ?? ""}:${s.name}`}
                title={s.name}
                description={
                  s.description ? <span className="line-clamp-2">{s.description}</span> : undefined
                }
                status={`${origin} · ${toolNames.length ? `In ${toolNames.join(", ")}` : "Not delivered to any tool"}`}
                control={<ManageButton name={s.name} onClick={() => onManageSkill(s)} />}
              />
            ))}
          </>
        )}
      </SettingsGroup>
      {children}
    </SettingsSection>
  );
}

function ManageButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" aria-label={`Manage ${name}`} onClick={onClick}>
      Manage
      <Icon icon={ChevronRight} size="xs" />
    </Button>
  );
}

/** The tool switches, as `DeliverTo` takes them. */
export interface DeliverToProps {
  tools: ToolInfo[];
  detectedFor: (t: ToolInfo) => boolean;
  statusFor: (t: ToolInfo) => ProjectionStatus;
  busyFor: (t: ToolInfo) => boolean;
  onToggle: (t: ToolInfo, status: ProjectionStatus) => void;
}

export function PackManageDialogView({
  pack,
  skills,
  deliverTo,
  uninstalling,
  update,
  onUninstall,
  onCopy,
  onOpenGithub,
  onClose,
}: {
  pack: InstalledPack;
  skills: ModalSkill[];
  deliverTo: DeliverToProps;
  uninstalling: boolean;
  /** The check-for-update control. */
  update: ReactNode;
  onUninstall: () => void;
  onCopy: () => void;
  onOpenGithub: () => void;
  onClose: () => void;
}) {
  return (
    <SkillDialog
      open
      onClose={onClose}
      title={pack.pack.name}
      subtitle={[pack.source, kindCounts(pack.pack.components)].filter(Boolean).join(" · ")}
      footer={
        <>
          <Button variant="ghost" disabled={uninstalling} onClick={onUninstall}>
            <Icon icon={Trash2} size="xs" />
            Uninstall pack
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onCopy}>
            <Icon icon={Copy} size="xs" />
            Copy as Markdown
          </Button>
          <Button variant="ghost" onClick={onOpenGithub}>
            <GithubIcon size={12} />
            GitHub
          </Button>
          {update}
        </>
      }
    >
      <SkillDescriptions
        skills={skills}
        fallback="This pack ships no skills, only commands, agents or rules."
      />
      <DeliverTo {...deliverTo} />
    </SkillDialog>
  );
}

export function SkillManageDialogView({
  skill,
  subtitle,
  deliverTo,
  canPromote,
  uninstalling,
  promoting,
  onOpen,
  onPromote,
  onUninstall,
  onClose,
}: {
  skill: ModalSkill;
  subtitle: string;
  deliverTo: DeliverToProps;
  /** Project scope only: "Use in all projects". */
  canPromote: boolean;
  uninstalling: boolean;
  promoting: boolean;
  onOpen: () => void;
  onPromote: () => void;
  onUninstall: () => void;
  onClose: () => void;
}) {
  return (
    <SkillDialog
      open
      onClose={onClose}
      title={skill.name}
      subtitle={subtitle}
      footer={
        <>
          <Button variant="ghost" disabled={uninstalling} onClick={onUninstall}>
            <Icon icon={Trash2} size="xs" />
            Uninstall
          </Button>
          <span className="flex-1" />
          {canPromote && (
            <Button variant="ghost" disabled={promoting} onClick={onPromote}>
              <Icon icon={ArrowUpCircle} size="xs" />
              Use in all projects
            </Button>
          )}
          <Button variant="outline" onClick={onOpen}>
            <Icon icon={ExternalLink} size="xs" />
            Open in editor
          </Button>
        </>
      }
    >
      <SkillDescriptions skills={[skill]} />
      <DeliverTo {...deliverTo} />
    </SkillDialog>
  );
}

export type PackUpdateState = "idle" | "checking" | "available" | "uptodate" | "updating";

/** Check for a newer commit of the pack, then Update once one is found. */
export function PackUpdateButton({
  state,
  onCheck,
  onApply,
}: {
  state: PackUpdateState;
  onCheck: () => void;
  onApply: () => void;
}) {
  if (state === "available") {
    return (
      <Button onClick={onApply}>
        <Icon icon={ArrowUpCircle} size="xs" />
        Update
      </Button>
    );
  }
  const working = state === "checking" || state === "updating";
  return (
    <Button variant="outline" disabled={working || state === "uptodate"} onClick={onCheck}>
      {working ? <AtlasLoader size={11} /> : <Icon icon={RefreshCw} size="xs" />}
      {state === "checking"
        ? "Checking…"
        : state === "updating"
          ? "Updating…"
          : state === "uptodate"
            ? "Up to date"
            : "Check for update"}
    </Button>
  );
}
