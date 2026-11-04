import { FolderGit2, GitBranch, GitCommitHorizontal, History } from "lucide-react";

import { GithubIcon } from "@/components/github-icon";
import { cn } from "@/lib/utils";

import type { Detection, ImportPreview } from "../../types";
import { StatusRow } from "../status-row";
import { GROUP } from "./styles";

/**
 * What Atlas worked out about this directory.
 *
 * Shown rather than asked. None of it is required — it is displayed so the
 * developer can see what will be recorded, and so a wrong-looking origin is
 * caught before binding rather than after.
 *
 * Rendered as a **status list, not a definition list.** The label/value grid it
 * replaced was four rows of grey text with nothing to fix the eye on, and it
 * read as a dump rather than as findings. Each row now leads with an icon that
 * carries the verdict — green when the thing is there, dashed when it is
 * missing but harmless — so the shape of the answer is legible before any of it
 * is read.
 */
export function Detected({
  detection,
  importPreview,
}: {
  detection: Detection | null;
  importPreview: ImportPreview | null | undefined;
}) {
  if (!detection) return null;

  const folder = detection.root.split("/").pop() ?? detection.root;
  const sessions = importPreview?.sessionCount ?? 0;

  return (
    <div className={cn(GROUP, "space-y-1.5")}>
      <p className="text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
        This project
      </p>

      <StatusRow icon={FolderGit2} ok value={folder} caption="folder" mono={false} />

      {detection.isGitRepository ? (
        <>
          <StatusRow
            icon={GithubIcon}
            ok
            value={detection.gitUrl?.replace(/^https?:\/\//, "") ?? "no remote"}
            caption={detection.gitUrl ? "origin" : "local only"}
          />
          {detection.rootCommitSha ? (
            <StatusRow
              icon={GitCommitHorizontal}
              ok
              value={detection.rootCommitSha.slice(0, 7)}
              caption={detection.isShallow ? "root · shallow" : "root commit"}
            />
          ) : (
            // Not a fault: a repository with no commits captures fine, it just
            // has nothing for a Checkpoint to attach to yet.
            <StatusRow
              icon={GitCommitHorizontal}
              ok={false}
              value="no commits yet"
              caption="root"
            />
          )}
        </>
      ) : (
        <StatusRow
          icon={GitBranch}
          ok={false}
          value="not a repository"
          caption="commits won't link"
        />
      )}

      <StatusRow
        icon={History}
        ok={sessions > 0}
        value={sessions > 0 ? `${sessions} session${sessions === 1 ? "" : "s"}` : "no history yet"}
        caption="on disk"
        mono={false}
      />
    </div>
  );
}

/**
 * Git is not on this machine at all.
 *
 * Stated, not actionable: installing git is not something the popover can do,
 * and offering a button that opens a download page from inside a capture panel
 * would be a worse lie than saying nothing. Shown *instead of* `GitInitOffer`,
 * which would otherwise offer to run a binary that is not there.
 */
export function GitMissingBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-warning/40 px-2.5 py-2">
      <GitBranch size={12} className="mt-0.5 shrink-0 text-warning" />
      <p className="min-w-0 text-xs text-[var(--secondary-foreground)]">
        Git is not installed on this machine. Sessions are still recorded, but they cannot be linked
        to commits and cannot be shared with an Organization.
      </p>
    </div>
  );
}

/**
 * The inline `git init` offer.
 *
 * Framed as unlocking commit linkage, not as a requirement — because it is not
 * one. Sessions are captured in any directory; git is what lets a commit be
 * traced back to the Session that produced it.
 */
export function GitInitOffer({ busy, onGitInit }: { busy: boolean; onGitInit: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-element-active px-2.5 py-2">
      <GitBranch size={12} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
      <div className="min-w-0">
        <p className="text-xs text-[var(--secondary-foreground)]">
          Sessions are recorded here already. Initialize git to also link them to the commits they
          produce.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={onGitInit}
          className="mt-1 cursor-pointer text-xs text-[var(--foreground)] underline underline-offset-2 transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          Initialize git
        </button>
      </div>
    </div>
  );
}
