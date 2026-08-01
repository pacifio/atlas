import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Building2, Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { auth } from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "../stores/org-store";
import { switchOrg } from "../lib/org-switch";

/** The web origin an org handle lives under — shown as the static prefix. */
const HANDLE_PREFIX = "app.tryatlas.cc/";

/** Don't probe the server until the handle is at least this long. Keeps the
 *  first keystroke or two from spending the shared 100-req/60s auth budget. */
const MIN_HANDLE_FOR_CHECK = 2;

/** `disabled` regions render but can't be picked — EU isn't hosted yet, and
 *  showing it greyed is clearer than pretending US is the only place. */
const REGIONS = [
  { id: "us", label: "United States", disabled: false },
  { id: "eu", label: "European Union", disabled: true },
] as const;
type RegionId = (typeof REGIONS)[number]["id"];

/** Where the org lives. `local` is a real choice — private, offline, free —
 *  not a degraded mode; "Turn on sync" promotes it later. */
type OrgMode = "cloud" | "local";

/** Availability of the typed handle. `idle` also covers "signed out", where
 *  there is no server to ask and the handle is only locally validated. */
type SlugState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" }
  | { kind: "error"; message: string };

/**
 * Handle transform. Deliberately NOT `slugify` from `../types`: that falls back
 * to the literal `"org"` for empty input, which pre-filled the field and fired
 * an availability probe before the user had typed anything.
 */
function toHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "");
}

/** Same, but also trims a trailing "-" — for the value actually submitted. */
function finalHandle(raw: string): string {
  return toHandle(raw).replace(/-+$/, "");
}

