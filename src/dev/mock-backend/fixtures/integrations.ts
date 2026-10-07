// The four surfaces that talk to something outside Atlas: the Atlas account
// (organisations, members, invitations), GitHub, the feedback panel with its
// native screenshot, and PDF annotations.
//
// They are one file because they share one fact — none of them can be reached
// from a browser, so every one of them is invisible until it is faked here.
//
// The account fakes start **signed in**. Signed out, the org switcher shows a
// "Connect" button and the members/invitations screens are unreachable, so a
// signed-out base would leave three quarters of `src/features/organisations/`
// with no way in. Sign-out still works (and sign-in back in, through a real
// `connecting` phase), so the signed-out half is a click away rather than the
// only thing on offer.
//
// Mutations here are real: inviting, removing, renaming the active org,
// cloning a repo, dropping a PDF highlight — all of them change what the next
// read returns, for the life of the page.

import { emit } from "@tauri-apps/api/event";
import type {
  AccountOrg,
  AuthSnapshot,
  CreatedOrg,
  OrgInvitation,
  OrgMember,
  Role,
} from "@/features/auth/lib/auth-api";
import type {
  CaptureResult,
  FeedbackPayload,
  FeedbackReceipt,
} from "@/features/feedback/lib/feedback-api";
import type { ClonedRepo, GithubRepo, RepoMeta } from "@/features/github/types";
import type { PdfAnnotation } from "@/features/pdf/stores/pdf-annotation-store";
import type { TypedHandlers, Unit, Unread } from "../types";
import { abs, MOCK_ORG_ID } from "../project";

/**
 * Fail a command the way Rust fails it.
 *
 * Every command in this file returns `Result<_, String>`, so `invoke` rejects
 * with a **bare string** — and the callers branch on exactly that
 * (`typeof e === "string" ? e : "Couldn't …"`). Rejecting with an `Error`
 * instead silently swaps every message below for the caller's generic
 * fallback, which is the opposite of what a fixture chosen for its wording is
 * for. Elsewhere in the mock backend `throw new Error(…)` is fine: nothing
 * reads those messages.
 */
function fail(message: string): never {
  // oxlint-disable-next-line no-throw-literal -- Rust's `Err(String)`, not an Error.
  throw message;
}

/** Fixed "now", so every relative date below reads the same on every reload. */
const NOW = Date.parse("2026-09-18T11:30:00Z");
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

// ── Auth: identity ──────────────────────────────────────────────────────────

/**
 * A second organisation, so the switcher has something to switch *to* and the
 * non-admin path has somewhere to live: the account is a plain `member` here,
 * which is what makes `auth_list_invitations` reject below.
 *
 * It reaches the local switcher through `mergeServerOrgs`, which appends any
 * server org it cannot adopt — see the note on `ACME` for the adoption half.
 */
const SECOND_ORG_ID = "org-northwind";

/**
 * The account's view of the project's own org.
 *
 * `id` matches `project.ts`'s `organisations[0].remoteId` and the name
 * matches its `name`, **on purpose and in that order of importance**:
 * `members-modal` keys its entire roster off `org.remoteId`, so an id that
 * disagrees opens the modal onto an empty table that looks like a UI bug. The
 * name is what `org-store.mergeServerOrgs` reconciles onto the linked row —
 * and what its adoption path would match on, if that entry ever loses its
 * `remoteId` again.
 */
const ACME: AccountOrg = { id: MOCK_ORG_ID, name: "Acme", role: "admin" };
const NORTHWIND: AccountOrg = { id: SECOND_ORG_ID, name: "Northwind Labs", role: "member" };

/** The signed-in account. The avatar points at a real seeded PNG in the fake
 *  tree, so `convertFileSrc` resolves it to an image instead of a broken one —
 *  the initials fallback is exercised by the members below, which have none. */
const SIGNED_IN: AuthSnapshot = {
  status: "signed-in",
  user: {
    id: "usr_dev",
    name: "Dev Halvorsen",
    email: "dev@acme.dev",
    avatarPath: abs("public/logo.png"),
  },
  orgs: [ACME, NORTHWIND],
  activeOrgId: MOCK_ORG_ID,
  commsOrgId: MOCK_ORG_ID,
};

let snapshot: AuthSnapshot = structuredClone(SIGNED_IN);

/** The pending `auth_sign_in` grant, so cancelling actually cancels it. */
let grantTimer: number | null = null;

/** Every auth transition Rust makes is broadcast to every window; App.tsx
 *  folds the org list into the switcher from this event and nothing else, so a
 *  mutation that forgets to emit changes Rust's mind and not the screen. */
function broadcast(): null {
  void emit("atlas:auth-changed", snapshot);
  return null;
}

/** The orgs of whatever state we are currently in — `[]` for signed-out, which
 *  is also what stops the org commands below from mutating a dead snapshot. */
