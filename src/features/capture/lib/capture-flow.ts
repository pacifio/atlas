// The capture popover's flow shapes, shared by its containers and views.

import type { Organisation } from "@/features/organisations/types";
import type { ConnectPick, ImportPreview, PromotionPreview } from "../types";

/** A synced Organisation — the only kind Cloud and Connect can target. */
export type CloudOrg = Organisation & { remoteId: string };

/**
 * Everything a Cloud registration is created with.
 *
 * Carried as one value through the disclosure step rather than as four
 * parallel fields, so adding a fifth does not touch every signature between
 * the form and the confirm.
 */
export interface CloudDraft {
  orgId: string;
  slug: string;
  /** May be empty — a Project with no remote is legitimate. */
  gitUrl: string;
  restricted: boolean;
}

export type View =
  | { kind: "main" }
  /** Cloud create: the import disclosure, with the registration still pending. */
  | {
      kind: "cloud-confirm";
      draft: CloudDraft;
      preview: ImportPreview;
    }
  /** Bound Cloud Project whose history import awaits approval. */
  | { kind: "import-confirm"; preview: ImportPreview }
  /** Local→Cloud promotion: pick the destination — a new Project, or an
   *  existing one. The tab is part of the view so a failed Continue lands
   *  back where the pick was made. */
  | { kind: "promote-form"; tab: PromoteTab }
  /** Local→Cloud promotion onto a NEW Project: the disclosure. */
  | {
      kind: "promote-confirm";
      draft: CloudDraft;
      preview: PromotionPreview;
    }
  /** Local→Cloud promotion onto an EXISTING Project: the disclosure. */
  | {
      kind: "promote-connect-confirm";
      pick: ConnectPick;
      preview: PromotionPreview;
    }
  /** Cloud→Cloud: pick a different Project in the same Organisation. */
  | { kind: "switch-form" }
  /** Cloud→Cloud: the disclosure — everything is re-sent, comments stay. */
  | {
      kind: "switch-confirm";
      pick: ConnectPick;
      preview: PromotionPreview;
    };

export type PromoteTab = "create" | "connect";

export type SlugState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" }
  | { kind: "unknown"; retry: () => void };

/** Runs a mutation with the busy/error/re-read bookkeeping; `true` on success. */
export type RunAction = (action: () => Promise<unknown>) => Promise<boolean>;
