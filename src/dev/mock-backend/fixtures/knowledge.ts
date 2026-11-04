// The Knowledge tab and the knowledge-graph tab, for every scenario.
//
// A populated knowledge base: ten linked notes across three folders, with
// page metadata (icons, covers, status, tags). Held in memory so the panel
// can be clicked through: new, edited and deleted notes, new folders, meta
// patches and graph drags all show up in later answers, until the page
// reloads. Backlinks, link counts and the graph are derived from the current
// note bodies the same way `commands/knowledge_links.rs` does it.
//
// Cloned repos (the Knowledge sidebar's other section) are a separate
// surface shared with the GitHub panel — see `fixtures/integrations.ts`.
//
// `knowledgeHandlers` is spread into `baseHandlers` (`scenarios/base.ts`), so
// every scenario opens onto this same populated base. `scenarios/knowledge.ts`
// only adds what is genuinely scenario-specific on top of it: opening the
// Knowledge tab on mount, and the console triggers that simulate work
// happening outside the panel.

import { emit } from "@tauri-apps/api/event";
import type { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { MentionData, MentionKnowledge } from "@/features/chat/lib/mentions";
import type { GraphLayout } from "@/features/knowledge/components/knowledge-graph";
import type {
  GraphEdge,
  GraphNode,
  ProjectGraph,
} from "@/features/knowledge/stores/knowledge-graph-store";
import type { Backlink, LinkCounts } from "@/features/knowledge/stores/knowledge-links-store";
import type {
  MetaFile,
  PageMetaPatch,
  RustPageMeta,
} from "@/features/knowledge/stores/knowledge-meta-store";
import type { KnowledgeServerExport } from "@/features/knowledge/lib/knowledge-api";
import type { KnowledgeEntry } from "@/features/knowledge/stores/knowledge-store";
import type { TypedHandlers, Unread } from "../types";
import { MOCK_PROJECT } from "../project";

const F = "```";

/** An inline mention chip, as the Tiptap editor renders and re-parses it. */
const chip = (id: string, label: string) =>
  `<span data-type="mention" class="atlas-mention-chip" data-mention-kind="note" data-id="${id}">@${label}</span>`;

/** Minutes before the fixed "now" of the scenario, as Rust's RFC 3339. */
export const ago = (minutes: number) =>
  new Date(Date.UTC(2026, 8, 17, 10, 0) - minutes * 60_000)
    .toISOString()
    .replace(".000Z", "+00:00");

export interface SeedNote {
  id: string;
  content: string;
  /** Minutes ago the file was last written; the newest note opens first. */
  age: number;
}

const onboardingSections = [
  ["Accounts you need", "GitHub (acme org), Linear, 1Password, Sentry, and the staging VPN."],
  ["Your first day", "Pair with your onboarding buddy and ship a one-line change end to end."],
  [
    "Repository layout",
    "`apps/web` is the Next.js front end, `apps/api` the Hono API, `packages/*` shared code.",
  ],
  ["Branching", "Feature branches off `main`, squash-merged. Keep PRs under 400 lines."],
  ["Code review", "Two approvals for anything touching auth or billing, one otherwise."],
  ["Testing", "Vitest for units, Playwright for flows. `bun run test` must pass before review."],
  ["Environments", "`dev` (local), `staging` (every merge), `prod` (tagged releases)."],
  ["Feature flags", "Flags live in `packages/flags`. Default everything new to off in prod."],
  [
    "Observability",
    "Traces in Honeycomb, errors in Sentry, logs in Axiom. Link all three in incidents.",
  ],
  ["On-call", "Weekly rotation starting in your second month. Shadow one week first."],
  ["Incidents", "Declare early. The incident channel is `#inc-<date>-<slug>`."],
  ["Releases", "Tuesday and Thursday release trains, cut at 14:00 UTC."],
  ["Design system", "Components come from `packages/ui`. Don't restyle them locally."],
  ["Accessibility", "Every interactive element is keyboard-reachable and labelled."],
  ["Security", "Never paste customer data into tickets. Use the redaction helper in logs."],
  ["Getting help", "Ask in `#eng-help`; nobody minds. Search the knowledge base first."],
];

const onboarding = [
  "# Onboarding handbook",
  "",
  "Everything a new engineer on acme-app needs in their first month. Start with [[welcome]] and set up your machine with [[guides/setting-up-local-dev]].",
  "",
  ...onboardingSections.flatMap(([heading, body], i) => [
    `## ${i + 1}. ${heading}`,
    "",
    body,
    "",
    i % 4 === 0
      ? "- Read the relevant section of [[architecture/overview]] before touching this area."
      : "- Check the architecture overview before touching this area.",
    "- Ask your buddy if anything here is out of date, then fix this page.",
    "",
    `Lorem ipsum stands in for the long-form detail a real handbook would carry here: the history of why step ${i + 1} exists, the two or three mistakes people usually make, and who to ask when it goes wrong. It is deliberately long so the page scrolls well past one screen and the outline has plenty of headings to track.`,
    "",
  ]),
].join("\n");

export const SEED_NOTES: SeedNote[] = [
  {
    id: "welcome",
    age: 4,
    content: `# Welcome to acme-app

This is the team knowledge base. Notes live in \`.atlas/knowledge/\` and travel with the repo.

## Start here

- [[guides/onboarding]] — the first-month handbook
- [[architecture/overview]] — how the pieces fit together
- [[guides/debugging-guide]] — when something is on fire
- [[roadmap-q4]] — what we're building next

## Conventions

1. One topic per page. Link generously with double-bracket wikilinks.
2. Decisions go in \`decisions/\` as numbered ADRs.
3. Mark stale pages **Archived** instead of deleting them.

> The best documentation is the page you update while the context is still in your head.
`,
  },
  {
    id: "roadmap-q4",
    age: 180,
    content: `# Q4 roadmap

| Theme | Owner | Target | Status |
| --- | --- | --- | --- |
| Passkey sign-in | Priya | Oct 15 | In progress |
| Edge caching for the catalog | Marco | Nov 1 | Planned |
| Usage-based billing | Dana | Dec 1 | Discovery |
| Postgres 17 upgrade | Sam | Nov 20 | Planned |

## This sprint

- [x] Ship the passkey enrollment screen
- [x] Load-test the session service
- [ ] Write the rollout plan for passkeys (see [[architecture/auth-flow]])
- [ ] Spike the cache invalidation story from [[decisions/adr-002-edge-caching]]
- [ ] Book the Postgres upgrade window

## Risks

- The billing provider's sandbox is flaky; budget extra time.
- Edge caching depends on the catalog API being idempotent. It mostly is.
`,
  },
  {
    id: "architecture/overview",
    age: 45,
    content: `# Architecture overview

acme-app is a Next.js front end talking to a Hono API, backed by Postgres and a Redis cache.

${F}text
browser ──► web (Next.js, Vercel) ──► api (Hono, Fly.io) ──► Postgres 16
                                            │
                                            └──► Redis (sessions, rate limits)
${F}

## Services

- **web** renders pages and holds no state of its own.
- **api** owns every write. See [[architecture/auth-flow]] for how requests are authenticated.
- **worker** drains the job queue (emails, exports, webhooks).

## Data

The schema is described in [[architecture/data-model]]. We chose Postgres over DynamoDB in [[decisions/adr-001-use-postgres]].

## Caching

Catalog reads are cached at the edge — see [[decisions/adr-002-edge-caching]]. Everything user-specific bypasses the cache.
`,
  },
  {
    id: "architecture/auth-flow",
    age: 95,
    content: `# Auth flow

Sessions are opaque tokens stored in Redis, keyed by a hash of the cookie value. The user and org rows come from ${chip("architecture/data-model", "Data model")}.

## Sign-in

1. The browser posts credentials (or a passkey assertion) to \`/auth/session\`.
2. The API verifies them and writes a session row with a 30-day sliding expiry.
3. The response sets an \`HttpOnly\`, \`SameSite=Lax\` cookie.

${F}ts
export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomUUID();
  await redis.set(\`session:\${sha256(token)}\`, userId, { ex: 60 * 60 * 24 * 30 });
  return token;
}
${F}

## Passkeys

> Passkeys replace passwords for new accounts from October. Existing accounts get an upgrade prompt after sign-in.

- [x] WebAuthn registration endpoint
- [ ] Recovery codes UI
- [ ] Rollout plan — tracked on @note:roadmap-q4

If sign-in loops, start with [[guides/debugging-guide]].
`,
  },
  {
    id: "architecture/data-model",
    age: 300,
    content: `# Data model

Core tables. Every table has \`id uuid\`, \`created_at\` and \`updated_at\`.

| Table | Purpose | Notable columns |
| --- | --- | --- |
| \`orgs\` | A paying customer | \`plan\`, \`billing_email\` |
| \`users\` | A person | \`email\`, \`org_id\` |
| \`projects\` | A project inside an org | \`org_id\`, \`archived_at\` |
| \`api_keys\` | Machine access | \`hashed_key\`, \`last_used_at\` |

${F}sql
create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email citext not null unique,
  created_at timestamptz not null default now()
);
${F}

Why Postgres: [[decisions/adr-001-use-postgres]]. Sessions are not here — see [[architecture/auth-flow]].
`,
  },
  {
    id: "guides/debugging-guide",
    age: 20,
    content: `# Debugging guide

Where to look, in order, when something is wrong in production.

<aside class="atlas-callout" data-emoji="🚨">

If customers are affected, declare an incident **before** you start debugging. See the incident section of [[guides/onboarding]].

</aside>

## 1. Is it deployed?

${F}bash
fly releases --app acme-api | head -5
vercel ls acme-web --limit 5
${F}

## 2. What do the traces say?

Filter Honeycomb by \`service.name = api\` and \`status_code >= 500\`, grouped by \`http.route\`.

## 3. Common failures

<details>
<summary>Sign-in redirects in a loop</summary>

The session cookie is being dropped. Check the \`SameSite\` attribute and the domain — details in [[architecture/auth-flow]].

</details>

<details>
<summary>Catalog shows stale prices</summary>

The edge cache wasn't purged. Run the purge job, then read [[decisions/adr-002-edge-caching]].

</details>

## 4. Reproduce locally

Follow [[guides/setting-up-local-dev]], then replay the request:

${F}bash
curl -sS localhost:8787/api/projects -H "authorization: Bearer $ACME_TOKEN" | jq '.[0]'
${F}

Old notes from the Sept 12 outage are in [[meeting-notes/2026-09-12-outage]].
`,
  },
  {
    id: "guides/onboarding",
    age: 600,
    content: onboarding,
  },
  {
    id: "guides/setting-up-local-dev",
    age: 1440,
    content: `# Local setup

${F}bash
brew install bun postgresql@16 redis
git clone git@github.com:acme/acme-app.git && cd acme-app
bun install
docker compose up -d
bun run db:migrate && bun run db:seed
bun run dev
${F}

- [x] Works on Apple Silicon
- [ ] Works on Linux without Docker Desktop

The seeded data matches the tables in [[architecture/data-model]].
`,
  },
  {
    id: "decisions/adr-001-use-postgres",
    age: 4320,
    content: `# ADR 001: Use Postgres as the primary store

**Status:** Accepted · **Date:** 2025-03-02

## Context

We need relational integrity for orgs, users and billing, and the team knows SQL.

## Decision

Use managed Postgres. Model tenancy with an \`org_id\` column on every table (see [[architecture/data-model]]).

## Consequences

- Row-level security is available if we need it.
- Read scaling needs replicas; revisit when p95 reads pass 50 ms.
`,
  },
  {
    id: "decisions/adr-002-edge-caching",
    age: 2880,
    content: `# ADR 002: Cache catalog reads at the edge

**Status:** Proposed · **Date:** 2026-08-28

## Context

Catalog pages are 70% of traffic and change a few times a day. The origin is in one region ([[architecture/overview]]).

## Decision

Cache \`GET /catalog/*\` for 5 minutes at the edge with surrogate keys, purged on write. Builds on [[decisions/adr-001-use-postgres]] — the purge is triggered from a Postgres \`NOTIFY\`.

## Open questions

- [ ] How do we purge per-org price overrides?
- [ ] Do we need stale-while-revalidate?
`,
  },
];

/** Folders that exist on disk but hold no notes. `list_knowledge` never lists
 *  a directory, only `.md` files, so these do not appear in the tree. */
export const SEED_EMPTY_DIRS = ["archive"];

/** `.atlas/knowledge/_meta.json`. Notes without an entry fall back to their
 *  filename, which is what Rust sends as the wire title. */
export const SEED_META: Record<string, RustPageMeta> = {
  welcome: {
    icon: "👋",
    title: "Welcome to acme-app",
    cover: "covers/welcome.png",
    status: "Published",
    tags: ["start-here"],
    owner: "priya",
    created_at: ago(60 * 24 * 90),
    updated_at: ago(4),
  },
  "architecture/overview": {
    icon: "🏗️",
    title: "Architecture overview",
    cover: "gradient:dusk-1",
    status: "Published",
    tags: ["architecture", "infra"],
    owner: "marco",
    created_at: ago(60 * 24 * 60),
    updated_at: ago(45),
  },
  "architecture/auth-flow": {
    icon: "🔐",
    title: "Auth flow",
    status: "RFC",
    tags: ["auth", "security", "passkeys"],
    owner: "priya",
    created_at: ago(60 * 24 * 30),
    updated_at: ago(95),
  },
  "architecture/data-model": {
    icon: "🗄️",
    title: "Data model",
    tags: ["database"],
    created_at: ago(60 * 24 * 45),
    updated_at: ago(300),
  },
  "guides/debugging-guide": {
    icon: "🐛",
    title: "Debugging guide",
    status: "Draft",
    tags: ["ops", "on-call"],
    owner: "sam",
    created_at: ago(60 * 24 * 7),
    updated_at: ago(20),
  },
  "guides/onboarding": {
    icon: "🧭",
    title: "Onboarding handbook",
    status: "Published",
    tags: ["people"],
    owner: "dana",
    created_at: ago(60 * 24 * 120),
    updated_at: ago(600),
  },
  "guides/setting-up-local-dev": {
    icon: "💻",
    title:
      "Setting up a reproducible local development environment on Apple Silicon with Docker, Postgres and seeded fixtures",
    tags: ["setup"],
    created_at: ago(60 * 24 * 20),
    updated_at: ago(1440),
  },
  "decisions/adr-001-use-postgres": {
    icon: "📜",
    title: "ADR 001: Use Postgres",
    status: "Archived",
    tags: ["adr", "database"],
    owner: "marco",
    created_at: ago(60 * 24 * 200),
    updated_at: ago(4320),
  },
  "decisions/adr-002-edge-caching": {
    title: "ADR 002: Edge caching",
    status: "RFC",
    tags: ["adr", "performance"],
    owner: "marco",
    created_at: ago(60 * 24 * 21),
    updated_at: ago(2880),
  },
};

/** A stand-in cover image: an SVG landscape whose hue comes from the ref, so
 *  different covers look different. Rust would return the real file's bytes. */
export function coverSvgDataUrl(ref: string): string {
  let hash = 0;
  for (const ch of ref) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const h = hash % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="hsl(${h} 55% 72%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 60% 88%)"/>
</linearGradient></defs>
<rect width="1200" height="360" fill="url(#s)"/>
<circle cx="930" cy="110" r="46" fill="hsl(${(h + 30) % 360} 90% 96%)"/>
<path d="M0 260 L180 150 L330 230 L520 110 L700 240 L880 160 L1200 270 L1200 360 L0 360Z" fill="hsl(${h} 30% 42%)"/>
<path d="M0 300 L220 220 L420 290 L640 200 L860 290 L1040 230 L1200 300 L1200 360 L0 360Z" fill="hsl(${h} 30% 28%)"/>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ── state ─────────────────────────────────────────────────────────────────

const PROJECT = MOCK_PROJECT.path;
const KB_DIR = `${PROJECT}/.atlas/knowledge`;

interface Note {
  content: string;
  updatedAt: string;
}

let notes = new Map<string, Note>();
let dirs = new Set<string>();
let meta: Record<string, RustPageMeta> = {};
let layout: GraphLayout = { positions: {} };

/** Restore the seed data. Called once at module load so every scenario opens
 *  on the populated base, and again by the `knowledge` scenario's `reset`
 *  console action. */
export function resetKnowledgeStore(): void {
  notes = new Map(SEED_NOTES.map((n) => [n.id, { content: n.content, updatedAt: ago(n.age) }]));
  dirs = new Set(SEED_EMPTY_DIRS);
  meta = structuredClone(SEED_META);
  layout = { positions: {} };
}
resetKnowledgeStore();

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** Rust sends the filename stem as the title; `_meta.json` titles win client-side. */
const stem = (id: string) => id.split("/").pop() ?? id;

/** Same path rule as Rust's `kb_rel`: relative, no `..`, no backslashes. */
function kbRel(fragment: unknown): string {
  const f = String(fragment ?? "");
  if (
    !f ||
    f.includes("\\") ||
    f.startsWith("/") ||
    f.split("/").some((p) => !p || p === "." || p === "..")
  ) {
    throw new Error("invalid knowledge path");
  }
  return f;
}

/** Every note, newest first — the same shape `list_knowledge` answers with.
 *  Exported so the `knowledge` scenario's console actions can read current
 *  content without reaching into this module's private state. */
export function listKnowledgeEntries(): KnowledgeEntry[] {
  return [...notes]
    .map(([id, n]) => ({
      id,
      title: stem(id),
      content: n.content,
      source: stem(id).startsWith("paper-")
        ? "paper"
        : stem(id).startsWith("chat-")
          ? "chat"
          : "note",
      file_path: `${KB_DIR}/${id}.md`,
      updated_at: n.updatedAt,
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

// ── events ────────────────────────────────────────────────────────────────

const linksChanged = () => emit("atlas:knowledge:links-changed", { projectPath: PROJECT });

// Rust debounces meta writes by 300 ms and emits once the file is on disk.
let metaTimer: ReturnType<typeof setTimeout> | null = null;
/** Exported so the `knowledge` scenario's `reset` action can announce a
 *  wholesale meta replacement the same way a single patch does. */
export function scheduleKnowledgeMetaChanged(): void {
  if (metaTimer) clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    metaTimer = null;
    void emit("atlas:knowledge:meta-changed", { projectPath: PROJECT });
  }, 300);
}

/** Re-read the note list the way the panel does after a write it made itself
 *  (a console action, rather than a save that went through the store). */
export async function reloadKnowledgeEntries(): Promise<void> {
  const { useKnowledgeStore } = await import("@/features/knowledge/stores/knowledge-store");
  await useKnowledgeStore.getState().actions.loadEntries(PROJECT);
}

// ── links (port of knowledge_links.rs) ──────────────────────────────────────

interface RefHit {
  target: string;
  start: number;
  end: number;
}

function findRefs(body: string): RefHit[] {
  const out: RefHit[] = [];
  // [[wikilinks]]
  for (let i = 0; i + 1 < body.length;) {
    if (body.startsWith("[[", i)) {
      const close = body.indexOf("]]", i + 2);
      if (close !== -1) {
        const inner = body.slice(i + 2, close);
        if (inner && !inner.includes("\n") && inner.length < 200) {
          out.push({ target: inner, start: i, end: close + 2 });
        }
        i = close + 2;
        continue;
      }
    }
    i++;
  }
  // @knowledge:id / @note:id / @page:id
  for (const m of body.matchAll(/@(?:knowledge|note|page):([^\s,;)\]}"'`]+)/g)) {
    out.push({ target: m[1], start: m.index, end: m.index + m[0].length });
  }
  // HTML mention chips: data-mention-kind first, data-id within 400 chars after.
  for (const m of body.matchAll(/data-mention-kind=(["'])(.*?)\1/g)) {
    if (!["knowledge", "note", "page"].includes(m[2])) continue;
    const window = body.slice(m.index, m.index + 400);
    const id = /data-id=(["'])(.*?)\1/.exec(window)?.[2];
    if (id) out.push({ target: id, start: m.index, end: m.index + 1 });
  }
  return out;
}

const SNIPPET_RADIUS = 90;

function snippet(body: string, start: number, end: number): string {
  const lo = Math.max(0, start - SNIPPET_RADIUS);
  const hi = Math.min(body.length, end + SNIPPET_RADIUS);
  const flat = (s: string) => s.replaceAll("\n", " ");
  const text = `${flat(body.slice(lo, start))}{{ ${flat(body.slice(start, end))} }}${flat(body.slice(end, hi))}`;
  return `${lo > 0 ? "…" : ""}${text.trim()}${hi < body.length ? "…" : ""}`;
}

interface LinkGraph {
  backlinks: Map<string, Backlink[]>;
  forward: Map<string, string[]>;
}

function buildGraph(): LinkGraph {
  const backlinks = new Map<string, Backlink[]>();
  const forward = new Map<string, string[]>();
  for (const [from, { content }] of notes) {
    const targets: string[] = [];
    for (const hit of findRefs(content)) {
      if (hit.target === from) continue;
      const list = backlinks.get(hit.target) ?? [];
      list.push({
        fromEntryId: from,
        fromTitle: stem(from),
        snippet: snippet(content, hit.start, hit.end),
      });
      backlinks.set(hit.target, list);
      if (!targets.includes(hit.target)) targets.push(hit.target);
    }
    forward.set(from, targets);
  }
  return { backlinks, forward };
}

function projectGraph(): ProjectGraph {
  const g = buildGraph();
  // Referenced-but-missing ids become nodes too, titled by their id.
  const titles = new Map<string, string>([...notes.keys()].map((id) => [id, stem(id)]));
  for (const id of [...g.backlinks.keys(), ...g.forward.keys()]) {
    if (!titles.has(id)) titles.set(id, id);
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const [from, targets] of g.forward) {
    for (const to of targets) {
      const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }
  const nodes: GraphNode[] = [...titles]
    .map(([id, title]) => ({
      id,
      title,
      inDegree: g.backlinks.get(id)?.length ?? 0,
      outDegree: g.forward.get(id)?.length ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}

// ── handlers ─────────────────────────────────────────────────────────────

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface KnowledgeResponses {
  list_knowledge: KnowledgeEntry[];
  save_knowledge_note: Unread;
  delete_knowledge_note: Unread;
  create_knowledge_dir: Unread;
  // An inline `invoke<{…}>` type argument in `knowledge-api.ts` with no named
  // type to import, so it is restated — and, unlike the rest, does NOT catch drift.
  import_into_knowledge: { notes_imported: number; files_copied: number };
  knowledge_meta_load: MetaFile;
  knowledge_meta_patch: Unread;
  knowledge_meta_delete: Unread;
  knowledge_backlinks: Backlink[];
  knowledge_link_counts: LinkCounts;
  knowledge_links_graph: ProjectGraph;
  knowledge_links_invalidate: Unread;
  knowledge_graph_layout_load: GraphLayout;
  knowledge_graph_layout_save: Unread;
  knowledge_cover_data_url: string;
  knowledge_cover_upload: string;
  // `open()` from `@tauri-apps/plugin-dialog`, which calls this command.
  "plugin:dialog|open": Awaited<ReturnType<typeof openDialog>>;
  mention_search: MentionData[];
  knowledge_export_server: KnowledgeServerExport;
}

export const knowledgeHandlers: TypedHandlers<KnowledgeResponses> = {
  // ── notes ──
  list_knowledge: (): KnowledgeEntry[] => listKnowledgeEntries(),
  save_knowledge_note: ({ id, content }): string => {
    const rel = kbRel(id);
    notes.set(rel, { content: String(content), updatedAt: now() });
    return `${KB_DIR}/${rel}.md`;
  },
  delete_knowledge_note: ({ id }) => {
    notes.delete(kbRel(id));
    return null;
  },
  create_knowledge_dir: ({ dirName }) => {
    dirs.add(kbRel(dirName));
    return null;
  },
  import_into_knowledge: ({ sources }): KnowledgeResponses["import_into_knowledge"] => {
    let imported = 0;
    for (const src of sources as string[]) {
      const name = src
        .split("/")
        .pop()
        ?.replace(/\.(md|markdown)$/i, "");
      if (!name) continue;
      notes.set(name, { content: `# ${name}\n\nImported from \`${src}\`.\n`, updatedAt: now() });
      imported += 1;
    }
    return { notes_imported: imported, files_copied: 0 };
  },

  // ── metadata ──
  knowledge_meta_load: (): MetaFile => ({ version: 1, pages: structuredClone(meta) }),
  knowledge_meta_patch: ({ entryId, patch }): RustPageMeta => {
    const p = patch as PageMetaPatch;
    const page: RustPageMeta = (meta[entryId] ??= {});
    page.created_at ??= now();
    for (const key of ["icon", "cover", "title", "status", "tags", "owner"] as const) {
      if (p[key] !== undefined) Object.assign(page, { [key]: p[key] });
    }
    page.updated_at = now();
    scheduleKnowledgeMetaChanged();
    return structuredClone(page);
  },
  knowledge_meta_delete: ({ entryId }) => {
    delete meta[entryId];
    scheduleKnowledgeMetaChanged();
    return null;
  },

  // ── links + graph ──
  knowledge_backlinks: ({ entryId }): Backlink[] => buildGraph().backlinks.get(entryId) ?? [],
  knowledge_link_counts: ({ entryId }): LinkCounts => {
    const g = buildGraph();
    return {
      backlinks: g.backlinks.get(entryId)?.length ?? 0,
      forwardlinks: g.forward.get(entryId)?.length ?? 0,
    };
  },
  knowledge_links_graph: (): ProjectGraph => projectGraph(),
  knowledge_links_invalidate: async () => {
    await linksChanged();
    return null;
  },
  knowledge_graph_layout_load: (): GraphLayout => structuredClone(layout),
  knowledge_graph_layout_save: ({ layout: next }) => {
    layout = next as GraphLayout;
    return null;
  },

  // ── covers ──
  // Rust hands gradient refs back untouched; everything else is a real file.
  knowledge_cover_data_url: ({ cover }): string => {
    if (String(cover).startsWith("gradient:")) return cover;
    return coverSvgDataUrl(kbRel(cover));
  },
  knowledge_cover_upload: ({ entryId, srcPath }): string => {
    const ext = String(srcPath).split(".").pop()?.toLowerCase() ?? "jpg";
    return `covers/${String(entryId).replaceAll("/", "__")}.${ext}`;
  },
  // The browser has no native file picker; the cover-upload button asks for
  // one, so answer as if a PNG had been chosen and cancel every other picker.
  "plugin:dialog|open": ({ options }) => {
    const images = (options?.filters ?? []).some((f: { extensions: string[] }) =>
      f.extensions.includes("png"),
    );
    return images ? "/Users/dev/Pictures/cover.png" : null;
  },

  // ── editor `@` / `~` picker: knowledge results ──
  mention_search: ({ query, scope }): MentionData[] => {
    if (scope !== null && scope !== "knowledge") return [];
    const q = String(query ?? "").toLowerCase();
    return listKnowledgeEntries()
      .map((e): MentionKnowledge => {
        const slash = e.id.lastIndexOf("/");
        return {
          kind: "knowledge",
          id: e.id,
          displayName: meta[e.id]?.title?.trim() || e.title,
          icon: meta[e.id]?.icon ?? null,
          filePath: e.file_path,
          source: e.source,
          folder: slash > 0 ? e.id.slice(0, slash) : null,
        };
      })
      .filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.id.includes(q))
      .slice(0, 20);
  },

  // Cloned repos (`list_cloned_repos` / `read_repo_readme` / `delete_cloned_repo`)
  // are the same surface the GitHub panel uses and are already answered for
  // every scenario by `integrationsHandlers` (`fixtures/integrations.ts`,
  // seeded with three repos for exactly this reason) — not duplicated here.

  // ── export ──
  knowledge_export_server: (): KnowledgeResponses["knowledge_export_server"] => ({
    binaryPath: "/Users/dev/Downloads/atlas-kb-server",
    noteCount: notes.size,
  }),
};