const currentOrgs = (): AccountOrg[] =>
  snapshot.status === "signed-in" ? (snapshot.orgs ?? []) : [];

// ── Auth: members and invitations ───────────────────────────────────────────

const member = (
  id: string,
  name: string,
  email: string,
  role: Role | null,
  extra: Partial<OrgMember> = {},
): OrgMember => ({
  id,
  userId: `usr-${id.slice(4)}`,
  name,
  email,
  role,
  createdAt: iso(-200),
  avatarPath: null,
  isOwner: false,
  ...extra,
});

/**
 * Acme's roster, chosen for the rows that are easy to break rather than for
 * plausibility, and shared with team chat: every author name in `comms.ts`
 * resolves through this list (`members-store` reads `auth_list_members`), so
 * the `userId`s here are the comms message authors and a spelling change on
 * either side turns a message's byline into "Unknown".
 * the signed-in user themself (the row whose destructive
 * controls are suppressed), a name far past any column width, a member the
 * server never gave a display name, and one whose role this build does not
 * know — `null`, which must render as no label rather than as "Member".
 */
const ACME_MEMBERS: OrgMember[] = [
  member("mem-dev", "Dev Halvorsen", "dev@acme.dev", "admin", {
    // Same id as the signed-in user, which is what `isSelf` compares. Created
    // Acme, so they are its Owner: no Leave, and no Remove for anyone else.
    userId: "usr_dev",
    avatarPath: abs("public/logo.png"),
    createdAt: iso(-412),
    isOwner: true,
  }),
  member("mem-priya", "Priya Raghunathan", "priya@acme.dev", "product_owner", {
    userId: "usr_priya",
    createdAt: iso(-311),
  }),
  member(
    "mem-max",
    "Maximilian Alexander Featherstonehaugh-Wetherby III",
    "maximilian.featherstonehaugh-wetherby@acme-industries-worldwide.example",
    "developer",
    // A roster row only: nobody by this id writes in the fixtures, so the
    // truncation stress stays on the members screen and out of every byline.
    { userId: "usr_max" },
  ),
  member("mem-mira", "Mirabel Fitzgerald-Okonkwo", "mirabel.fitzgerald@acme.dev", "developer", {
    userId: "usr_mira",
    createdAt: iso(-140),
  }),
  // The server has an account but no display name for it — a real state for an
  // invite accepted from an email link and never completed.
  member("mem-blank", "", "j.okonkwo@acme.dev", "developer", { createdAt: null }),
  member("mem-sam", "Sam Oyelaran", "sam@acme.dev", "member", {
    userId: "usr_sam",
    createdAt: iso(-19),
  }),
  member("mem-tobi", "Tobi Adeyemi", "tobi@acme.dev", "member", {
    userId: "usr_tobi",
    createdAt: iso(-64),
  }),
  // A role added server-side after this build shipped: the org is real, the
  // label is not knowable, and guessing at someone's permissions is worse.
  member("mem-unknown", "Wren Castellanos", "wren@acme.dev", null, { createdAt: iso(-3) }),
];

/** Northwind's roster is short on purpose: it is the org the account is only a
 *  `member` of, so the table renders with every admin control gone. */
const NORTHWIND_MEMBERS: OrgMember[] = [
  member("mem-nw-lead", "Ingrid Solberg", "ingrid@northwind.example", "admin", {
    createdAt: iso(-520),
    isOwner: true,
  }),
  member("mem-nw-dev", "Dev Halvorsen", "dev@acme.dev", "member", {
    userId: "usr_dev",
    avatarPath: abs("public/logo.png"),
  }),
];

/**
 * Rosters by SERVER org id.
 *
 * Anything else gets a fresh copy of Acme's rather than an empty table: the id
 * the modal asks for is the local org's `remoteId`, and a scenario that seeds
 * its own orgs would otherwise open the members screen onto nothing and look
 * like a UI bug.
 */
const membersByOrg = new Map<string, OrgMember[]>([
  [MOCK_ORG_ID, ACME_MEMBERS.map((m) => ({ ...m }))],
  [SECOND_ORG_ID, NORTHWIND_MEMBERS.map((m) => ({ ...m }))],
]);

function roster(orgId: string): OrgMember[] {
  let list = membersByOrg.get(orgId);
  if (!list) {
    list = ACME_MEMBERS.map((m) => ({ ...m }));
    membersByOrg.set(orgId, list);
  }
  return list;
}

/**
 * `status` is an opaque server string the modal prints verbatim, so the three
 * spellings that actually reach it are seeded: one live invite, one whose
 * expiry has passed, and one that was revoked. `acceptUrl` is `null` on all of
 * them — listing invitations does not re-issue a link, and only the response to
 * `auth_invite_member` carries one.
 */
