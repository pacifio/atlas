import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";

/**
 * Whether team chat (and the member roster beside it) can be used, and if not,
 * what unlocks it. Both are SERVER features: every route names a server org
 * id, so they need an Atlas account and an organization synced to it — the
 * same test `comms-panel.tsx` applies before it connects.
 *
 * Locked is not hidden: the entry points stay on screen, greyed, saying what
 * unlocks them, so the feature can be found before it can be used.
 */
export type TeamAccess =
  | { locked: false }
  | {
      locked: true;
      /** What unlocks it, finished by the caller ("Sign in to unlock team chat"). */
      reason: "signed-out" | "local-org";
      /** The action that unlocks it, when there is one a click can start. */
      unlock?: () => void;
    };

export function useTeamAccess(): TeamAccess {
  const signedIn = useAuthStore((s) => s.snapshot.status === "signed-in");
  const { beginSignIn } = useAuthStore.use.actions();
  const synced = useOrgStore((s) => {
    const org = s.organisations.find((o) => o.id === s.activeOrganisationId);
    return !!(org?.syncEnabled && org?.remoteId);
  });
  if (!signedIn) return { locked: true, reason: "signed-out", unlock: () => void beginSignIn() };
  if (!synced) return { locked: true, reason: "local-org" };
  return { locked: false };
}

/** The hint a locked entry point shows: "Sign in to unlock team chat". */
export function unlockHint(access: TeamAccess, feature: string): string | undefined {
  if (!access.locked) return undefined;
  return access.reason === "signed-out"
    ? `Sign in to unlock ${feature}`
    : `Sync this organization to unlock ${feature}`;
}
