// Every Tip Atlas can show (CONTEXT.md, "Tip"): a one-time card anchored to a
// feature, shown the first time the user meets it.
//
// A tip points at the element carrying `data-tip-anchor="<anchor>"`, and is
// asked for by whatever marks "the user just met this" — a focus, a first
// open, a first event — through the tips store's `request`. Whether and when
// it actually appears is `pickNextTip`'s call, never the caller's.
//
// DRAFT COPY: the wording here is a first pass for the user to rewrite.

export type TipKind =
  /** Shown the first time the user reaches a place: a surface, the composer.
   *  Someone who upgraded never gets these — they already know the place. */
  | "surface"
  /** Shown when something happens for the first time. Everyone gets these,
   *  and they go ahead of surface tips in the queue. */
  | "moment";

export interface TipStep {
  title: string;
  body: string;
}

export interface TipDef {
  id: string;
  kind: TipKind;
  /** False for a tip that must only ever be shown once (the sign-in nudge):
   *  Replay all tips leaves it seen, and Show tip… does not list it. */
  replayable: boolean;
  /** The `data-tip-anchor` value of the element the card points at. */
  anchor: string;
  /** Which side of the anchor the card sits on. Defaults to below. */
  side?: "top" | "bottom" | "left" | "right";
  /** One to three steps. */
  steps: readonly TipStep[];
  /** A docs page for "Learn more". */
  learnMore?: string;
}

const DOCS = "https://docs.tryatlas.cc/docs";

export const TIPS = [
  // ── Surface tips: the first time the user reaches a place ────────────────
  {
    id: "composer",
    kind: "surface",
    replayable: true,
    anchor: "composer",
    side: "top",
    steps: [
      {
        title: "Bring context with @",
        body: "Type @ to hand the agent a file, a folder, a branch or an earlier session. Atlas resolves it before your message is sent.",
      },
      {
        title: "Switch agents as you go",
        body: "Pick an agent from the icon in the composer, or press ⌥/ to cycle through the ones you have installed.",
      },
    ],
    learnMore: `${DOCS}/product/power-user`,
  },
  {
    id: "surfaces",
    kind: "surface",
    replayable: true,
    anchor: "surfaces",
    side: "bottom",
    steps: [
      {
        title: "Open tools beside the session",
        body: "Press ⌘T for a terminal, the editor, files, source control or a browser, in columns next to your session.",
      },
      {
        title: "Everything else is in ⌘K",
        body: "The command palette reaches every action, project and session without leaving the keyboard.",
      },
    ],
    learnMore: `${DOCS}/product/power-user`,
  },
  {
    id: "checkpoint",
    kind: "surface",
    replayable: true,
    anchor: "produced-by",
    side: "bottom",
    steps: [
      {
        title: "This commit knows where it came from",
        body: "Atlas linked it to the session that wrote it. Open the session to see what the agent was asked, and why it made the change.",
      },
    ],
    learnMore: `${DOCS}/source-control/capture`,
  },
  {
    id: "timeline",
    kind: "surface",
    replayable: true,
    anchor: "timeline",
    side: "right",
    steps: [
      {
        title: "Every session, in one place",
        body: "The Timeline lists your recorded sessions and the commits they produced. In a Cloud project, your teammates' sessions sit here too.",
      },
      {
        title: "Comment on the work",
        body: "Comment on a session, a message, a tool call or a checkpoint. On a live session, it reaches the developer's agent while it works.",
      },
    ],
    learnMore: `${DOCS}/team/timeline`,
  },
  {
    id: "team-chat",
    kind: "surface",
    replayable: true,
    anchor: "team-chat",
    side: "right",
    steps: [
      {
        title: "Talk next to the work",
        body: "Channels and direct messages for your organization. Share a session or a checkpoint as a card anyone can open.",
      },
    ],
    learnMore: `${DOCS}/team/chat`,
  },
  {
    id: "ask-atlas",
    kind: "surface",
    replayable: true,
    anchor: "ask-atlas",
    side: "right",
    steps: [
      {
        title: "Ask about your team's work",
        body: "Atlas, your organization's agent, answers from everyone's sessions, comments and chat, as far as you can read them.",
      },
    ],
    learnMore: `${DOCS}/team/ask-atlas`,
  },
  {
    id: "memory",
    kind: "surface",
    replayable: true,
    anchor: "memory",
    side: "top",
    steps: [
      {
        title: "What your agents remember",
        body: "Plans, decisions and failures any agent records in this repository, shared with every other agent you run here. It stays on this machine.",
      },
    ],
    learnMore: `${DOCS}/context/memory`,
  },

  // ── Moment tips: the first time something happens ────────────────────────
  {
    id: "capture",
    kind: "moment",
    replayable: true,
    anchor: "capture",
    side: "bottom",
    steps: [
      {
        title: "Keep this session",
        body: "Session capture is off for this project, so this session won't be recorded or linked to its commits. Turn it on here.",
      },
    ],
    learnMore: `${DOCS}/source-control/capture`,
  },
  {
    id: "sign-in",
    kind: "moment",
    // Asked once, ever: signing in is the user's call, not something to nag.
    replayable: false,
    anchor: "account",
    side: "bottom",
    steps: [
      {
        title: "Share this with your team",
        body: "Sign in to put your sessions on your team's timeline. Your code stays on this machine; only the record of the agent's work syncs.",
      },
    ],
    learnMore: `${DOCS}/team/accounts`,
  },
] as const satisfies readonly TipDef[];

export const TIP_BY_ID: Readonly<Record<string, TipDef>> = Object.fromEntries(
  TIPS.map((t) => [t.id, t]),
);

/** The tips a user may bring back, from Show tip… or Replay all tips. */
export const REPLAYABLE_TIPS: readonly TipDef[] = TIPS.filter((t: TipDef) => t.replayable);

/** The star prompt: not a tip, but it shares the seen record (`tip-triggers.tsx`). */
export const STAR_PROMPT_ID = "star-github";

/** What shows only once, ever: Replay all tips leaves these seen. */
export const NEVER_REPLAYED: readonly string[] = [
  ...TIPS.filter((t: TipDef) => !t.replayable).map((t) => t.id),
  STAR_PROMPT_ID,
];