/**
 * Create-organisation modal: a display name (anything) plus a globally-unique
 * handle, pre-checked against the server before submit (Linear-style).
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

  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    submitHandle.length > 0 &&
    slug.kind !== "taken" &&
    slug.kind !== "checking";

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const id = await createOrgSynced(name, submitHandle, cloud);
      onOpenChange(false);
      await switchOrg(id); // land the user in the org they just made
    } catch (e) {
      // Rust hands back a user-facing string (duplicate handle, offline, …).
      toast.error(
        typeof e === "string" ? e : "Couldn't create the organisation.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const fieldBase =
    "h-8 w-full rounded-lg border border-[#303030] bg-[#0C0C0C] px-2.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors focus:border-[#4a4a4a]";
  /** The app's pill-button language (matches "Save to KB" / "Commit changes"). */
  const pillButton =
    "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 py-1.5 text-[11px] font-medium leading-none cursor-pointer transition-colors";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* Strong dim + blur, same language as the unpinned workspace scrim —
            the frosted panel above it needs a hidden, low-contrast backdrop to
            read as a focus transition rather than a floating card. */}
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-max)] bg-black/45 backdrop-blur-xl" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              void submit();
            }
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-max)] -translate-x-1/2 -translate-y-1/2",
            "w-[400px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border-default)]",
            // Frosted, same language as the notification overlay.
            "bg-[var(--bg-elevated)]/60 backdrop-blur-2xl",
            "shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <Dialog.Close
            className="absolute right-2.5 top-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
            aria-label="Close"
          >
            <X size={13} />
          </Dialog.Close>

          <div className="px-4 pt-3.5 pb-4">
            <Dialog.Title className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              <Building2 size={13} className="text-[var(--text-tertiary)]" />
              Create organisation
            </Dialog.Title>

            <div className="mt-3.5 space-y-3">
              {/* Display name — anything the user wants. */}
              <label className="block">
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                  Name
                </span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Inc."
                  className={cn(fieldBase, "mt-1")}
                />
              </label>

              {/* Handle — prefix + input, with live availability. */}
              <div>
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                  Handle
                </span>
                <div
                  className={cn(
                    "mt-1 flex h-8 items-center overflow-hidden rounded-lg border bg-[#0C0C0C] transition-colors focus-within:border-[#4a4a4a]",
                    slug.kind === "taken" ? "border-error" : "border-[#303030]",
                  )}
                >
                  <span className="flex h-full shrink-0 select-none items-center border-r border-[#303030] px-2.5 text-[11px] text-[var(--text-tertiary)]">
                    {HANDLE_PREFIX}
                  </span>
                  <input
                    value={effectiveHandle}
                    onChange={(e) => {
                      setHandleDirty(true);
                      setHandle(e.target.value);
                    }}
                    placeholder="acme"
                    className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                  />
                  <span className="flex w-7 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
                    {slug.kind === "checking" && (
                      <Loader2 size={11} className="animate-spin" />
                    )}
                    {slug.kind === "available" && (
                      <Check size={11} className="text-success" />
                    )}
                  </span>
                </div>
                {/* Fixed-height hint row so the modal never jumps as you type. */}
                <p
                  className={cn(
                    "mt-1 h-[13px] text-[10px] leading-[13px]",
                    slug.kind === "taken"
                      ? "text-error"
                      : "text-[var(--text-tertiary)]",
                  )}
                >
                  {slug.kind === "taken"
                    ? "That handle is already taken."
                    : slug.kind === "error"
                      ? slug.message
                      : slug.kind === "available"
                        ? "That handle is available."
                        : "Lowercase letters, numbers and hyphens."}
                </p>
              </div>

              {/* Cloud vs local. Signed out there is nothing to sync to, so
                  cloud is unavailable rather than merely unselected. */}
              <div>
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                  Type
                </span>
                <div className="mt-1 flex gap-1.5">
                  {(
                    [
                      ["cloud", "Cloud", !signedIn],
                      ["local", "Local", false],
                    ] as const
                  ).map(([id, label, isDisabled]) => {
                    const on = mode === id;
                    return (
                      <button
                        key={id}
                        disabled={isDisabled}
                        title={
                          isDisabled
                            ? "Sign in to create a cloud organisation"
                            : undefined
                        }
                        onClick={() => setMode(id)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                          isDisabled
                            ? "cursor-not-allowed border-[#242424] bg-[#0C0C0C] text-[var(--text-tertiary)] opacity-40"
                            : on
                              ? "cursor-pointer border-[#4a4a4a] bg-[#1f1f1f] text-[var(--text-primary)]"
                              : "cursor-pointer border-[#303030] bg-[#0C0C0C] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">
                  {cloud
                    ? "Synced across your devices and shareable with your team."
                    : "Private and offline. Turn on sync later to share it."}
                </p>
              </div>

              {/* Region — pill selector. Meaningless for a local org, which
                  never leaves this machine. */}
              <div className={cn(!cloud && "opacity-40")}>
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                  Region
                </span>
                <div className="mt-1 flex gap-1.5">
                  {REGIONS.map((r) => {
                    const on = region === r.id;
                    const isDisabled = r.disabled || !cloud;
                    return (
                      <button
                        key={r.id}
                        disabled={isDisabled}
                        title={
                          !cloud
                            ? "A local organisation isn't hosted anywhere"
                            : r.disabled
                              ? "Not available yet"
                              : undefined
                        }
                        onClick={() => setRegion(r.id)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                          isDisabled
                            ? "cursor-not-allowed border-[#242424] bg-[#0C0C0C] text-[var(--text-tertiary)] opacity-40"
                            : on
                              ? "cursor-pointer border-[#4a4a4a] bg-[#1f1f1f] text-[var(--text-primary)]"
                              : "cursor-pointer border-[#303030] bg-[#0C0C0C] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                        )}
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Footer — the app's pill buttons. */}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => onOpenChange(false)}
                className={cn(
                  pillButton,
                  "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                )}
              >
                Cancel
              </button>
              <button
                disabled={!canSubmit}
                onClick={() => void submit()}
                className={cn(
                  pillButton,
                  "bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                {submitting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Building2 size={12} />
                )}
                Create organisation
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
