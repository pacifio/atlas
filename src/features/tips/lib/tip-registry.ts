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
] as const satisfies readonly TipDef[];

export const TIP_BY_ID: Readonly<Record<string, TipDef>> = Object.fromEntries(
  TIPS.map((t) => [t.id, t]),
);

/** The tips a user may bring back, from Show tip… or Replay all tips. */
export const REPLAYABLE_TIPS: readonly TipDef[] = TIPS.filter((t: TipDef) => t.replayable);

/** The tips that show only once, ever: Replay all tips leaves them seen. */
export const NEVER_REPLAYED: readonly string[] = TIPS.filter((t: TipDef) => !t.replayable).map(
  (t) => t.id,
);
