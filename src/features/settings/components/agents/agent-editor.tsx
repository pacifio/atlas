// The right pane of Settings → Agents: one agent's settings, laid out as a
// provider editor. A header with its name, version and Remove; its
// display name over how it stands; then Setup, Defaults, Runtime,
// Environment and Models, and Atlas's own About at the end.

import type { ReactNode } from "react";
import { ArrowUpCircle, Globe, MoreHorizontal, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { AtlasLoader } from "@/components/atlas-loader";
import { AgentMark } from "@/components/agent-mark";
import { GithubIcon } from "@/components/github-icon";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { updatePhaseLabel } from "@/features/agents/lib/agent-update";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";
import { usePageScope } from "../../lib/use-scoped-setting";
import {
  configureAgent,
  installAgent,
  installKind,
  removeAgent,
  updateAgentTo,
  useInstalls,
  type AgentItem,
} from "./agent-install";
import { AtlasAgentPermissions } from "./agent-settings-sections";
import {
  EnvironmentSection,
  IdentityRow,
  RuntimeSection,
  SetupSection,
} from "./agent-config-sections";
import { AgentDefaultsSection } from "./agent-defaults-section";
import { AgentModelsSection } from "./agent-models-section";

/** The version on this machine: what is installed, else what would install. */
export function versionOf(item: AgentItem): string | null {
  return item.entry?.installedVersion ?? item.catalog?.version ?? item.entry?.version ?? null;
}

export function AgentEditor({ item }: { item: AgentItem }) {
  const version = versionOf(item);
  const removable = item.state === "installed";
  // An agent's own settings are the same in every project, so in a project
  // scope they are shown but can't be changed, as a global-only row would be.
  // Atlas Agent's permissions are ordinary settings a project may tighten, and
  // stay live; their rows lock what a project can't override.
  const projectScope = usePageScope() !== null;
  const lock = (children: ReactNode) =>
    projectScope ? (
      <div inert className="disabled-look flex flex-col gap-6">
        {children}
      </div>
    ) : (
      children
    );
  return (
    <div className="flex flex-col gap-6 p-4">
      {projectScope && (
        <p className="px-1 text-xs text-muted-foreground">
          Agents apply to all projects. Pick All projects above to change them.
        </p>
      )}
      {lock(
        <>
          <section className="flex flex-col gap-2">
            <header className="flex min-h-7 items-center gap-2.5 px-1">
              <span className="flex shrink-0 items-center text-foreground">
                <AgentMark agentType={item.agentType} />
              </span>
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {item.catalog?.displayName ?? item.name}
              </h2>
              {version && (
                <code className="font-mono text-xs text-muted-foreground">v{version}</code>
              )}
              <LinksMenu item={item} />
              {removable && (
                <Hint label={`Remove ${item.name}`}>
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    label={`Remove ${item.name}`}
                    onClick={() => void removeAgent(item)}
                  />
                </Hint>
              )}
            </header>
            <SettingsGroup>
              <IdentityRow item={item} />
              <StatusRow item={item} />
            </SettingsGroup>
          </section>
          <SetupSection item={item} />
        </>,
      )}
      {item.state === "native" && <AtlasAgentPermissions />}
      {lock(
        <>
          <AgentDefaultsSection key={item.id} item={item} />
          <RuntimeSection item={item} />
          <EnvironmentSection item={item} />
          <AgentModelsSection item={item} />
          <AboutSection item={item} />
        </>,
      )}
    </div>
  );
}

/** Where to read more about it. */
function LinksMenu({ item }: { item: AgentItem }) {
  const repository = item.catalog?.repository ?? item.entry?.repository;
  const website = item.catalog?.website ?? item.entry?.website;
  if (!repository && !website) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<IconButton icon={MoreHorizontal} size="sm" label={`${item.name} actions`} />}
      />
      <DropdownMenuContent align="end" className="min-w-44">
        {repository && (
          <DropdownMenuItem onClick={() => void openUrl(repository)}>
            <GithubIcon size={12} />
            Open repository
          </DropdownMenuItem>
        )}
        {website && (
          <DropdownMenuItem onClick={() => void openUrl(website)}>
            <Icon icon={Globe} size="sm" />
            Open website
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The one thing to do about this agent right now, when there is one: turn
 *  it back on, add a detection, update, or say why it can't start. */
function StatusRow({ item }: { item: AgentItem }) {
  const installs = useInstalls();
  const phase = useAgentRegistryStore((s) => s.updatePhases[item.id] ?? null);
  const entry = item.entry;
  let row: ReactNode = null;

  if (item.catalog && !item.catalog.enabled) {
    row = (
      <SettingsRow
        title="Turned off"
        description="It's out of the agent picker, and Atlas won't start it. Its chats stay in your history."
        control={
          <Button size="sm" onClick={() => void configureAgent(item, { enabled: true })}>
            Turn on
          </Button>
        }
      />
    );
  } else if (item.state === "detected" && entry) {
    const busy = installs.installing(item.id);
    row = (
      <SettingsRow
        title="Not added yet"
        description="Atlas found it on your PATH. Adding it runs your own copy, and nothing is downloaded."
        control={
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void installAgent(entry, installKind("detected"))}
          >
            {busy && <AtlasLoader size={11} />}
            Add {item.name}
          </Button>
        }
      />
    );
  } else if (item.catalog?.source === "unavailable") {
    row = (
      <SettingsRow
        title={<span className="text-warning">Can't start</span>}
        description={
          item.catalog.unsupportedReason
            ? `Atlas can't start it: ${item.catalog.unsupportedReason}.`
            : "Atlas can't find anything to run for it."
        }
        control={
          <Button variant="outline" size="sm" onClick={() => void removeAgent(item)}>
            Remove
          </Button>
        }
      />
    );
  } else if (entry?.updateAvailable || phase) {
    row = (
      <SettingsRow
        title="Update available"
        description={
          entry?.installedVersion
            ? `v${entry.installedVersion} is installed and the registry lists v${entry.version}. A reply in progress finishes first, and open chats continue on the new version.`
            : `The registry lists v${entry?.version}. A reply in progress finishes first, and open chats continue on the new version.`
        }
        control={
          phase ? (
            <Button variant="outline" size="sm" disabled>
              <AtlasLoader size={11} />
              {updatePhaseLabel(phase.phase, phase.version)}
            </Button>
          ) : (
            entry && (
              <Button size="sm" onClick={() => updateAgentTo(entry)}>
                <Icon icon={ArrowUpCircle} size="xs" />
                Update to v{entry.version}
              </Button>
            )
          )
        }
      />
    );
  }

  return row;
}

/** Where it came from and what it said it can do. */
function AboutSection({ item }: { item: AgentItem }) {
  const catalog = item.catalog;
  const kind = catalog?.distributionKind || item.entry?.distributionKind;
  const caps = catalog
    ? [
        catalog.supportsModels && "Models",
        catalog.supportsModes && "Modes",
        catalog.supportsFork && "Fork",
        catalog.supportsRewind && "Rewind",
        catalog.supportsLogout && "Sign out",
      ].filter((cap): cap is string => !!cap)
    : [];
  const description = catalog?.description ?? item.entry?.description;
  return (
    <SettingsSection title="About">
      <SettingsGroup>
        {description && <SettingsRow title="Description" description={description} />}
        {item.state !== "native" && (
          <SettingsRow
            title="Distribution"
            description={distributionText(kind, item)}
            control={
              item.entry?.unverified && kind === "binary" ? (
                <Hint label="This agent's binary download publishes no checksum.">
                  <Badge variant="warning" tabIndex={0}>
                    Unverified
                  </Badge>
                </Hint>
              ) : undefined
            }
          />
        )}
        <SettingsRow
          title="Capabilities"
          description={
            caps.length > 0 ? (
              <span className="flex flex-wrap gap-1 pt-0.5">
                {caps.map((cap) => (
                  <Badge key={cap} variant="outline">
                    {cap}
                  </Badge>
                ))}
              </span>
            ) : (
              "What it advertises when it connects. Nothing yet."
            )
          }
        />
        <SettingsRow title="Agent ID" description={<span className="font-mono">{item.id}</span>} />
      </SettingsGroup>
    </SettingsSection>
  );
}

function distributionText(kind: string | undefined, item: AgentItem): string {
  if (item.state === "detected") return "Your own copy, outside Atlas.";
  if (kind === "binary")
    return "A binary from the ACP registry, downloaded into Atlas's agents folder.";
  if (kind === "npx") return "An npm package from the ACP registry.";
  return "Installed by hand. The ACP registry doesn't list it.";
}
