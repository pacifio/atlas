// The editor sections that write an agent's own settings through
// `agents_configure`: its name, what it needs to sign in, how it runs, and its
// environment, on Atlas's installed-agents map.
//
// The well-known agents get named fields from their profile
// (`agent-profiles.ts`); each is a view onto one environment variable, so the
// Variables list below them shows only what no field claims.

import { useEffect, useRef, useState } from "react";
import { FileText, Lock, LockOpen, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { openFileAs } from "@/lib/open-file";
import { tildePath } from "@/lib/paths";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { SecretInput } from "@/ui/secret-input";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { Hint } from "@/ui/tooltip";
import {
  claimedVariables,
  configFilePath,
  numberProblem,
  profileFor,
  readField,
  writeField,
  type ConfigFile,
  type ProfileField,
} from "@/features/agents/lib/agent-profiles";
import { agentConfig } from "@/features/agents/lib/agent-config-api";
import type { AgentVariable } from "@/types/agent-catalog";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";
import {
  agentStatus,
  configureAgent,
  formatArgs,
  parseArgs,
  type AgentItem,
} from "./agent-install";

/** A text field that saves on Enter or when it loses focus, not per keystroke:
 *  each save rewrites the installed-agents map. Escape reverts, and so does
 *  emptying a `required` one. */
function DraftField({
  value,
  onCommit,
  className,
  mono = false,
  invalid = false,
  required = false,
  ...props
}: {
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  mono?: boolean;
  invalid?: boolean;
  required?: boolean;
  placeholder?: string;
  inputMode?: "numeric";
  "aria-label": string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      size="sm"
      spellCheck={false}
      autoComplete="off"
      aria-invalid={invalid || undefined}
      className={cn(mono && "font-mono", className)}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (required && !draft.trim()) setDraft(value);
        else if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(value);
      }}
      {...props}
    />
  );
}

const saveVariables = (item: AgentItem, variables: AgentVariable[]) =>
  configureAgent(item, { launch: { variables } });

/** The first row under the editor's header: the name it goes by, over a line
 *  saying how it stands. */
export function IdentityRow({ item }: { item: AgentItem }) {
  const catalog = item.catalog;
  const status = agentStatus(item, false);
  const editable = catalog !== undefined && item.state !== "detected";
  return (
    <SettingsRow
      title="Display name"
      status={
        <span className={cn(status.tone === "warning" && "text-warning")}>{status.text}</span>
      }
      control={
        editable ? (
          <DraftField
            className="w-full @min-[32rem]/settings-row:w-56"
            value={catalog.displayName ?? ""}
            placeholder={catalog.name}
            aria-label={`${catalog.name}: display name`}
            onCommit={(next) => void configureAgent(item, { displayName: next.trim() || null })}
          />
        ) : undefined
      }
    />
  );
}

/** One profile field. Text-like fields sit full width under their
 *  description, as a provider's runtime fields are laid out. */
function ProfileFieldRow({ item, field }: { item: AgentItem; field: ProfileField }) {
  const variables = item.catalog?.launch?.variables ?? [];
  const value = readField(variables, field);
  const [problem, setProblem] = useState<string | null>(null);
  const write = (next: string) => {
    const issue = numberProblem(field, next);
    setProblem(issue);
    if (!issue) void saveVariables(item, writeField(variables, field, next));
  };
  const label = `${item.name}: ${field.label}`;

  if (field.kind === "toggle") {
    return (
      <SettingsRow
        title={field.label}
        description={field.description}
        control={
          <Switch
            checked={value === field.on}
            aria-label={label}
            onCheckedChange={(on) => write(on ? field.on : "")}
          />
        }
      />
    );
  }
  if (field.kind === "select") {
    return (
      <SettingsRow
        title={field.label}
        description={field.description}
        control={
          <Select
            size="sm"
            className="w-40 justify-between"
            aria-label={label}
            value={value ?? ""}
            options={[{ value: "", label: "Default" }, ...field.options]}
            onValueChange={write}
          />
        }
      />
    );
  }
  return (
    <SettingsRow title={field.label} description={field.description}>
      {field.kind === "secret" ? (
        <SecretInput
          size="sm"
          className="w-full font-mono"
          configured={value === null}
          placeholder={field.placeholder}
          aria-label={label}
          onCommit={write}
        />
      ) : (
        <DraftField
          className="w-full"
          mono={field.kind === "path"}
          inputMode={field.kind === "number" ? "numeric" : undefined}
          invalid={problem !== null}
          value={value ?? ""}
          placeholder={field.placeholder}
          aria-label={label}
          onCommit={write}
        />
      )}
      {field.kind === "secret" && value === null && (
        <button
          type="button"
          className="caption pt-1.5 hover:text-foreground"
          onClick={() => write("")}
        >
          Remove the stored value
        </button>
      )}
      {problem && <p className="pt-1.5 text-2xs text-warning">{problem}</p>}
    </SettingsRow>
  );
}