const ACME_INVITES: OrgInvitation[] = [
  {
    id: "inv-live",
    email: "nora.vasquez@acme.dev",
    role: "developer",
    status: "pending",
    expiresAt: iso(5),
    acceptUrl: null,
  },
  {
    id: "inv-expired",
    email: "someone.who.never.clicked.the.link@a-very-long-corporate-domain.example",
    role: "member",
    status: "expired",
    expiresAt: iso(-23),
    acceptUrl: null,
  },
  {
    id: "inv-revoked",
    // No role survived the revocation server-side; the row renders unlabelled.
    email: "contractor@partner.example",
    role: null,
    status: "canceled",
    expiresAt: null,
    acceptUrl: null,
  },
];

const invitesByOrg = new Map<string, OrgInvitation[]>([
  [MOCK_ORG_ID, ACME_INVITES.map((i) => ({ ...i }))],
]);

function invites(orgId: string): OrgInvitation[] {
  let list = invitesByOrg.get(orgId);
  if (!list) {
    list = [];
    invitesByOrg.set(orgId, list);
  }
  return list;
}

/** Handles the server already owns. `acme` is the project's own org, so the
 *  create dialog's "taken" state is one keystroke away; anything not listed
 *  comes back free. */
const TAKEN_SLUGS = new Set(["acme", "northwind-labs", "atlas", "support"]);

let invitesMinted = 0;

// ── GitHub ──────────────────────────────────────────────────────────────────

const repoMeta = (
  description: string,
  language: string,
  stars: number,
  forks: number,
  fullName: string,
  updatedAt: string,
): RepoMeta => ({
  description,
  language,
  stars,
  forks,
  html_url: `https://github.com/${fullName}`,
  updated_at: updatedAt,
});

const searchRow = (fullName: string, meta: RepoMeta): GithubRepo => ({
  name: fullName.split("/")[1],
  full_name: fullName,
  description: meta.description,
  html_url: meta.html_url,
  clone_url: `https://github.com/${fullName}.git`,
  language: meta.language,
  stars: meta.stars,
  forks: meta.forks,
  updated_at: meta.updated_at,
});

/**
 * What GitHub search can hand back. Note that Rust `unwrap_or("")`s every
 * string field, so a repo with no description or no detected language arrives
 * as an **empty string**, never `null` — the rows below keep that exact shape.
 *
 * `GithubRepo` carries no `archived` flag (the Rust mapper drops it), so an
 * archived repo is only ever visible as its own `[ARCHIVED]` description and a
 * years-stale `updated_at`, which is how it reads in the panel.
 */
const SEARCH_RESULTS: GithubRepo[] = [
  searchRow(
    "acme/design-tokens",
    repoMeta(
      "Design tokens for the Acme product suite — colours, type ramp, spacing.",
      "TypeScript",
      2_184,
      147,
      "acme/design-tokens",
      iso(-4),
    ),
  ),
  searchRow(
    "vercel/swr",
    repoMeta("React Hooks for Data Fetching", "TypeScript", 31_204, 1_288, "vercel/swr", iso(-11)),
  ),
  searchRow(
    "acme/legacy-billing",
    repoMeta(
      "[ARCHIVED] Superseded by acme/billing-v2. Kept for the migration scripts only.",
      "Ruby",
      86,
      12,
      "acme/legacy-billing",
      iso(-1_390),
    ),
  ),
  searchRow(
    "openobserve/telemetry-pipeline",
    repoMeta(
      "A horizontally scalable, vendor-neutral pipeline for collecting, buffering, enriching, redacting and forwarding OpenTelemetry traces, metrics and logs to any number of downstream sinks, with a declarative YAML configuration, a hot-reloadable rule engine, back-pressure aware batching, and first-class support for running as a sidecar, a DaemonSet or a standalone binary on constrained edge hardware.",
      "Rust",
      9_431,
      612,
      "openobserve/telemetry-pipeline",
      iso(-2),
    ),
  ),
  // No description and no detected language: both arrive as "", and the row
  // has to survive rendering nothing rather than "undefined".
  searchRow("acme/scratch", repoMeta("", "", 3, 0, "acme/scratch", iso(-201))),
  searchRow(
    "rust-lang/rust",
    repoMeta(
      "Empowering everyone to build reliable and efficient software.",
      "Rust",
      104_882,
      13_507,
      "rust-lang/rust",
      iso(-1),
    ),
  ),
];

