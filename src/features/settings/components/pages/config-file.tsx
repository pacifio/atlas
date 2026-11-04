/**
 * `config.toml` itself, as something Settings can show: where it is, whether
 * it loaded, which keys in it Atlas doesn't recognise, and the two ways out
 * of a broken one.
 */

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useSettingsStore } from "../../stores/settings-store";
import { getConfigInfo, openConfigFile, type ConfigInfo } from "../../lib/atlas-config-api";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@tryatlas/design";

/** Shown at the top of General while `config.toml` failed to load. */
export function ConfigErrorBanner() {
  const configError = useSettingsStore.use.configError();
  const { clearConfigError } = useSettingsStore.use.actions();
  if (!configError) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-muted p-3">
      <p className="label">There is a problem with your settings</p>
      <p className="break-all font-mono text-2xs text-secondary-foreground">{configError}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void openConfigFile()}>
          Open config.toml
        </Button>
        <RecreateDefaults
          trigger={
            <Button variant="outline" size="sm">
              Recreate defaults
            </Button>
          }
        />
        <Button variant="ghost" size="sm" onClick={clearConfigError}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** Privacy › Settings file. */
export function ConfigFileSection() {
  const generation = useSettingsStore.use.configGeneration();
  const [info, setInfo] = useState<ConfigInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getConfigInfo()
      .then((next) => {
        if (!live) return;
        setInfo(next);
        setFailed(next === null);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [generation]);

  const unknown = info?.unknownKeys ?? [];
  // Never "loaded cleanly" before the answer is in: this row is where a
  // broken file is supposed to show.
  const status = failed
    ? "Couldn't read the file's status."
    : !info
      ? "Checking…"
      : info.status.status === "ok"
        ? "Loaded cleanly."
        : info.status.status === "usingLastKnownGood"
          ? "Has an error; Atlas is running on the last settings that loaded."
          : "Has an error; Atlas is running on its defaults.";

  return (
    <SettingsSection
      title="Settings file"
      description="Every preference here is a commented line in this file. Edit it by hand and Atlas picks the change up as you save."
    >
      <SettingsGroup>
        <SettingsRow
          anchor="config-file"
          title="config.toml"
          description={info?.path ?? "~/.config/atlas/config.toml"}
          status={status}
          control={
            <Button variant="outline" size="sm" onClick={() => void openConfigFile()}>
              Open
            </Button>
          }
        />
        <SettingsRow
          title="Keys Atlas doesn't recognise"
          description={
            unknown.length === 0
              ? "None. A key with a typo, or one from a newer Atlas, would show here; it stays in the file untouched."
              : "These stay in the file untouched, but do nothing. Check them for a typo, or they may belong to a newer Atlas."
          }
        >
          {unknown.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {unknown.map((key) => (
                <li
                  key={key}
                  className="rounded-sm border border-border bg-panel-input px-1.5 py-0.5 font-mono text-2xs text-secondary-foreground"
                >
                  {key}
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
        <SettingsRow
          title="Recreate defaults"
          description="Replace the file with a fresh, fully commented one. The current file is kept beside it as a backup."
          control={
            <RecreateDefaults
              trigger={
                <Button variant="outline" size="sm">
                  Recreate
                </Button>
              }
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

function RecreateDefaults({ trigger }: { trigger: ReactNode }) {
  const { resetConfig } = useSettingsStore.use.actions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      // The store action owns both the state write and the side effects
      // (theme, zoom) that follow it.
      await resetConfig();
      toast.success("config.toml recreated; the previous file is backed up beside it");
      setOpen(false);
    } catch (e) {
      toast.error(`Couldn't recreate config.toml: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span className="inline-flex" onClick={() => setOpen(true)}>
        {trigger}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Recreate config.toml?</DialogTitle>
            <DialogDescription>
              Every setting goes back to its default, and the file gets fresh comments. Your current
              file is saved beside it as config.toml.bak-…, so nothing is lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button variant="destructive" disabled={busy} onClick={() => void run()}>
              {busy ? "Recreating…" : "Recreate defaults"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
