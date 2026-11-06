import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { auth } from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "../stores/org-store";
import { switchOrg } from "../lib/org-switch";
import {
  MIN_HANDLE_FOR_CHECK,
  canSubmitCreate,
  finalHandle,
  toHandle,
  type OrgMode,
  type RegionId,
  type SlugState,
} from "../lib/org-switcher-model";
import { CreateOrgDialogView } from "./views/create-org-dialog-view";

/**
 * Create-organisation modal's container: the form state, the debounced
 * handle-availability probe, and the create-then-switch.
 *
 * The pre-check is advisory — the unique index on `organization.slug` is the
 * real guard — so submit still handles a rejection and surfaces it as a toast.
 */
export function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { createOrgSynced } = useOrgStore.use.actions();
  const signedIn = useAuthStore.use.snapshot().status === "signed-in";

  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  /** True once the user edits the handle directly — after that it stops
   *  tracking the name (Linear does the same). */
  const [handleDirty, setHandleDirty] = useState(false);
  /** Cloud = synced + shareable; local = private and offline. Signed out there
   *  is no choice to make, so it is pinned to local. */
  const [mode, setMode] = useState<OrgMode>("cloud");
  const [region, setRegion] = useState<RegionId>("us");
  const [slug, setSlug] = useState<SlugState>({ kind: "idle" });
  const [submitting, setSubmitting] = useState(false);

  const cloud = mode === "cloud" && signedIn;

  // Reset every field when the dialog (re)opens, so a cancelled attempt never
  // leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setName("");
    setHandle("");
    setHandleDirty(false);
    setMode(signedIn ? "cloud" : "local");
    setRegion("us");
    setSlug({ kind: "idle" });
    setSubmitting(false);
  }, [open, signedIn]);

  // Empty name → empty handle. No placeholder value, so nothing is probed until
  // the user actually types.
  const effectiveHandle = handleDirty ? toHandle(handle) : toHandle(name);
  const submitHandle = finalHandle(effectiveHandle);

  // Debounced availability probe. Signed out there is nothing to ask, so it
  // stays `idle` and only local validation applies at submit.
  const seq = useRef(0);
  useEffect(() => {
    // A local org's handle lives only on this machine, so there is no global
    // namespace to check it against — and nothing to spend a request on.
    if (!open || !cloud || submitHandle.length < MIN_HANDLE_FOR_CHECK) {
      setSlug({ kind: "idle" });
      return;
    }
    const mine = ++seq.current;
    setSlug({ kind: "checking" });
    const t = setTimeout(() => {
      void auth
        .checkOrgSlug(submitHandle)
        .then((available) => {
          if (seq.current !== mine) return; // a newer keystroke won
          setSlug({ kind: available ? "available" : "taken" });
        })
        .catch((e) => {
          if (seq.current !== mine) return;
          setSlug({
            kind: "error",
            message: typeof e === "string" ? e : "Couldn't check that handle.",
          });
        });
    }, 400);
    return () => clearTimeout(t);
  }, [open, cloud, submitHandle]);

  const canSubmit = canSubmitCreate({ submitting, name, handle: submitHandle, slug });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const id = await createOrgSynced(name, submitHandle, cloud);
      onOpenChange(false);
      await switchOrg(id); // land the user in the org they just made
    } catch (e) {
      // Rust hands back a user-facing string (duplicate handle, offline, …).
      toast.error(typeof e === "string" ? e : "Couldn't create the organization.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CreateOrgDialogView
      open={open}
      onOpenChange={onOpenChange}
      signedIn={signedIn}
      name={name}
      onNameChange={setName}
      handle={effectiveHandle}
      onHandleChange={(next) => {
        setHandleDirty(true);
        setHandle(next);
      }}
      mode={mode}
      onModeChange={setMode}
      region={region}
      onRegionChange={setRegion}
      slug={slug}
      canSubmit={canSubmit}
      submitting={submitting}
      onSubmit={() => void submit()}
    />
  );
}