/** What the agent needs to sign in, for an agent whose profile says. */
export function SetupSection({ item }: { item: AgentItem }) {
  const fields = profileFor(item.id)?.fields.filter((f) => f.section === "setup") ?? [];
  if (item.state !== "installed" || !item.catalog?.launch || fields.length === 0) return null;
  return (
    <SettingsSection
      title="Setup"
      description="Optional. Leave these empty to sign in the agent's own way."
    >
      <SettingsGroup>
        {fields.map((field) => (
          <ProfileFieldRow key={field.label} item={item} field={field} />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}

/** How Atlas starts it: the executable, the agent's own fields, and the
 *  arguments after the command. */
/** The agent's own settings file, opened as a tab — where everything Atlas
 *  doesn't restate as a field is set. Created empty the first time. */
function ConfigFileRow({
  item,
  file,
  variables,
}: {
  item: AgentItem;
  file: ConfigFile;
  variables: readonly AgentVariable[];
}) {
  const path = configFilePath(file, variables);
  const name = file.name.split("/").pop() ?? file.name;
  const open = async () => {
    try {
      openFileAs(await agentConfig.openConfigFile(path, file.empty), "text");
    } catch (e) {
      toast.error(`Couldn't open ${name}: ${String(e)}`);
    }
  };
  return (
    <SettingsRow
      title={file.label}
      description={
        <>
          Effort, compaction, proxies and the rest of {item.name}&apos;s own options, read when a
          chat starts. <span className="font-mono break-all">{path}</span>
        </>
      }
    >
      <Button type="button" variant="outline" size="sm" onClick={() => void open()}>
        <Icon icon={FileText} size="xs" />
        Open {name}
      </Button>
    </SettingsRow>
  );
}

export function RuntimeSection({ item }: { item: AgentItem }) {
  const catalog = item.catalog;
  if (item.state === "native") {
    return (
      <SettingsSection title="Runtime">
        <SettingsGroup>
          <SettingsRow
            title="Runs inside Atlas"
            description="In-process, so there is nothing to install, update or remove. It updates with Atlas."
          />
        </SettingsGroup>
      </SettingsSection>
    );
  }
  const launch = catalog?.launch;
  if (!catalog || !launch || item.state !== "installed") {
    const path = catalog?.resolvedPath;
    return (
      <SettingsSection title="Runtime">
        <SettingsGroup>
          <SettingsRow
            title={item.state === "detected" ? "Found at" : "Launches"}
            description={
              path ? (
                <span className="font-mono break-all">{tildePath(path)}</span>
              ) : (
                "Nothing resolved yet."
              )
            }
          />
        </SettingsGroup>
      </SettingsSection>
    );
  }

  const profile = profileFor(item.id);
  const fields = profile?.fields.filter((f) => f.section === "runtime") ?? [];
  const ownCommand = launch.command !== null;
  return (
    <SettingsSection title="Runtime">
      <SettingsGroup>
        {ownCommand ? (
          <SettingsRow
            title="Binary path"
            description="The executable Atlas starts. It speaks ACP over stdio."
          >
            <DraftField
              mono
              className="w-full"
              value={launch.command ?? ""}
              aria-label={`${item.name}: binary path`}
              required
              onCommit={(next) => void configureAgent(item, { launch: { command: next.trim() } })}
            />
          </SettingsRow>
        ) : (
          <SettingsRow
            title="Binary path"
            description={
              catalog.source === "npx"
                ? "From the ACP registry, through npx. npm fetches it the first time a chat starts it."
                : "From the ACP registry, kept up to date by Atlas."
            }
            status={
              catalog.resolvedPath ? (
                <span className="font-mono break-all">{tildePath(catalog.resolvedPath)}</span>
              ) : undefined
            }
          />
        )}
        {fields.map((field) => (
          <ProfileFieldRow key={field.label} item={item} field={field} />
        ))}
        {profile?.configFile && (
          <ConfigFileRow item={item} file={profile.configFile} variables={launch.variables} />
        )}
        {profile?.launchArgs !== false && (
          <SettingsRow
            title="Launch arguments"
            description={
              ownCommand
                ? "Passed after the command on session start. Quote an argument that has spaces."
                : "Added after the registry's own on session start. Quote an argument that has spaces."
            }
          >
            <DraftField
              mono
              className="w-full"
              value={formatArgs(launch.args)}
              placeholder="e.g. --verbose"
              aria-label={`${item.name}: launch arguments`}
              onCommit={(next) => void configureAgent(item, { launch: { args: parseArgs(next) } })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DraftRow {
  id: string;
  name: string;
  value: string;
  sensitive: boolean;
  /** A sensitive value is in the keychain; an empty draft keeps it. */
  stored: boolean;
}

let draftId = 0;
const nextDraftId = () => `agent-env-${draftId++}`;

const toRows = (variables: readonly AgentVariable[]): DraftRow[] =>
  variables.map((v, i) => ({
    id: `${i}:${v.name}`,
    name: v.name,
    value: v.value ?? "",
    sensitive: v.sensitive,
    stored: v.sensitive && v.value === null,
  }));

const signature = (variables: readonly AgentVariable[]) =>
  variables.map((v) => `${v.name}\u0000${v.value}\u0000${v.sensitive}`).join("\u0001");

/** The rows as the backend takes them, or `null` while one is half-typed. A
 *  blank row is left out; a new sensitive one waits for its value. */
function publishable(rows: readonly DraftRow[]): AgentVariable[] | null {
  const out: AgentVariable[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!ENV_NAME.test(name)) return null;
    if (row.sensitive) {
      if (row.value) out.push({ name, value: row.value, sensitive: true });
      else if (row.stored) out.push({ name, value: null, sensitive: true });
      continue;
    }
    out.push({ name, value: row.value, sensitive: false });
  }
  return out;
}

/** Extra variables for the agent's process, over what Atlas inherits. */
export function EnvironmentSection({ item }: { item: AgentItem }) {
  const launch = item.catalog?.launch;
  const claimed = claimedVariables(profileFor(item.id));
  const all = launch?.variables ?? [];
  const generic = all.filter((v) => !claimed.has(v.name));
  const [rows, setRows] = useState<DraftRow[]>(() => toRows(generic));
  // Reset from the catalog only when it moved for a reason other than our own
  // save, so a row being typed doesn't jump while its save echoes back.
  const seen = useRef(signature(generic));
  const published = useRef<string | null>(null);
  const incoming = signature(generic);
  useEffect(() => {
    if (incoming === seen.current) return;
    seen.current = incoming;
    if (incoming === published.current) return;
    setRows(toRows(generic));
    // `generic` is derived from the catalog; its signature is the dependency.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  if (!launch || item.state !== "installed") return null;
  const kept = all.filter((v) => claimed.has(v.name));

  const publish = (next: DraftRow[]) => {
    setRows(next);
    const variables = publishable(next);
    if (!variables) return;
    published.current = signature(variables);
    void saveVariables(item, [...kept, ...variables]);
  };
  const update = (id: string, patch: Partial<Omit<DraftRow, "id">>) =>
    publish(
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              ...patch,
              // Typing a value replaces what the keychain holds; turning
              // sensitivity off forgets it, since it can't be shown.
              stored: patch.value !== undefined || patch.sensitive === false ? false : row.stored,
            }
          : row,
      ),
    );

  return (
    <SettingsSection title="Environment">
      <SettingsGroup>
        <SettingsRow
          title="Variables"
          description="API keys, base URLs, and other settings for this agent's process, over the environment Atlas starts with."
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setRows([
                  ...rows,
                  { id: nextDraftId(), name: "", value: "", sensitive: true, stored: false },
                ])
              }
            >
              <Icon icon={Plus} size="xs" />
              Add variable
            </Button>
          }
        >
          {rows.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2 pb-1">
              {rows.map((row, index) => (
                <VariableRow
                  key={row.id}
                  row={row}
                  index={index}
                  onChange={(patch) => update(row.id, patch)}
                  onRemove={() => publish(rows.filter((r) => r.id !== row.id))}
                />
              ))}
              <p className="caption">
                Sensitive values are kept in your system keychain and never shown again.
              </p>
            </div>
          )}
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

function VariableRow({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: DraftRow;
  index: number;
  onChange: (patch: Partial<Omit<DraftRow, "id">>) => void;
  onRemove: () => void;
}) {
  const label = row.name || `variable ${index + 1}`;
  const badName = row.name.trim() !== "" && !ENV_NAME.test(row.name.trim());
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <DraftField
        mono
        className="w-full min-w-0 sm:w-44 sm:shrink-0"
        invalid={badName}
        value={row.name}
        placeholder="VARIABLE_NAME"
        aria-label={`Environment variable name ${index + 1}`}
        onCommit={(name) => onChange({ name: name.trim() })}
      />
      <span className="hidden text-xs text-muted-foreground sm:inline" aria-hidden>
        =
      </span>
      {row.sensitive ? (
        <SecretInput
          size="sm"
          className="min-w-0 flex-1 font-mono"
          configured={row.stored}
          placeholder="value"
          aria-label={`Environment variable value ${index + 1}`}
          onCommit={(value) => onChange({ value })}
        />
      ) : (
        <DraftField
          mono
          className="min-w-0 flex-1"
          value={row.value}
          placeholder="value"
          aria-label={`Environment variable value ${index + 1}`}
          onCommit={(value) => onChange({ value })}
        />
      )}
      <Hint label={row.sensitive ? "Sensitive, kept in the keychain" : "Plain text"}>
        <IconButton
          icon={row.sensitive ? Lock : LockOpen}
          size="xs"
          aria-pressed={row.sensitive}
          label={`Mark ${label} as sensitive`}
          aria-label={`Mark ${label} as sensitive`}
          onClick={() =>
            onChange({ sensitive: !row.sensitive, value: row.sensitive ? "" : row.value })
          }
        />
      </Hint>
      <Hint label={`Remove ${label}`}>
        <IconButton icon={X} size="xs" label={`Remove ${label}`} onClick={onRemove} />
      </Hint>
    </div>
  );
}
