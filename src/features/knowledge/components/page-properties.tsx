import { usePageMeta, useKnowledgeMetaStore } from "../stores/knowledge-meta-store";
import { PagePropertiesView } from "./views/page-properties-view";

interface PagePropertiesProps {
  entryId: string;
  /** Optional editor `updatedAt` (file mtime) used as fallback when the
   *  metadata file has no entry for this page yet. */
  fallbackUpdatedAt?: string | null;
  referencesLabel?: string;
}

/**
 * The page-properties strip. Every row is editable inline; changes flow
 * through Rust's `knowledge_meta_patch` (debounced 300ms) and persist to
 * `.atlas/knowledge/_meta.json`. Not keyed on the page: the strip's open
 * state survives a page switch.
 */
export function PageProperties({
  entryId,
  fallbackUpdatedAt,
  referencesLabel = "—",
}: PagePropertiesProps) {
  const meta = usePageMeta(entryId);
  const { patch } = useKnowledgeMetaStore.use.actions();

  return (
    <PagePropertiesView
      meta={{
        status: meta.status ?? null,
        owner: meta.owner ?? null,
        tags: meta.tags ?? [],
        createdAt: meta.createdAt ?? null,
        updatedAt: meta.updatedAt ?? fallbackUpdatedAt ?? null,
      }}
      referencesLabel={referencesLabel}
      onPatch={(p) => void patch(entryId, p)}
    />
  );
}