const ACME_TOKENS_README = `# @acme/design-tokens

The single source of truth for Acme's colours, type ramp and spacing. Every
surface — web, iOS, the desktop app — reads from the same generated files.

## Install

\`\`\`bash
bun add @acme/design-tokens
\`\`\`

## Usage

\`\`\`ts
import { tokens } from "@acme/design-tokens";

document.documentElement.style.setProperty("--background", tokens.color.bg.base);
\`\`\`

## Layers

| Layer     | What it holds                         | Changes           |
| --------- | ------------------------------------- | ----------------- |
| primitive | Raw values (\`blue.500\`, \`space.4\`)    | Almost never      |
| semantic  | Roles (\`bg.base\`, \`text.secondary\`)   | Per theme         |
| component | Component overrides (\`button.bg\`)     | Per release       |

> Semantic tokens are the only layer product code may read. A component
> reaching past them into a primitive is a review comment, not a preference.

## Releasing

1. \`bun run build\` regenerates \`dist/\` for all four targets.
2. \`bun run check:contrast\` fails the build on any pair under 4.5:1.
3. Tag \`vX.Y.Z\`; CI publishes.
`;

const SWR_README = `# SWR

The name "SWR" is derived from \`stale-while-revalidate\`, a cache invalidation
strategy popularized by HTTP [RFC 5861](https://tools.ietf.org/html/rfc5861).

\`\`\`jsx
import useSWR from "swr";

function Profile() {
  const { data, error, isLoading } = useSWR("/api/user", fetcher);

  if (error) return <div>failed to load</div>;
  if (isLoading) return <div>loading…</div>;
  return <div>hello {data.name}!</div>;
}
\`\`\`

## Why

| Without SWR                  | With SWR                         |
| ---------------------------- | -------------------------------- |
| Manual loading/error state   | Returned from the hook           |
| Refetch on focus by hand     | Built in                         |
| Duplicate requests per page  | Deduplicated inside the interval |
`;

/** README text by on-disk directory name. A repo missing from here throws the
 *  same "No README found" Rust does — which is the state `acme-legacy-billing`
 *  is in, and what the knowledge panel's empty README pane is for. */
const READMES: Record<string, string> = {
  "acme-design-tokens": ACME_TOKENS_README,
  "vercel-swr": SWR_README,
};

const clonedRepo = (fullName: string, branch: string | null, meta: RepoMeta | null): ClonedRepo => {
  const name = fullName.replace("/", "-");
  return {
    name,
    display_name: fullName,
    path: abs(`.atlas/repos/${name}`),
    has_readme: name in READMES,
    branch,
    meta,
  };
};

/**
 * Already on disk under `<project>/.atlas/repos`.
 *
 * Three states that the panel handles differently: a healthy clone on a branch,
 * one with a **detached HEAD** (`branch: null` — its update button must refuse
 * rather than guess), and one cloned before Atlas cached any metadata
 * (`meta: null`), which the panel notices and back-fills through
 * `fetch_cloned_repo_meta` on its own, one row at a time.
 */
let clonedRepos: ClonedRepo[] = [
  clonedRepo(
    "acme/design-tokens",
    "main",
    repoMeta(
      "Design tokens for the Acme product suite — colours, type ramp, spacing.",
      "TypeScript",
      2_184,
      147,
      "acme/design-tokens",
      iso(-4),
    ),
  ),
  clonedRepo(
    "vercel/swr",
    null,
    repoMeta("React Hooks for Data Fetching", "TypeScript", 31_204, 1_288, "vercel/swr", iso(-11)),
  ),
  clonedRepo("acme/legacy-billing", "master", null),
];

const REMOTE_BRANCHES: Record<string, string[]> = {
  "acme-design-tokens": ["main", "next", "release/3.x", "renovate/bun-1.x"],
  "vercel-swr": ["main", "v1", "canary"],
};

// ── Feedback and the native screenshot ──────────────────────────────────────

/**
 * A real 240×150 PNG of a fake editor window.
 *
 * It has to decode: both callers build an `Image` from
 * `data:${mimeType};base64,${dataBase64}` and draw it to a canvas to downscale
 * it, so a placeholder string would reject and surface as "Screenshot failed".
 */
const SHOT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAACD0lEQVR42u3dsQ2CUBSGUUYgFkhlSGwtLRyAYYwjOIoFhQsw" +
  "gDs4g1vQMgAxJITk8S4n+RZ4L6e6zV8054sUpsIXCGgJaAloCWgBLQEtAS0BLQEtoCWgJaAloCWgBbQEtLQB0NdbK4UJaMUC" +
  "XdWnLCoPR2k2oAU00AIaaAENtIAW0EALaKAF9Nqgn+8hSegADbSABlpAAw000EAD7cohoIEW0EALaAENtIAGWkADLaCndd/H" +
  "HiIVaKCBBhpooIEGGmiggQZaAlpAAy2ggRbQQAtoCWgBnQXoX3/X6gENNNBAAw000EADDbSAduUQ0EALaKAFtAS0gAZaQAMt" +
  "oJeB/rwG5R7QQAMNtIAGWkADLaBdOQS0BLSABlpAAy2ggRbQUhjQqba+7YcDDTTQQAMtoIEGGmiggXblENBAC2igBbSABlpA" +
  "Ay2ggRbQ03ay9W0/HGgBDTTQQAMNNNBAAw20BLSABlpAAy2ggRbQEtAC2ta3stsPB1pAAy2ggQYaaKCBduWQKwfQAhpoAQ20" +
  "gAZaQAtooAW0re9Uu9YCGmiggQYaaKCBBhpouXJIQAtooAU00AIaaAEtAS2gbX3bDwcaaKCBBhpooAU00EAD7cohoIEW0EAL" +
  "aAENtIAGWkADLaD/PcBkt/1woAU00AIaaKCBBhpoVw4JaAENtIAGWkADLaAFNNAC2tb3FnatBTTQwRsBft4SQdp74qkAAAAA" +
  "SUVORK5CYII=";

