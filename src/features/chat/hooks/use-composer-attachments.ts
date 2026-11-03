// Every way something gets attached to the composer's prompt: a picked
// project or repo, a file by path (drop, "+" menu, paste, screenshot), a
// GitHub clone, a past session, a large paste.

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { useSessionProjectsStore } from "../stores/session-projects-store";
import { attachSessionProject, type AttachSource } from "../lib/session-projects-api";
import { downscaleAttachment, type StagedImage } from "../lib/downscale-attachment";
import { pastedTextMention } from "../lib/pasted-text";
import type {
  MentionData,
  MentionFile,
  MentionProject,
  MentionRepo,
  MentionPastSession,
  PastSessionRef,
} from "../lib/mentions";
import type { ChatInputHandle } from "../components/chat-input";
import type { GithubRepo } from "@/features/github/types";
import { metaFromSearch } from "@/features/github/types";
import { imageMimeFromPath } from "@/lib/byok/model-capabilities";
import { scratchPathForFile } from "@/lib/scratch-file";
import { useAppStore } from "@/features/app/stores/app-store";

export function useComposerAttachments({
  tabId,
  inputRef,
  projectPath,
  imageSupported,
  setStagedImages,
  setGithubSyncing,
}: {
  tabId: string;
  inputRef: RefObject<ChatInputHandle | null>;
  projectPath: string | null;
  imageSupported: boolean;
  setStagedImages: Dispatch<SetStateAction<StagedImage[]>>;
  setGithubSyncing: Dispatch<SetStateAction<string | null>>;
}) {
  // Picking a project or repo attaches it to the session, read-only, so its
  // chip can offer the access toggle before the send. A session that has not
  // bound yet attaches it at the send instead (`attach-mentioned-projects.ts`).
  // A refused folder (home, a system folder) says why at the send, not here.
  const attachPicked = useCallback(
    (mention: MentionData, source: AttachSource = "mention") => {
      if (mention.kind !== "workspace" && mention.kind !== "repo") return;
      const sessionId = useChatStore.getState().sessions[tabId]?.acpSessionId;
      if (!sessionId) return;
      attachSessionProject(sessionId, mention.absPath, {
        displayName: mention.displayName,
        source,
      })
        .then((change) =>
          useSessionProjectsStore.getState().actions.replace(sessionId, change.projects),
        )
        .catch(() => {});
    },
    [tabId],
  );

  // ── File chips ──────────────────────────────────────────────────────────
  // A path the agent reads off disk, as a chip at the caret. Every file with
  // a path arrives through `attachPaths` (below), which calls this for all of
  // them; an image the agent can take also stages its bytes.
  const insertFileChips = useCallback(
    (paths: string[], sizes?: ReadonlyMap<string, number>) => {
      const root = projectPath && !projectPath.endsWith("/") ? `${projectPath}/` : projectPath;
      for (const abs of paths) {
        // Relative-to-project display name when the file lives inside the
        // project; otherwise just the basename (dropped files can be anywhere).
        const displayName =
          root && abs.startsWith(root) ? abs.slice(root.length) : abs.split("/").pop() || abs;
        const mention: MentionFile = {
          kind: "file",
          id: abs,
          displayName,
          absPath: abs,
        };
        inputRef.current?.insertMention(mention, { sizeBytes: sizes?.get(abs) });
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [projectPath],
  );

  // ── Attaching files by path ──────────────────────────────────────────────
  // The one routing rule for every way a file arrives — dropped from Finder,
  // picked in the "+" menu, copied in Finder and pasted, a pasted screenshot
  // (spooled to a file first, `handlePasteImages`), the screenshot tool:
  // every file becomes a chip at the caret, and an image the agent can take
  // is staged inline as well, behind its chip. One routing
  // for all of them, because the ways used to disagree: a paste staged a
  // thumbnail and left nothing in the sentence, so "look at [this]" had no
  // "this" in it; a drop made a chip and no thumbnail; and before that a
  // dropped screenshot reached the agent as a path it might never open while
  // the same image pasted arrived inline.
  const attachPaths = useCallback(
    async (paths: string[]) => {
      const images: StagedImage[] = [];
      const sizes = new Map<string, number>();
      for (const p of paths) {
        const mime = imageSupported ? imageMimeFromPath(p) : null;
        if (!mime) continue;
        try {
          const data = await invoke<string>("read_file_base64", { path: p });
          // The file's size, from the base64 it came as (the padding makes
          // this at most two bytes over).
          sizes.set(p, Math.floor((data.length * 3) / 4));
          images.push({
            ...(await downscaleAttachment({ mimeType: mime, dataBase64: data })),
            path: p,
          });
        } catch {
          // Unreadable as base64: the chip alone, as for any other file.
        }
      }
      if (images.length) setStagedImages((prev) => [...prev, ...images]);
      insertFileChips(paths, sizes);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [imageSupported, insertFileChips],
  );

  // "+" menu → "Add files or photos". The Tauri dialog hands back real
  // paths (a browser file input wouldn't), which is what makes the
  // `attachPaths` routing possible.
  const pickFilesOrPhotos = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        title: "Attach files or photos",
      });
      if (!picked) return;
      await attachPaths((Array.isArray(picked) ? picked : [picked]) as string[]);
    } catch (err) {
      console.warn("attach picker failed:", err);
    }
  }, [attachPaths]);

  const handlePickProject = useCallback(
    (project: MentionProject) => {
      inputRef.current?.insertMention(project);
      attachPicked(project);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [attachPicked],
  );

  // "+" menu → "Attach media". The files picker, with the OS dialog filtered
  // to image/video extensions; video becomes a path chip via `attachPaths`.
  const pickMedia = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        title: "Attach media",
        filters: [
          {
            name: "Media",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "heic",
              "bmp",
              "svg",
              "mp4",
              "mov",
              "webm",
              "m4v",
              "avi",
              "mkv",
            ],
          },
        ],
      });
      if (!picked) return;
      await attachPaths((Array.isArray(picked) ? picked : [picked]) as string[]);
    } catch (err) {
      console.warn("media picker failed:", err);
    }
  }, [attachPaths]);

  // "+" menu → "Take a screenshot". Shells out to the native macOS
  // `screencapture` CLI (region selection or whole desktop), then attaches the
  // saved `.atlas/screenshots/…` PNG like any other file (`attachPaths`).
  const handleTakeScreenshot = useCallback(
    async (mode: "region" | "full") => {
      try {
        // Let the "+" menu fully close first so it (and any dropdown) isn't caught
        // in a whole-desktop capture.
        await new Promise((r) => setTimeout(r, 250));
        const proj = useAppStore.getState().currentProject?.path ?? null;
        const res = await invoke<{ path: string } | null>("capture_screenshot", {
          mode,
          projectPath: proj,
        });
        if (!res) return; // cancelled (Esc during region select)
        await attachPaths([res.path]);
      } catch (err) {
        toast.error(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [attachPaths],
  );

  // "+" menu → "Add from GitHub". Shorthand for the GitHub panel's search+clone:
  // download the repo into `<project>/.atlas/repos`, lock the composer while it
  // syncs, then drop a `@repo:` chip carrying the local path so the agent
  // explores it (compose_prompt turns that chip into an "explore this repo"
  // block pointing at the absolute path).
  const handleCloneRepo = useCallback(
    async (repo: GithubRepo) => {
      const proj = useAppStore.getState().currentProject?.path;
      if (!proj) {
        toast.error("Open a project before cloning a repo.");
        return;
      }
      setGithubSyncing(repo.full_name);
      try {
        const dest = await invoke<string>("clone_github_repo", {
          projectPath: proj,
          cloneUrl: repo.clone_url,
          repoName: repo.full_name.replace(/\//g, "-"),
          meta: metaFromSearch(repo),
        });
        const folderName = dest.split("/").pop() || repo.full_name.replace(/\//g, "-");
        const mention: MentionRepo = {
          kind: "repo",
          id: dest,
          displayName: folderName,
          absPath: dest,
          hasReadme: false,
        };
        inputRef.current?.insertMention(mention);
        attachPicked(mention, "clone");
        // Keep the knowledge sidebar's cloned-repos list in sync (same signal the
        // GitHub panel emits).
        window.dispatchEvent(new Event("atlas:repo-cloned"));
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (err) {
        toast.error(
          `Couldn't clone ${repo.full_name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setGithubSyncing(null);
      }
    },
    [attachPicked],
  );

  // "+" menu → "Attach a session". Reference a past session's transcript; the
  // (potentially large) body is read + formatted at send time by composePrompt.
  const handlePickSession = useCallback((session: PastSessionRef) => {
    const mention: MentionPastSession = {
      kind: "past_session",
      id: session.id,
      displayName: session.title,
      sessionId: session.id,
      sessionTitle: session.title,
      cwd: session.cwd,
    };
    inputRef.current?.insertMention(mention);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Clipboard images (screenshots). A pasted screenshot is bytes with no
  // path, so it is spooled to a scratch file first and then attached like
  // every other file (`attachPaths`): a chip in the sentence, with its bytes
  // staged when the agent takes images. Taking the paste either way matters —
  // declining it left the paste to a handler that only knows Finder paths,
  // and the image vanished without a word.
  const handlePasteImages = useCallback(
    (files: File[]) => {
      void Promise.all(files.map(scratchPathForFile))
        .then(attachPaths)
        .catch((err) => {
          console.warn("image paste failed:", err);
          toast.error("Could not attach the pasted image.");
        });
      return true;
    },
    [attachPaths],
  );

  // A paste over the large-paste limit (`isLargePaste`: ~4,000 characters or
  // 80 lines) — a log, a stack dump, a whole file — becomes a chip holding
  // the whole text, so the editor never lays it out. The text goes to the
  // agent in full at send, in whichever form it accepts (`pasted-text.ts`).
  const handlePasteLargeText = useCallback((text: string) => {
    const input = inputRef.current;
    if (!input) return false;
    input.insertMention(pastedTextMention(text));
    return true;
  }, []);

  return {
    attachPicked,
    attachPaths,
    pickFilesOrPhotos,
    handlePickProject,
    pickMedia,
    handleTakeScreenshot,
    handleCloneRepo,
    handlePickSession,
    handlePasteImages,
    handlePasteLargeText,
  };
}
