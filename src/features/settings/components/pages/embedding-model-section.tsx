import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Trash2 } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { AtlasLoader } from "@/components/atlas-loader";
import { useAppStore } from "@/features/app/stores/app-store";
import { useModelsStore } from "../../stores/models-store";
import { models, type DownloadProgress, type ModelStatus } from "../../lib/models-api";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";

/**
 * Settings → Memory → Embedding model: the on-device models memory search can
 * use, one row each. A row walks Download → Use, and a downloaded model that isn't in use
 * can be removed. Switching the embedding model is confirmed first, because
 * it rebuilds the open project's memory index in a new vector space.
 */

const fmtSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function EmbeddingModelSection() {
  const loaded = useModelsStore.use.loaded();
  const list = useModelsStore.use.list();
  const downloading = useModelsStore.use.downloading();
  const pending = useModelsStore.use.pending();
  const actions = useModelsStore.use.actions();
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const [confirm, setConfirm] = useState<ModelStatus | null>(null);

  useEffect(() => {
    void actions.init();
  }, [actions]);

  const download = async (m: ModelStatus) => {
    try {
      await actions.download(m.id);
    } catch (e) {
      toast.error(`Couldn't download ${m.name}: ${errorText(e)}`);
    }
  };

  const remove = async (m: ModelStatus) => {
    try {
      await actions.remove(m.id);
      toast(`Removed ${m.name}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const switchTo = async (m: ModelStatus) => {
    setConfirm(null);
    try {
      const needsReindex = await actions.select(m.id);
      toast.success(`Using ${m.name}`);
      if (needsReindex && projectPath) {
        await models.reindex(projectPath);
        toast("Rebuilding the memory index with the new model…");
      }
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <>
      <SettingsSection
        title="Embedding model"
        description="Shared memory searches with this model, downloaded once and run on this computer. Switching rebuilds the memory index."
        anchor="embedding-model"
      >
        <SettingsGroup>
          {!loaded ? (
            <SettingsNote>Loading models…</SettingsNote>
          ) : (
            list.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                progress={downloading[m.id]}
                busy={pending === m.id}
                onDownload={() => void download(m)}
                onUse={() => setConfirm(m)}
                onRemove={() => void remove(m)}
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Switch to {confirm?.name}?</DialogTitle>
            <DialogDescription>
              It places memory in a different vector space, so Atlas clears this project's memory
              index and rebuilds it in the background. Your notes and files don't change.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button onClick={() => confirm && void switchTo(confirm)}>Switch and rebuild</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ModelRow({
  model: m,
  progress,
  busy,
  onDownload,
  onUse,
  onRemove,
}: {
  model: ModelStatus;
  progress: DownloadProgress | undefined;
  busy: boolean;
  onDownload: () => void;
  onUse: () => void;
  onRemove: () => void;
}) {
  const facts = [fmtSize(m.sizeMb), m.dim ? `${m.dim} dimensions` : null, m.repo]
    .filter(Boolean)
    .join(" · ");

  let control: React.ReactNode = null;
  if (progress) {
    control = <ProgressBar progress={progress} />;
  } else if (!m.downloaded) {
    control = (
      <Button variant="outline" size="sm" onClick={onDownload}>
        <Icon icon={Download} size="xs" />
        Download
      </Button>
    );
  } else if (!m.selected) {
    control = (
      <>
        <Hint label="Remove the download">
          <IconButton
            icon={Trash2}
            size="sm"
            label={`Remove ${m.name}`}
            disabled={busy}
            onClick={onRemove}
          />
        </Hint>
        <Button variant="outline" size="sm" disabled={busy} onClick={onUse}>
          {busy && <AtlasLoader size={11} />}
          Use
        </Button>
      </>
    );
  }

  return (
    <SettingsRow
      anchor={`model-${m.id}`}
      title={
        <span className="flex items-center gap-2">
          {m.name}
          {m.selected && <Badge variant="outline">In use</Badge>}
        </span>
      }
      description={m.description}
      status={facts}
      control={control}
    />
  );
}

function ProgressBar({ progress: p }: { progress: DownloadProgress }) {
  const pct = Math.min(
    100,
    Math.round(
      ((p.fileIndex + (p.total ? p.received / p.total : 0)) / Math.max(1, p.fileCount)) * 100,
    ),
  );
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Downloading"
      className="flex items-center gap-2"
    >
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-element-selected">
        <div
          className="h-full bg-primary transition-[width] duration-base"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right text-2xs text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}