/** Rust's hard cap on the attached image, in base64 characters. Past it the
 *  report still sends and the pixels are dropped — the receipt says so. */
const MAX_SCREENSHOT_B64 = 500_000;

// ── PDF annotations ─────────────────────────────────────────────────────────

/** The two-page PDF seeded into the fake tree. Annotations are keyed by the
 *  PDF's absolute path, exactly as Rust keys `.atlas/pdf-annotations.json`. */
const SPEC_PDF = abs("docs/spec.pdf");

/**
 * Seeded so the viewer opens onto something: two highlights on page 1 (one of
 * them a second colour, so the swatch is visibly not hardcoded) and a note on
 * page 2 whose body is long enough to test the note editor's wrapping and the
 * tooltip, rather than the one-word note everyone writes by hand.
 *
 * Geometry is normalized 0..1 of the page, so these land in the same place at
 * every zoom level. The highlights are measured off `SPEC_PDF_BASE64`'s page 1
 * (Letter, 612×792pt; body text is 11pt Helvetica at x=72): "1. Base tokens…"
 * has its glyph box at y 0.2288–0.2427 and "3. Dark mode…" at 0.2692–0.2831,
 * and each rect pads that by ~0.0025 above and below. Change the PDF's text
 * and these must be re-measured, or they float onto the blank line above.
 */
const SEEDED_ANNOTATIONS: PdfAnnotation[] = [
  {
    kind: "highlight",
    id: "ann-seed-h1",
    page: 1,
    color: "#F5C542",
    createdAt: iso(-2),
    rect: { x: 0.112, y: 0.226, w: 0.29, h: 0.019 },
  },
  {
    kind: "highlight",
    id: "ann-seed-h2",
    page: 1,
    color: "#6796E6",
    createdAt: iso(-2),
    rect: { x: 0.112, y: 0.2665, w: 0.448, h: 0.019 },
  },
  {
    kind: "note",
    id: "ann-seed-n1",
    page: 2,
    color: "#5CC28A",
    createdAt: iso(-1),
    // A note is a pin, not a box: `x`/`y` are the anchor, and the body below is
    // only ever seen through the editor it opens.
    x: 0.78,
    y: 0.33,
    text:
      "This paragraph contradicts §2.1: there the retry budget is described as per-connection, " +
      "and here it is per-request. Worth deciding before the client is generated, because the " +
      "generator reads this section and not that one — and whichever it picks becomes the " +
      "behaviour every downstream service inherits without anyone reading either paragraph again.",
  },
];

const pdfAnnotations = new Map<string, PdfAnnotation[]>([
  [SPEC_PDF, structuredClone(SEEDED_ANNOTATIONS)],
]);

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface IntegrationsResponses {
  auth_snapshot: AuthSnapshot;
  auth_refresh: AuthSnapshot;
  auth_sign_in: AuthSnapshot;
  auth_cancel_sign_in: AuthSnapshot;
  auth_sign_out: boolean;
  auth_set_active_org: Unread;
  auth_create_org: CreatedOrg;
  auth_delete_org: Unit;
  auth_check_org_slug: boolean;
  auth_list_members: OrgMember[];
  auth_list_invitations: OrgInvitation[];
  auth_invite_member: OrgInvitation;
  auth_cancel_invitation: Unit;
  auth_update_member_role: Unit;
  auth_remove_member: Unit;
  auth_leave_org: Unit;
  search_github: GithubRepo[];
  clone_github_repo: string;
  list_cloned_repos: ClonedRepo[];
  read_repo_readme: string;
  delete_cloned_repo: Unread;
  list_remote_branches: string[];
  switch_cloned_repo_branch: Unread;
  update_cloned_repo: string;
  fetch_cloned_repo_meta: ClonedRepo["meta"];
  feedback_submit: FeedbackReceipt;
  capture_screenshot: CaptureResult | null;
  pdf_annotations_load: PdfAnnotation[];
  pdf_annotations_save: Unread;
}

