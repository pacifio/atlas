import { Check, ChevronDown, RefreshCw, Search, Star } from "lucide-react";
import {
  Button,
  EmptyState,
  Hint,
  Icon,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from "@tryatlas/design";
import { iconButtonVariants } from "@tryatlas/design/variants";
import { ProviderLogo } from "@/components/brand-marks";
import { cn } from "@/lib/utils";
import { composerPillClass } from "../../lib/composer-pill-class";

/**
 * The BYOK provider + model combo, drawn from props: a pill showing the
 * committed model, and a popover with a provider rail and a searchable model
 * list. `provider-model-pills.tsx` owns the keys, the model lists, pricing and
 * the auto-pick rule.
 *
 * Browsing is not committing: a rail click only changes `viewProvider`
 * (`onBrowse`); only a row pick (`onPick`) commits a provider and model.
 */

export interface ProviderModelPillsViewProps {
  /** The committed provider and model. */
  provider: string;
  model: string;
  /** The provider the rail is showing, which may differ from `provider`. */
  viewProvider: string;
  providers: { id: string; name: string; keyed: boolean }[];
  /** Whether `viewProvider` has a key. */
  hasKey: boolean;
  models: { pinned: string[]; rest: string[] };
  loadingModels: boolean;
  query: string;
  onQuery: (q: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBrowse: (providerId: string) => void;
  onPick: (modelId: string) => void;
  onSetUpKey: () => void;
  pricing: { label: (modelId: string) => string; loading: boolean; onRefresh: () => void };
}

export function ProviderModelPillsView({
  provider,
  model,
  viewProvider,
  providers,
  hasKey,
  models,
  loadingModels,
  query,
  onQuery,
  open,
  onOpenChange,
  onBrowse,
  onPick,
  onSetUpKey,
  pricing,
}: ProviderModelPillsViewProps) {
  const { pinned, rest } = models;
  const viewName = providers.find((p) => p.id === viewProvider)?.name ?? viewProvider;

  const row = (id: string, starred: boolean) => (
    <button
      key={id}
      type="button"
      onClick={() => onPick(id)}
      className="flex h-control-md w-full cursor-pointer items-center gap-2 px-2.5 text-left font-mono text-xs text-secondary-foreground outline-none hover:bg-element-hover hover:text-foreground"
    >
      {starred && <Star size={10} className="shrink-0 fill-primary text-primary" />}
      <span className="min-w-0 flex-1 truncate">{id}</span>
      <span
        className="shrink-0 text-2xs tnum text-muted-foreground"
        title="Price per 1M tokens (input / output) — models.dev"
      >
        {pricing.label(id)}
      </span>
      {viewProvider === provider && id === model && (
        <Check size={11} className="shrink-0 text-foreground" />
      )}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="provider-model-pill"
            className={cn(composerPillClass(open), "min-w-0")}
            title="Model — click to choose provider + model"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ProviderLogo id={provider || viewProvider} size={13} />
              {loadingModels && <Spinner size="xs" label="" />}
              <span className="max-w-[150px] truncate font-mono">
                {model || (loadingModels ? "Loading…" : "Select model")}
              </span>
              <ChevronDown size={11} className="text-muted-foreground" />
            </span>
          </button>
        }
      />
      <PopoverContent side="top" align="start" sideOffset={6} className="w-[360px] gap-0 p-0">
        <div className="flex max-h-[420px]">
          {/* Provider rail — ALWAYS shown, lists every chat provider. Ones
              without a key are dimmed; selecting one shows the setup prompt. */}
          <div className="hide-scrollbar flex min-h-0 w-9 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border-subtle py-1.5">
            {providers.map((p) => (
              <Hint key={p.id} label={`${p.name}${p.keyed ? "" : " — no API key"}`} side="left">
                <button
                  type="button"
                  onClick={() => onBrowse(p.id)}
                  className={cn(
                    iconButtonVariants({ size: "sm" }),
                    "cursor-pointer",
                    p.id === viewProvider && "bg-element-selected",
                    !p.keyed && "opacity-40 hover:opacity-70",
                  )}
                >
                  <ProviderLogo id={p.id} size={15} />
                </button>
              </Hint>
            ))}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {hasKey ? (
              <>
                {/* Search + pricing refresh */}
                <div className="border-b border-border-subtle p-1">
                  <InputGroup>
                    <InputGroupAddon>
                      <Icon icon={Search} size="sm" />
                    </InputGroupAddon>
                    <InputGroupInput
                      autoFocus
                      value={query}
                      onChange={(e) => onQuery(e.target.value)}
                      placeholder="Search models…"
                      spellCheck={false}
                    />
                    <InputGroupAddon align="inline-end">
                      <Hint label="Refresh model pricing (models.dev)" side="top">
                        <IconButton
                          icon={RefreshCw}
                          label="Refresh model pricing (models.dev)"
                          size="xs"
                          onClick={pricing.onRefresh}
                          disabled={pricing.loading}
                        />
                      </Hint>
                    </InputGroupAddon>
                  </InputGroup>
                </div>

                {/* Model list (name + $/1M) — fills the column height so the
                    popover has no dead "footer" gap below it. */}
                <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
                  {pinned.length === 0 && rest.length === 0 ? (
                    <div className="px-2.5 py-2 text-xs text-muted-foreground">
                      {loadingModels ? "Loading…" : "No models"}
                    </div>
                  ) : (
                    <>
                      {pinned.length > 0 && (
                        <>
                          <div className="eyebrow px-2.5 pt-1 pb-0.5">Recommended for coding</div>
                          {pinned.map((id) => row(id, true))}
                          {rest.length > 0 && <div className="my-1 h-px bg-border-subtle" />}
                        </>
                      )}
                      {rest.map((id) => row(id, false))}
                    </>
                  )}
                </div>
              </>
            ) : (
              /* No key for the browsed provider — prompt to set one up. */
              <div className="flex flex-1 flex-col items-center justify-center pt-8">
                <ProviderLogo id={viewProvider} size={22} />
                <EmptyState
                  className="-mt-10"
                  title={`No API key for ${viewName}`}
                  action={
                    <Button variant="secondary" size="sm" onClick={onSetUpKey}>
                      Set up key in Settings
                    </Button>
                  }
                />
              </div>
            )}
          </div>
        </div>

        {/* The "Compress Tokens" toggle stood here. It drove the old native
            runtime's RTK tool-output compressor, which the ported engine has
            no counterpart for (#54, D8) — so the control is gone rather than
            left switching nothing. */}
      </PopoverContent>
    </Popover>
  );
}
