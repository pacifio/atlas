/**
 * Mounts the theme editor at the app root while a session is open. It sits outside Settings so that closing
 * Settings — to see the editor, sidebar or terminal in the new colours —
 * leaves the editor open; the panel itself only loads once it is first used.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { getTheme } from "../../lib/theme-api";
import { useThemeEditorStore } from "../../stores/theme-editor-store";
import type { Theme } from "@tryatlas/design/theme";

const ThemeEditorPanel = lazy(() =>
  import("./theme-editor-panel").then((m) => ({ default: m.ThemeEditorPanel })),
);

export function ThemeEditorHost() {
  const session = useThemeEditorStore.use.session();
  const { close } = useThemeEditorStore.use.actions();
  const [source, setSource] = useState<{ session: number; theme: Theme } | null>(null);

  const sessionId = session?.id;
  const sourceId = session?.sourceId;
  useEffect(() => {
    if (sessionId === undefined || sourceId === undefined) return;
    let cancelled = false;
    getTheme(sourceId).then(
      (theme) => {
        if (!cancelled) setSource({ session: sessionId, theme });
      },
      (cause: unknown) => {
        if (cancelled) return;
        toast.error(`Couldn't open the theme: ${String(cause)}`);
        close();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, sourceId, close]);

  // A stale source (the previous session's) never reaches the panel, and the
  // key remounts it per session so its draft starts over.
  if (!session || source?.session !== session.id) return null;
  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel key={session.id} session={session} source={source.theme} onClose={close} />
    </Suspense>
  );
}