export const integrationsHandlers: TypedHandlers<IntegrationsResponses> = {
  // ── Atlas account ─────────────────────────────────────────────────────────
  auth_snapshot: (): AuthSnapshot => snapshot,
  auth_refresh: (): AuthSnapshot => {
    broadcast();
    return snapshot;
  },
  /**
   * The real command resolves as soon as the grant *starts*, with the browser
   * already opened and polling running behind it — so this returns `connecting`
   * and flips to signed-in a beat later, which is the only way to see the
   * connect dialog's code, its countdown, and its own dismissal.
   */
  auth_sign_in: (): AuthSnapshot => {
    snapshot = {
      status: "connecting",
      userCode: "WDJB-MJHT",
      verificationUri: "https://app.tryatlas.cc/device",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    broadcast();
    grantTimer = window.setTimeout(() => {
      grantTimer = null;
      if (snapshot.status !== "connecting") return;
      snapshot = structuredClone(SIGNED_IN);
      broadcast();
    }, 2_500);
    return snapshot;
  },
  auth_cancel_sign_in: (): AuthSnapshot => {
    if (grantTimer !== null) {
      clearTimeout(grantTimer);
      grantTimer = null;
    }
    snapshot = { status: "signed-out" };
    broadcast();
    return snapshot;
  },
  /**
   * Resolves `false` — "signed out here, but the server could not confirm the
   * session is gone". The caveat toast is the branch nobody sees otherwise;
   * return `true` for the quiet path.
   */
  auth_sign_out: (): boolean => {
    snapshot = { status: "signed-out" };
    broadcast();
    return false;
  },
  /**
   * `orgId` is the SERVER id, or `null` for a local-only org. Null clears the
   * desktop's explicit choice: `activeOrgId` falls back to the first org the
   * way Rust resolves it, while `commsOrgId` honours the "none" and stays null.
   */
  auth_set_active_org: ({ orgId }): null => {
    if (snapshot.status !== "signed-in") return null;
    const id = orgId === null || orgId === undefined ? null : String(orgId);
    snapshot = {
      ...snapshot,
      activeOrgId: id ?? snapshot.orgs?.[0]?.id ?? null,
      commsOrgId: id,
    };
    return broadcast();
  },
  auth_create_org: ({ name, slug }): CreatedOrg => {
    const handle = String(slug);
    if (TAKEN_SLUGS.has(handle)) fail(`The handle “${handle}” is already taken.`);
    const created: CreatedOrg = { id: `org-${handle}`, name: String(name) };
    TAKEN_SLUGS.add(handle);
    if (snapshot.status === "signed-in") {
      // A freshly created org makes you its admin, which is what unlocks the
      // invite flow on the org you just made.
      snapshot = {
        ...snapshot,
        orgs: [...currentOrgs(), { id: created.id, name: created.name, role: "admin" }],
      };
      broadcast();
    }
    return created;
  },
  auth_delete_org: ({ remoteId }): null => {
    const id = String(remoteId);
    membersByOrg.delete(id);
    invitesByOrg.delete(id);
    if (snapshot.status === "signed-in") {
      snapshot = { ...snapshot, orgs: currentOrgs().filter((o) => o.id !== id) };
      broadcast();
    }
    return null;
  },
  /** Advisory, and deliberately not just a boolean: a handle too short to be
   *  legal rejects, which is the create dialog's third state (`error`). */
  auth_check_org_slug: ({ slug }): boolean => {
    const handle = String(slug ?? "");
    if (handle.length < 3) fail("Handles must be at least 3 characters.");
    return !TAKEN_SLUGS.has(handle);
  },

  auth_list_members: ({ orgId }): OrgMember[] => roster(String(orgId)).map((m) => ({ ...m })),
  /**
   * Admin-scoped server-side. Northwind is the org the account is only a
   * `member` of, so this rejects there — which is exactly the case the modal
   * settles separately from `listMembers` so the members tab still works.
   */
  auth_list_invitations: ({ orgId }): OrgInvitation[] => {
    const id = String(orgId);
    if (id === SECOND_ORG_ID) {
      fail("Only an admin can see this organization's invites.");
    }
    return invites(id).map((i) => ({ ...i }));
  },
  /**
   * The resolved `acceptUrl` is the same link the server emails the invitee;
   * the modal copies it straight out of this response so the inviter can also
   * share it directly.
   */
  auth_invite_member: ({ orgId, email, role }): OrgInvitation => {
    const id = String(orgId);
    const address = String(email);
    if (roster(id).some((m) => m.email === address)) {
      fail("Couldn't invite them — you may not be an admin, or they're already in.");
    }
    invitesMinted += 1;
    const token = `t${invitesMinted.toString().padStart(4, "0")}-r9kq2m`;
    const invitation: OrgInvitation = {
      id: `inv-new-${invitesMinted}`,
      email: address,
      role: (role ?? null) as Role | null,
      status: "pending",
      expiresAt: iso(7),
      acceptUrl: `https://atlas.dev/invite/${token}`,
    };
    invitesByOrg.set(id, [invitation, ...invites(id)]);
    return invitation;
  },
  auth_cancel_invitation: ({ invitationId }): null => {
    const id = String(invitationId);
    for (const [org, list] of invitesByOrg) {
      invitesByOrg.set(
        org,
        list.filter((i) => i.id !== id),
      );
    }
    return null;
  },
  /** Rejects for the one member the org cannot lose — the last admin — because
   *  the optimistic row revert is otherwise unreachable from the UI. */
  auth_update_member_role: ({ orgId, memberId, role }): null => {
    const id = String(orgId);
    const list = roster(id);
    const target = list.find((m) => m.id === String(memberId));
    if (!target) fail("Only an admin can change a member's role.");
    const admins = list.filter((m) => m.role === "admin");
    if (target.role === "admin" && admins.length === 1 && role !== "admin") {
      fail("An organization needs at least one admin.");
    }
    target.role = (role ?? null) as Role | null;
    return null;
  },
  /**
   * The one member op that broadcasts: removing yourself changes your own org
   * set, so the account menu has to stop listing an org you just left.
   */
  auth_remove_member: ({ orgId, memberIdOrEmail }): null => {
    const id = String(orgId);
    const key = String(memberIdOrEmail);
    const list = roster(id);
    const target = list.find((m) => m.id === key || m.email === key);
    if (!target) fail("Only an admin can remove a member.");
    membersByOrg.set(
      id,
      list.filter((m) => m !== target),
    );
    if (target.userId === "usr_dev" && snapshot.status === "signed-in") {
      snapshot = { ...snapshot, orgs: currentOrgs().filter((o) => o.id !== id) };
      broadcast();
    }
    return null;
  },
  /**
   * Leaving, with the server's two refusals: the Owner (Acme, where the
   * account is Owner) and the last admin. Northwind, where the account is a
   * plain member, is the one to leave — the switcher then drops it.
   */
  auth_leave_org: ({ orgId }): null => {
    const id = String(orgId);
    const list = roster(id);
    const me = list.find((m) => m.userId === "usr_dev");
    if (!me) fail("You're not a member of this organization.");
    if (me.isOwner) fail("The organization's owner cannot leave it.");
    if (me.role === "admin" && list.filter((m) => m.role === "admin").length === 1) {
      fail("You're the only admin — make someone else an admin first.");
    }
    membersByOrg.set(
      id,
      list.filter((m) => m !== me),
    );
    if (snapshot.status === "signed-in") {
      snapshot = { ...snapshot, orgs: currentOrgs().filter((o) => o.id !== id) };
      broadcast();
    }
    return null;
  },

  // ── GitHub ────────────────────────────────────────────────────────────────
  /**
   * Filtered rather than fixed, so the empty state ("zzz") and a narrowing
   * search ("swr") are both one keystroke away. The literal query `offline` is
   * the failure path — the panel's error line has no other way in.
   */
  search_github: async ({ query }): Promise<GithubRepo[]> => {
    const q = String(query ?? "")
      .trim()
      .toLowerCase();
    if (q === "offline") fail("GitHub API request failed: error sending request");
    // GitHub search is a round trip; without the wait the spinner never paints.
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (!q) return [];
    return SEARCH_RESULTS.filter((repo) =>
      `${repo.full_name} ${repo.description} ${repo.language}`.toLowerCase().includes(q),
    );
  },
  /** Slow on purpose: a `git clone` is the one action in the panel long enough
   *  that its per-row progress state is worth looking at. */
  clone_github_repo: async ({ repoName, meta }): Promise<string> => {
    const name = String(repoName);
    if (clonedRepos.some((r) => r.name === name)) {
      fail(`Repository '${name}' already cloned`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    // Rust derives the display name from the clone's own `origin`, which the
    // directory name cannot be un-mangled back into — `rust-lang-rust` splits
    // at the wrong hyphen. Look it up instead, and only guess when it came
    // from somewhere other than search.
    const known = SEARCH_RESULTS.find((row) => row.full_name.replace("/", "-") === name);
    clonedRepos = [
      ...clonedRepos,
      {
        name,
        display_name: known?.full_name ?? name.replace("-", "/"),
        path: abs(`.atlas/repos/${name}`),
        has_readme: name in READMES,
        branch: "main",
        meta: (meta ?? null) as RepoMeta | null,
      },
    ];
    return abs(`.atlas/repos/${name}`);
  },
  list_cloned_repos: (): ClonedRepo[] => clonedRepos.map((r) => ({ ...r })),
  read_repo_readme: ({ repoName }): string => {
    const readme = READMES[String(repoName)];
    if (readme === undefined) fail("No README found");
    return readme;
  },
  delete_cloned_repo: ({ repoName }): null => {
    clonedRepos = clonedRepos.filter((r) => r.name !== String(repoName));
    return null;
  },
  /** `ls-remote` over the network, so an unreachable remote is a real outcome:
   *  the repo Atlas has no cached metadata for is also the one that fails here,
   *  which is what the branch popover's error line is for. */
  list_remote_branches: async ({ repoName }): Promise<string[]> => {
    const name = String(repoName);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const branches = REMOTE_BRANCHES[name];
    if (!branches) fail("fatal: could not read from remote repository");
    return [...branches];
  },
  switch_cloned_repo_branch: async ({ repoName, branch }): Promise<string> => {
    const name = String(repoName);
    const next = String(branch);
    await new Promise((resolve) => setTimeout(resolve, 600));
    clonedRepos = clonedRepos.map((r) => (r.name === name ? { ...r, branch: next } : r));
    return next;
  },
  /** Refuses on a detached HEAD, exactly as Rust does — `vercel-swr` is seeded
   *  in that state precisely so the refusal is reachable. */
  update_cloned_repo: async ({ repoName }): Promise<string> => {
    const repo = clonedRepos.find((r) => r.name === String(repoName));
    if (!repo) fail("that repository is not cloned here");
    if (!repo.branch) fail("the clone is not on a branch — pick one first");
    await new Promise((resolve) => setTimeout(resolve, 900));
    return repo.branch;
  },
  /** The back-fill the panel runs, once, for every row whose `meta` is null. */
  fetch_cloned_repo_meta: async ({ repoName }): Promise<RepoMeta> => {
    const name = String(repoName);
    const repo = clonedRepos.find((r) => r.name === name);
    if (!repo) fail("cannot tell which GitHub repository this is");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const known = SEARCH_RESULTS.find((row) => row.full_name === repo.display_name);
    const meta: RepoMeta = known
      ? {
          description: known.description,
          language: known.language,
          stars: known.stars,
          forks: known.forks,
          html_url: known.html_url,
          updated_at: known.updated_at,
        }
      : repoMeta("", "", 0, 0, repo.display_name, iso(-900));
    clonedRepos = clonedRepos.map((r) => (r.name === name ? { ...r, meta } : r));
    return meta;
  },

  // ── Feedback ──────────────────────────────────────────────────────────────
  /**
   * Succeeds. The panel keeps the user's draft on a rejection and clears it on
   * success, so to see the failure half, `fail("…")` here — an empty
   * message and an inert telemetry key are the two ways Rust itself rejects.
   *
   * `anonymous` is what *happened*, not what was asked for: signed out, a
   * report is anonymous whether or not the box was ticked, and the panel says
   * "sent anonymously" off this field rather than off its own checkbox.
   */
  feedback_submit: ({ input }): FeedbackReceipt => {
    const payload = input as FeedbackPayload;
    const shot = payload.screenshotBase64 ?? "";
    return {
      sent: true,
      anonymous: Boolean(payload.anonymous) || snapshot.status !== "signed-in",
      screenshotDropped: shot.length > MAX_SCREENSHOT_B64,
    };
  },
  /**
   * Native `screencapture`. Returns a real decodable PNG so the preview, the
   * canvas downscale and the chat composer's inline attachment all work.
   *
   * The other half of this command is `null`, which is the user pressing Esc
   * during region selection and is deliberately not an error — return `null`
   * here to see the panel treat a cancelled capture as a no-op.
   */
  capture_screenshot: ({ projectPath }): CaptureResult => ({
    // The feedback panel passes `projectPath: null` on purpose (a feedback
    // screenshot has no business landing in someone's repository); the chat
    // composer passes the project and gets `.atlas/screenshots`.
    path: projectPath
      ? abs(`.atlas/screenshots/atlas_shot_${NOW}.png`)
      : `/var/folders/mock/T/atlas_shot_${NOW}.png`,
    mimeType: "image/png",
    dataBase64: SHOT_PNG_BASE64,
  }),

  // ── PDF annotations ───────────────────────────────────────────────────────
  pdf_annotations_load: ({ pdfPath }): PdfAnnotation[] =>
    structuredClone(pdfAnnotations.get(String(pdfPath)) ?? []),
  /** Writes through to module state, so a highlight drawn here survives a tab
   *  switch and a reopen — the store reloads from this on every mount. */
  pdf_annotations_save: ({ pdfPath, annotations }): null => {
    const key = String(pdfPath);
    const next = (annotations ?? []) as PdfAnnotation[];
    // Rust drops the key entirely when the last annotation is erased, so the
    // file never accumulates entries for PDFs with nothing on them.
    if (next.length === 0) pdfAnnotations.delete(key);
    else pdfAnnotations.set(key, structuredClone(next));
    return null;
  },
};
