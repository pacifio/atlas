/**
 * The list's search box, read as text plus typed qualifiers:
 *
 *   label:bug            label:"help wanted"     label:bug,wip (either)
 *   -label:wip           author:octocat          author:@me
 *   draft:true|false     review:approved|changes_requested|required|none
 *   checks:passing|failing   (status:success|failure as GitHub spells it)
 *
 * Any other `name:value` is a scoped label (`area:ui`), unless its value
 * starts with `/` (a pasted URL). A qualifier with nothing after the colon,
 * or one this list cannot honour (`-author:`), stays in the text. Pure, for
 * the test.
 */

import type { PrChecksState, PrReviewDecision } from "./pull-requests-types";

/** Every filter the list knows, typed or picked: the menu's filters with
 *  labels as OR groups and the labels to leave out. */
export interface PullRequestListFilters {
  draft?: "only" | "hide";
  review?: PrReviewDecision | "none";
  checks?: Extract<PrChecksState, "passing" | "failing">;
  author?: string;
  /** Each group ORs its labels; every group must hold. */
  labels?: string[][];
  excludedLabels?: string[];
}

const REVIEW_VALUES: Record<string, PullRequestListFilters["review"]> = {
  approved: "approved",
  changes_requested: "changes-requested",
  "changes-requested": "changes-requested",
  required: "review-required",
  "review-required": "review-required",
  none: "none",
};

const CHECKS_VALUES: Record<string, PullRequestListFilters["checks"]> = {
  success: "passing",
  passing: "passing",
  failure: "failing",
  failing: "failing",
};

const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/g;
const MAX_QUALIFIER_VALUES = 10;
const MAX_QUALIFIER_LENGTH = 200;

function qualifierValue(raw: string): string {
  return raw.replaceAll('"', "").trim();
}

function splitQualifierList(raw: string): string[] {
  return (raw.match(/(?:[^,"]|"[^"]*")+/g) ?? [])
    .map((part) => qualifierValue(part))
    .filter((part) => part.length > 0);
}

function boundedNames(names: readonly string[]): string[] {
  return names
    .slice(0, MAX_QUALIFIER_VALUES)
    .map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim())
    .filter((name) => name.length > 0);
}

export interface ParsedPullRequestQuery {
  /** What is left to search for as words. */
  text: string;
  filters: PullRequestListFilters;
}

export function parsePullRequestQuery(raw: string): ParsedPullRequestQuery {
  const text: string[] = [];
  const labels: string[][] = [];
  const excludedLabels: string[] = [];
  let author: string | undefined;
  let draft: PullRequestListFilters["draft"];
  let review: PullRequestListFilters["review"];
  let checks: PullRequestListFilters["checks"];
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(token);
    const value = qualifier === null ? "" : qualifierValue(qualifier[3] ?? "");
    const negated = qualifier?.[1] === "-";
    switch (value.length === 0 ? "" : (qualifier?.[2]?.toLowerCase() ?? "")) {
      case "label": {
        const names = boundedNames(splitQualifierList(qualifier?.[3] ?? ""));
        if (names.length === 0) break;
        if (negated) excludedLabels.push(...names);
        else labels.push(names);
        continue;
      }
      case "author":
        if (negated) break;
        author = value.slice(0, MAX_QUALIFIER_LENGTH).trim();
        continue;
      case "draft":
        if (negated || (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")) break;
        draft = value.toLowerCase() === "true" ? "only" : "hide";
        continue;
      case "review": {
        const decision = negated ? undefined : REVIEW_VALUES[value.toLowerCase()];
        if (decision === undefined) break;
        review = decision;
        continue;
      }
      case "status":
      case "checks": {
        const state = negated ? undefined : CHECKS_VALUES[value.toLowerCase()];
        if (state === undefined) break;
        checks = state;
        continue;
      }
      case "":
        break;
      default:
        if (!value.startsWith("/")) {
          const names = boundedNames(
            splitQualifierList(qualifier?.[3] ?? "").map((name) =>
              name.includes(":") ? name : `${qualifier?.[2] ?? ""}:${name}`,
            ),
          );
          if (names.length === 0) break;
          if (negated) excludedLabels.push(...names);
          else labels.push(names);
          continue;
        }
    }
    text.push(token);
  }
  return {
    text: text.join(" "),
    filters: {
      ...(labels.length === 0 ? {} : { labels: labels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(excludedLabels.length === 0
        ? {}
        : { excludedLabels: excludedLabels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(author === undefined ? {} : { author }),
      ...(draft === undefined ? {} : { draft }),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
    },
  };
}

/** The filters in force: the menu's, with each typed qualifier taking the
 *  place of the menu's value for the same field. */
export function mergePullRequestFilters(
  menu: {
    draft?: PullRequestListFilters["draft"];
    review?: PullRequestListFilters["review"];
    checks?: PullRequestListFilters["checks"];
    author?: string;
    labels?: string[];
  },
  typed: PullRequestListFilters,
): PullRequestListFilters {
  return {
    ...(menu.draft ? { draft: menu.draft } : {}),
    ...(menu.review ? { review: menu.review } : {}),
    ...(menu.checks ? { checks: menu.checks } : {}),
    ...(menu.author ? { author: menu.author } : {}),
    ...(menu.labels?.length ? { labels: menu.labels.map((label) => [label]) } : {}),
    ...typed,
  };
}

/** The part of the filters the host narrows by, as `pr_list` takes it:
 *  single labels as `labels`, OR groups as `labelGroups`. Review and checks
 *  are narrowed on this side, over what has loaded. */
export function pullRequestServerFilters(filters: PullRequestListFilters): {
  author: string | null;
  draft: string | null;
  labels: string[] | null;
  labelGroups: string[][] | null;
  excludedLabels: string[] | null;
} {
  const singles = (filters.labels ?? []).filter((group) => group.length === 1).map((g) => g[0]!);
  const groups = (filters.labels ?? []).filter((group) => group.length > 1);
  return {
    author: filters.author ?? null,
    draft: filters.draft ?? null,
    labels: singles.length > 0 ? singles : null,
    labelGroups: groups.length > 0 ? groups : null,
    excludedLabels: filters.excludedLabels?.length ? filters.excludedLabels : null,
  };
}

/**
 * The Draft menu shows a typed `draft:` qualifier, so picking another value
 * has to take the qualifier out of the query: left in, it would keep
 * outranking whatever the menu stores.
 */
export function applyPullRequestDraftFilterChange(
  query: string,
  menuDraft: PullRequestListFilters["draft"],
  nextDraft: PullRequestListFilters["draft"],
): { query: string; draft: PullRequestListFilters["draft"] } {
  const typedDraft = parsePullRequestQuery(query).filters.draft;
  if (nextDraft === (typedDraft ?? menuDraft)) return { query, draft: menuDraft };
  return {
    query:
      typedDraft === undefined
        ? query
        : [...query.matchAll(QUERY_TOKEN)]
            .map(([token]) => token)
            .filter((token) => parsePullRequestQuery(token).filters.draft === undefined)
            .join(" "),
    draft: nextDraft,
  };
}
