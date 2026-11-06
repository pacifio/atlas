import { useCallback, useEffect, useState } from "react";

import {
  captureBinding,
  captureDetect,
  captureGitAvailable,
  captureImportPreview,
  capturePromotionPreview,
} from "../lib/capture-api";
import type { RunAction, View } from "../lib/capture-flow";
import { invalidateProjectFacts } from "../lib/project-facts";
import type { Binding, Detection, ImportPreview, PromotionPreview } from "../types";

/**
 * The capture popover's state: the project's binding and facts, the current
 * step, and the busy/error bookkeeping every mutation runs through.
 */
export function useCapturePopover(projectPath: string, onChanged: () => void) {
  const [binding, setBinding] = useState<Binding | null>(null);
  /**
   * Has the first read landed?
   *
   * `binding` starts `null`, which is also what an unbound project reads as —
   * so the popover rendered the whole **Create** form for the frame before the
   * read resolved, then swapped to the bound state. On an enabled project that
   * is a visible flash of the wrong UI every single time it opens. Nothing at
   * all renders until the answer is in; the read is a local SQLite hit, so the
   * wait is imperceptible and the panel's enter animation simply starts a frame
   * later, fully formed.
   */
  const [loaded, setLoaded] = useState(false);
  const [detection, setDetection] = useState<Detection | null>(null);
  /**
   * Is `git` on this machine at all?
   *
   * Assumed present until the probe says otherwise, so the common case never
   * flashes a banner. Distinct from `detection.isGitRepository`, which is about
   * *this directory* and is what the `git init` offer fixes — no amount of
   * `git init` helps a machine with no git.
   */
  const [gitAvailable, setGitAvailable] = useState(true);
  /** `undefined` while the read is in flight, `null` once it failed — the
   *  Cloud "Continue" button needs the difference to gate honestly. */
  const [importPreview, setImportPreview] = useState<ImportPreview | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "main" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [current, detected, preview, hasGit] = await Promise.all([
        captureBinding(projectPath),
        captureDetect(projectPath),
        // Read-only and cheap — the "history N sessions on disk" row and both
        // disclosure steps feed off it. A failure lands as `null`, which the
        // Cloud path surfaces with a retry instead of silently no-opping.
        captureImportPreview(projectPath).catch(() => null),
        // A failed probe reads as "git is there": a banner shown wrongly is
        // worse than one missed, because the machine that really has no git
        // finds out from the very next operation anyway.
        captureGitAvailable().catch(() => true),
      ]);
      setBinding(current);
      setDetection(detected);
      setImportPreview(preview);
      setGitAvailable(hasGit);
    } catch (e) {
      setError(String(e));
    } finally {
      // In `finally`, so a failed read still opens the panel — with the error
      // on it — rather than leaving a permanently empty popover.
      setLoaded(true);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Re-read just the preview — the retry for a failed preview load. */
  const retryPreview = useCallback(async () => {
    setImportPreview(undefined);
    try {
      setImportPreview(await captureImportPreview(projectPath));
    } catch {
      setImportPreview(null);
    }
  }, [projectPath]);

  /**
   * The promote disclosure's numbers. Read-only — a failure lands in the error
   * strip and leaves the form where it was, so nothing is lost but a click.
   */
  const loadPromotionPreview = async (): Promise<PromotionPreview | null> => {
    setBusy(true);
    setError(null);
    try {
      return await capturePromotionPreview(projectPath);
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const run: RunAction = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      // Always re-read, success or not: a multi-step action (Cloud confirm,
      // Connect) can fail after its first mutation landed, and showing the
      // pre-action state over a Project that changed is a lie. `load` never
      // clears `error` on success, so the failure stays visible.
      await load();
      // Anything reading this project's capture facts (the overview's Session
      // card) keeps them cached; tell it they moved.
      invalidateProjectFacts(projectPath);
      onChanged();
      setBusy(false);
    }
  };

  return {
    binding,
    loaded,
    detection,
    gitAvailable,
    importPreview,
    view,
    setView,
    busy,
    error,
    retryPreview,
    loadPromotionPreview,
    run,
  };
}
