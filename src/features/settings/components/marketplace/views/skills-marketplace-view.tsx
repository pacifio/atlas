// Settings → Skills → Discover, rendered from props: the registry list with its
// search, and the dialog a registry hit opens. `skills-marketplace.tsx` owns
// the searches, the caches and the installs.

import type { ReactNode } from "react";
import { Boxes, Check, Copy, Download } from "lucide-react";
import { Badge, Button, Hint, Icon } from "@tryatlas/design";

import { AtlasLoader } from "@/components/atlas-loader";
import { GithubIcon } from "@/components/github-icon";
import { TrendSparkline } from "@/components/trend-sparkline";
import type { PackSearchHit } from "@/features/packs/lib/types";
import { MARKET_KIND_LABEL, type SkillDetail } from "@/features/skills/lib/skills-view-model";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "../../layout/settings-layout";
import { SettingsSearch } from "../../layout/settings-search";
import { SkillDescriptions, SkillDialog } from "./skill-modal-view";

const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export interface MarketRow {
  hit: PackSearchHit;
  installed: boolean;
  installing: boolean;
  /** Install counts over time, for the sparkline. */
  trend: number[];
}

export function SkillsMarketplaceView({
  query,
  onQueryChange,
  loading,
  rows,
  more,
  onShowMore,
  onSelect,
  onInstall,
  children,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  loading: boolean;
  /** The rows on show (the current page). */
  rows: MarketRow[];
  /** How many more "Show more" reveals; 0 hides it. */
  more: number;
  onShowMore: () => void;
  onSelect: (hit: PackSearchHit) => void;
  onInstall: (hit: PackSearchHit) => void;
  /** The detail dialog. */
  children?: ReactNode;
}) {
  return (
    <SettingsSection
      title="Discover"
      description="Skills from the skills.sh registry, most installed first."
    >
      <div className="flex">
        <SettingsSearch
          value={query}
          onValueChange={onQueryChange}
          label="Search the skills registry"
          placeholder="Search the skills registry"
          trailing={loading && <AtlasLoader size={11} />}
        />
      </div>
      <SettingsGroup>
        {rows.length === 0 ? (
          <SettingsNote>
            {loading
              ? "Searching…"
              : query.trim()
                ? `No skill matches “${query.trim()}”.`
                : "Search the registry to find skills."}
          </SettingsNote>
        ) : (
          rows.map(({ hit, installed, installing, trend }) => (
            <SettingsRow
              key={hit.id}
              title={
                <button
                  type="button"
                  onClick={() => onSelect(hit)}
                  className="text-left hover:underline"
                >
                  {hit.name}
                </button>
              }
              description={<span className="font-mono">{hit.source}</span>}
              control={
                <>
                  {/* Aesthetic, not analytic: the shape reads as momentum and
                      the number beside it is the exact count. */}
                  <span className="flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
                    <TrendSparkline
                      points={trend}
                      width={48}
                      height={16}
                      label="Installs over the last 6 months"
                    />
                    <Hint label={`${hit.installs.toLocaleString()} installs`}>
                      <span tabIndex={0} className="w-10 text-right">
                        {COMPACT.format(hit.installs)}
                      </span>
                    </Hint>
                  </span>
                  <InstallButton
                    name={hit.name}
                    installed={installed}
                    installing={installing}
                    onClick={() => onInstall(hit)}
                  />
                </>
              }
            />
          ))
        )}
        {more > 0 && (
          <div className="p-1">
            <Button variant="ghost" size="sm" className="w-full" onClick={onShowMore}>
              Show {more} more
            </Button>
          </div>
        )}
      </SettingsGroup>
      {children}
    </SettingsSection>
  );
}

function InstallButton({
  name,
  installed,
  installing,
  onClick,
}: {
  name: string;
  installed: boolean;
  installing: boolean;
  onClick: () => void;
}) {
  if (installed) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-20"
        disabled
        aria-label={`${name} is installed`}
      >
        <Icon icon={Check} size="xs" />
        Installed
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-20"
      disabled={installing}
      aria-label={`Install ${name}`}
      onClick={onClick}
    >
      {installing ? <AtlasLoader size={11} /> : <Icon icon={Download} size="xs" />}
      Install
    </Button>
  );
}

/** The dialog a registry hit opens: what the repo preview says it holds, and
 *  Install. `status` is the preview fetch; the hit installs either way. */
export function SkillDetailDialogView({
  hit,
  installed,
  installing,
  status,
  detail,
  onInstall,
  onCopy,
  onOpenGithub,
  onClose,
}: {
  hit: PackSearchHit | null;
  installed: boolean;
  installing: boolean;
  status: "loading" | "ready" | "failed";
  detail: SkillDetail;
  onInstall: () => void;
  onCopy: () => void;
  onOpenGithub: () => void;
  onClose: () => void;
}) {
  const { manifestDescription, skills, otherCounts } = detail;
  return (
    <SkillDialog
      open={!!hit}
      onClose={onClose}
      title={hit?.name ?? ""}
      subtitle={hit ? `${hit.source} · ${hit.installs.toLocaleString()} installs` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onCopy}>
            <Icon icon={Copy} size="xs" />
            Copy as Markdown
          </Button>
          <Button variant="ghost" onClick={onOpenGithub}>
            <GithubIcon size={12} />
            GitHub
          </Button>
          <Button disabled={installed || installing} onClick={onInstall}>
            {installing ? (
              <AtlasLoader size={11} />
            ) : (
              <Icon icon={installed ? Check : Download} size="xs" />
            )}
            {installed ? "Installed" : "Install"}
          </Button>
        </>
      }
    >
      {status === "loading" ? (
        <p className="caption">Loading details…</p>
      ) : status === "ready" ? (
        <>
          {manifestDescription && (
            <p className="text-sm text-secondary-foreground">{manifestDescription}</p>
          )}
          {skills.length > 0 && <SkillDescriptions skills={skills} />}
          {otherCounts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {otherCounts.map(([kind, n]) => (
                <Badge key={kind} variant="outline">
                  <Icon icon={Boxes} size="xs" />
                  {n} {MARKET_KIND_LABEL[kind]}
                  {n > 1 ? "s" : ""}
                </Badge>
              ))}
            </div>
          )}
          {!manifestDescription && skills.length === 0 && otherCounts.length === 0 && (
            <p className="caption">No details published.</p>
          )}
        </>
      ) : (
        <p className="caption">Couldn't load the details. You can still install it.</p>
      )}
    </SkillDialog>
  );
}
