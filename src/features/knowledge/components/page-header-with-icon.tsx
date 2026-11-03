import { useEffect, useState } from "react";
import { useKnowledgeMetaStore, usePageMeta } from "../stores/knowledge-meta-store";
import { IconPicker } from "./icon-picker";
import { CoverPicker, gradientCss } from "./cover-picker";
import { coverCacheKey, getCachedCoverUrl, putCachedCoverUrl } from "../lib/cover-url-cache";
import { knowledgeCoverDataUrl } from "../lib/knowledge-api";
import { PageHeaderView } from "./views/page-header-view";

export function PageHeaderWithIcon({
  entryId,
  projectPath,
  title,
}: {
  entryId: string;
  projectPath: string;
  /** Resolved display title (meta.title ?? filename fallback). The
   *  input below is treated as a controlled-with-debounce field; the
   *  parent rebuilds this prop when meta changes. */
  title: string;
}) {
  const meta = usePageMeta(entryId);
  const { patch } = useKnowledgeMetaStore.use.actions();
  const icon = meta.icon || "📄";
  const cover = meta.cover ?? null;
  const [iconAnchor, setIconAnchor] = useState<DOMRect | null>(null);
  const [coverAnchor, setCoverAnchor] = useState<DOMRect | null>(null);

  // Local draft so typing into the title input doesn't fire a Rust
  // patch on every keystroke. We commit on blur + Enter.
  const [titleDraft, setTitleDraft] = useState(title);
  useEffect(() => {
    setTitleDraft(title);
  }, [title, entryId]);

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (!entryId) return;
    if (!next) {
      // Empty draft → clear the override so the filename fallback wins
      // again.
      if (meta.title !== null && meta.title !== undefined) {
        void patch(entryId, { title: null });
      }
      return;
    }
    if (next !== (meta.title ?? "")) {
      void patch(entryId, { title: next });
    }
  };

  const isGradientCover = cover?.startsWith("gradient:");
  const gradient = isGradientCover ? gradientCss(cover!) : null;

  // Covers are stored under the hidden `.atlas/` directory, which Tauri's
  // asset protocol refuses to serve (the webview 403s the asset:// request).
  // Fetch the image as a base64 `data:` URL instead — it embeds the bytes
  // directly, so the cover renders identically in dev and bundled builds
  // without depending on the asset protocol or its scope globs.
  //
  // Cached per cover ref (see cover-url-cache) so page switches between
  // covered pages don't re-read + re-encode + re-ship the image over IPC —
  // that was a visible loading flash plus a main-thread parse hitch per
  // navigation. Upload evicts (the ref is entry-id-stable, not per-upload).
  const cacheKey = cover ? coverCacheKey(projectPath, cover) : null;
  const [coverUrl, setCoverUrl] = useState<string | null>(() =>
    cacheKey ? getCachedCoverUrl(cacheKey) : null,
  );
  useEffect(() => {
    if (!cover || !cacheKey || isGradientCover) {
      setCoverUrl(null);
      return;
    }
    const cached = getCachedCoverUrl(cacheKey);
    if (cached) {
      setCoverUrl(cached);
      return;
    }
    let alive = true;
    void knowledgeCoverDataUrl(projectPath, cover)
      .then((url) => {
        putCachedCoverUrl(cacheKey, url);
        if (alive) setCoverUrl(url);
      })
      .catch(() => {
        if (alive) setCoverUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [cover, cacheKey, isGradientCover, projectPath]);

  return (
    <PageHeaderView
      cover={cover}
      coverBackground={
        gradient ?? (coverUrl ? `center / cover no-repeat url("${coverUrl}")` : "var(--card)")
      }
      icon={icon}
      titleDraft={titleDraft}
      onTitleDraftChange={setTitleDraft}
      onTitleCommit={commitTitle}
      onTitleCancel={() => setTitleDraft(title)}
      onOpenCoverPicker={setCoverAnchor}
      onOpenIconPicker={setIconAnchor}
      pickers={
        <>
          {iconAnchor && (
            <IconPicker
              value={meta.icon ?? null}
              anchorRect={iconAnchor}
              onPick={(v) => entryId && void patch(entryId, { icon: v })}
              onClose={() => setIconAnchor(null)}
            />
          )}
          {coverAnchor && entryId && (
            <CoverPicker
              value={cover}
              projectPath={projectPath}
              entryId={entryId}
              anchorRect={coverAnchor}
              onPick={(v) => void patch(entryId, { cover: v })}
              onClose={() => setCoverAnchor(null)}
            />
          )}
        </>
      }
    />
  );
}
