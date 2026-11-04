import { Building2, Check } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Icon,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Spinner,
  Toggle,
} from "@tryatlas/design";

import {
  HANDLE_PREFIX,
  REGIONS,
  type OrgMode,
  type RegionId,
  type SlugState,
} from "../../lib/org-switcher-model";

/**
 * Create-organisation form: a display name (anything) plus a globally-unique
 * handle, pre-checked against the server before submit (Linear-style), where
 * it lives (cloud or local) and, for cloud, its region.
 *
 * Every pill is its own Tab stop — one `Toggle` per option rather than a
 * roving group.
 */
export function CreateOrgDialogView({
  open,
  onOpenChange,
  signedIn,
  name,
  onNameChange,
  handle,
  onHandleChange,
  mode,
  onModeChange,
  region,
  onRegionChange,
  slug,
  canSubmit,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signedIn: boolean;
  name: string;
  onNameChange: (name: string) => void;
  handle: string;
  onHandleChange: (handle: string) => void;
  mode: OrgMode;
  onModeChange: (mode: OrgMode) => void;
  region: RegionId;
  onRegionChange: (region: RegionId) => void;
  slug: SlugState;
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const cloud = mode === "cloud" && signedIn;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[min(25rem,92vw)]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Icon icon={Building2} size="md" className="text-muted-foreground" />
          <DialogTitle>Create organization</DialogTitle>
        </div>

        <div className="flex flex-col gap-3">
          {/* Display name — anything the user wants. */}
          <Field>
            <FieldLabel htmlFor="create-org-name">Name</FieldLabel>
            <Input
              id="create-org-name"
              autoFocus
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Acme Inc."
            />
          </Field>

          {/* Handle — prefix + input, with live availability. */}
          <Field>
            <FieldLabel htmlFor="create-org-handle">Handle</FieldLabel>
            {/* The group draws its own focus; see the menu filter in
                `org-menu-panel-view.tsx` for why the inner ring goes. */}
            <div className="[&_input]:focus-visible:outline-none">
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>{HANDLE_PREFIX}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="create-org-handle"
                  value={handle}
                  onChange={(e) => onHandleChange(e.target.value)}
                  placeholder="acme"
                  aria-invalid={slug.kind === "taken" || undefined}
                />
                <InputGroupAddon align="inline-end">
                  {slug.kind === "checking" && <Spinner size="sm" label="" />}
                  {slug.kind === "available" && (
                    <Icon icon={Check} size="sm" className="text-success" />
                  )}
                </InputGroupAddon>
              </InputGroup>
            </div>
            {/* One line, always present, so the modal never jumps as you type. */}
            {slug.kind === "taken" ? (
              <FieldError className="min-h-4">That handle is already taken.</FieldError>
            ) : (
              <FieldDescription className="min-h-4">
                {slug.kind === "error"
                  ? slug.message
                  : slug.kind === "available"
                    ? "That handle is available."
                    : "Lowercase letters, numbers and hyphens."}
              </FieldDescription>
            )}
          </Field>

          {/* Cloud vs local. Signed out there is nothing to sync to, so cloud
              is unavailable rather than merely unselected. */}
          <Field>
            <FieldLabel>Type</FieldLabel>
            <div className="flex gap-1.5">
              {(
                [
                  ["cloud", "Cloud", !signedIn],
                  ["local", "Local", false],
                ] as const
              ).map(([id, label, isDisabled]) => (
                <Toggle
                  key={id}
                  variant="outline"
                  size="sm"
                  pressed={mode === id}
                  onPressedChange={() => onModeChange(id)}
                  disabled={isDisabled}
                  title={isDisabled ? "Sign in to create a cloud organization" : undefined}
                >
                  {label}
                </Toggle>
              ))}
            </div>
            <FieldDescription>
              {cloud
                ? "Synced across your devices and shareable with your team."
                : "Private and offline. Turn on sync later to share it."}
            </FieldDescription>
          </Field>

          {/* Region — meaningless for a local org, which never leaves this
              machine. */}
          <Field>
            <FieldLabel>Region</FieldLabel>
            <div className="flex gap-1.5">
              {REGIONS.map((r) => (
                <Toggle
                  key={r.id}
                  variant="outline"
                  size="sm"
                  pressed={region === r.id}
                  onPressedChange={() => onRegionChange(r.id)}
                  disabled={r.disabled || !cloud}
                  title={
                    !cloud
                      ? "A local organization isn't hosted anywhere"
                      : r.disabled
                        ? "Not available yet"
                        : undefined
                  }
                >
                  {r.label}
                </Toggle>
              ))}
            </div>
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="default" size="md" disabled={!canSubmit} onClick={onSubmit}>
            {submitting ? <Spinner size="sm" label="" /> : <Icon icon={Building2} size="sm" />}
            Create organization
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
