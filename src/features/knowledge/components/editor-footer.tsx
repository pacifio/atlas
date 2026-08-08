import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Download, FileText, Globe, Loader2, Server } from "lucide-react";
import { cn } from "@/lib/utils";

interface EditorFooterProps {
  wordCount: number;
  charCount: number;
  projectPath: string;
  entryId: string | null;
}

const READ_WPM = 240;

type ExportKey = "note-md" | "note-html" | "workspace-md" | "workspace-html" | "server";

export function EditorFooter({ wordCount, charCount, projectPath, entryId }: EditorFooterProps) {
  const readMinutes = Math.max(1, Math.round(wordCount / READ_WPM));
  // Which export is in-flight, if any. The pill renders a spinner +
  // disables the trigger while an export runs; the dropdown itself is
  // unmounted because the trigger is disabled.
  const [busy, setBusy] = useState<ExportKey | null>(null);

  const run = async (key: ExportKey, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      console.error(`[export:${key}] failed`, err);
      window.alert(`Export failed:\n\n${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const pickSavePath = async (defaultName: string, ext: string): Promise<string | null> => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const chosen = await save({
      defaultPath: defaultName,
      title: "Export",
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    return (chosen as string | null) ?? null;
  };

  const pickDirectory = async (defaultName: string): Promise<string | null> => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const chosen = await save({
      defaultPath: defaultName,
      title: "Export to folder",
    });
    return (chosen as string | null) ?? null;
  };

  /** Tolerant reveal — different plugin-opener versions disagree on the
   *  arg shape; the JS wrapper hits a "missing required key paths"
   *  validator error on some installs. Try both via direct invoke and
   *  swallow failure silently. */
  const revealInFinder = async (path: string) => {
    try {
      await invoke("plugin:opener|reveal_item_in_dir", { paths: [path] });
    } catch {
      try {
        await invoke("plugin:opener|reveal_item_in_dir", { path });
      } catch {
        // Best-effort. Caller already has the path; reveal is a nicety.
      }
    }
  };

  const handleExportNoteMd = () =>
    run("note-md", async () => {
      if (!entryId) return;
      const target = await pickSavePath(`${entryId.split("/").pop()}.md`, "md");
      if (!target) return;
      await invoke("knowledge_export_note_md", {
        projectPath,
        entryId,
        targetPath: target,
      });
    });

  const handleExportNoteHtml = () =>
    run("note-html", async () => {
      if (!entryId) return;
      const target = await pickSavePath(`${entryId.split("/").pop()}.html`, "html");
      if (!target) return;
      await invoke("knowledge_export_note_html", {
        projectPath,
        entryId,
        targetPath: target,
      });
    });

  const handleExportWorkspaceMd = () =>
    run("workspace-md", async () => {
      const target = await pickSavePath("knowledge.md", "md");
      if (!target) return;
      await invoke("knowledge_export_workspace_md", {
        projectPath,
        targetPath: target,
      });
    });

  const handleExportWorkspaceHtml = () =>
    run("workspace-html", async () => {
      const target = await pickDirectory("knowledge-site");
      if (!target) return;
      await invoke("knowledge_export_workspace_html", {
        projectPath,
        targetDir: target,
      });
    });

  const handleExportServer = () =>
    run("server", async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = (await save({
        defaultPath: "atlas-kb-server",
        title: "Export Knowledge Server (cargo build, ~1 minute)",
      })) as string | null;
      if (!target) return;
      const result = await invoke<{ binaryPath: string; noteCount: number }>(
        "knowledge_export_server",
        { projectPath, targetPath: target },
      );
      await revealInFinder(result.binaryPath);
    });

  const hasNote = !!entryId;
  const isBusy = busy !== null;
  const busyLabel = busy === "server" ? "Building…" : busy ? "Exporting…" : null;

  return (
    <div
      className="flex items-center shrink-0 border-t border-border-subtle text-text-tertiary"
      style={{
        height: 24,
        gap: 14,
        padding: "0 14px",
        fontSize: 10,
        background: "var(--bg-canvas)",
      }}
    >
      <span>
        <span className="mono tnum">{wordCount.toLocaleString("en-US")}</span> words
      </span>
      <span>
        <span className="mono tnum">{charCount.toLocaleString("en-US")}</span> chars
      </span>
      <span>
        <span className="mono">~{readMinutes}m</span> read
      </span>
      <span className="flex-1" />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            disabled={isBusy}
            className={cn(
              "inline-flex items-center gap-1 h-5 px-2 rounded-full",
              "border border-border-default bg-bg-elevated text-[var(--text-primary)]",
              "text-[10px] font-medium leading-none cursor-pointer",
              "hover:bg-bg-hover transition-colors",
              "shadow-[0_2px_8px_rgba(0,0,0,0.35)]",
              isBusy && "opacity-80 cursor-wait",
            )}
            title={busyLabel ?? "Export"}
          >
            {isBusy ? (
              <>
                <Loader2 size={10} className="animate-spin" />
                {busyLabel}
              </>
            ) : (
              <>
                <Download size={10} />
                Export
                <ChevronDown size={10} className="opacity-70" />
              </>
            )}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className={cn(
              "min-w-[200px] rounded-md p-0.5 z-[9999]",
              "bg-black border border-border-default",
              "shadow-[0_8px_24px_rgba(0,0,0,0.6)]",
              "text-text-primary",
            )}
          >
            <ExportMenuItem
              icon={FileText}
              label="Export note as .md"
              disabled={!hasNote}
              onSelect={handleExportNoteMd}
            />
            <ExportMenuItem
              icon={Globe}
              label="Export note as .html"
              disabled={!hasNote}
              onSelect={handleExportNoteHtml}
            />
            <DropdownMenu.Separator className="h-px bg-border-default my-0.5" />
            <ExportMenuItem
              icon={FileText}
              label="Export workspace as .md"
              onSelect={handleExportWorkspaceMd}
            />
            <ExportMenuItem
              icon={Globe}
              label="Export workspace as .html"
              onSelect={handleExportWorkspaceHtml}
            />
            <DropdownMenu.Separator className="h-px bg-border-default my-0.5" />
            <ExportMenuItem icon={Server} label="Export server" onSelect={handleExportServer} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function ExportMenuItem({
  icon: Icon,
  label,
  onSelect,
  disabled,
}: {
  icon: React.ElementType;
  label: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={() => void onSelect()}
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1 outline-none cursor-pointer",
        "text-[11.5px] text-text-secondary",
        "focus:bg-bg-hover focus:text-text-primary",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      )}
    >
      <Icon size={11} className="text-text-tertiary" />
      {label}
    </DropdownMenu.Item>
  );
}
