// Northwind: the demo organisation the Atlas Learn videos are recorded in,
// with no real org to seed. `localhost:1420/?scenario=northwind&record=1`.
//
// Uzayer Masud (Owner) is signed in on the desktop; Zuhayer Masud is a Member.
// `northwind-shop` is bound to Cloud, the Timeline holds a week of their Sessions across Claude Code, Codex and
// Atlas Agent, commits link back to the Sessions that produced them (one to
// two), #shop has the conversation, and Memory/Policy/Skills are set up for
// video 11.
//
// Where the parts live:
//   northwind-content-types.ts  the shape of the words
//   northwind-content.ts        the words (Sessions, commits, chat, drafts, runs)
//   northwind-world.ts          ids, people, time, and what cues change
//   northwind-timeline.ts       the Timeline board, details, comments
//   northwind-agent.ts          agent chats and the scripted runs
//   northwind-comms.ts          team chat, drafts, members, sign-in
//   northwind-git.ts            the repo's files and git (+ fixtures/northwind-repo.ts)
//   northwind-misc.ts           boot identity, capture, Usage, Memory, Skills, agents
//
// URL options (all optional, combine with `&`):
//   record=1    hide the mock's own chrome (the unmocked badge) for recording
//   video=1     the state BEFORE video 1's live run: no discount-code Session
//               or commit yet; asking Claude Code to "add a discount code field
//               to checkout" creates both
//   chat=<id>   the recorded Session the first agent chat opens on (default
//               s-discount; s-normalize for video 11; `none` for an empty one)
//   codex=1     Codex already installed, as after video 9 (video 11 needs it)
//
// Live cues, for the moments a teammate does something mid-take. Each is a
// console action (`__atlasMock.actions.<name>()`) AND a shortcut, because
// nobody can type into the console on camera. Shortcuts are Ctrl+Option+<n>
// (matched on the physical key, so Option's characters do not matter) and are
// swallowed before the app sees them:
//
//   Ctrl+Option+1  zuhayerOnline        Zuhayer's presence dot appears (chat + Timeline)
//   Ctrl+Option+2  zuhayerSessionLive   Zuhayer's live Codex Session streams its next steps
//   Ctrl+Option+3  zuhayerComments      Zuhayer comments on your discount-code edit
//                                       (videos 1 and 4: it lands in the agent chat)
//   Ctrl+Option+4  zuhayerMessage       Zuhayer posts "server-side check is in" in #shop,
//                                       with the checkpoint card (video 4 beat 5)
//   Ctrl+Option+5  zuhayerDraftEdit     Zuhayer types his lines into "Move discount
//                                       pricing to the server", named cursor and all (video 5)
//   Ctrl+Option+6  zuhayerShare         Zuhayer drops your discount Session into #shop
//                                       (video 1 beat 5's fallback)
//   Ctrl+Option+7  zuhayerTyping        "Zuhayer is typing…" in #shop for a few seconds
//   Ctrl+Option+8  zuhayerMovesNote     Zuhayer joins the open #shop Space and drags the
//                                       "Pricing service" note (video 5 beat 3)
//   Ctrl+Option+Backspace  reset        reload the page into its starting state

import type { Scenario } from "../types";
import { CONTENT } from "./northwind-content";
import { installNorthwindAgent } from "./northwind-agent";
import {
  northwindCommsCommands,
  postAsMe,
  zuhayerDraftEdit,
  zuhayerMessage,
  zuhayerOnline,
  zuhayerTyping,
} from "./northwind-comms";
import { northwindGitCommands, northwindGitRawCommands } from "./northwind-git";
import {
  northwindMiscCommands,
  northwindMiscInit,
  northwindMiscRawCommands,
  rememberDecision,
} from "./northwind-misc";
import {
  commentAs,
  keepLiveFresh,
  northwindTimelineCommands,
  streamLiveSession,
} from "./northwind-timeline";
import { northwindSpacesCommands, zuhayerMovesNote } from "./northwind-spaces";
import { BEFORE_VIDEO_1 } from "./northwind-world";

const cues = CONTENT.cues;

const actions = {
  zuhayerOnline,
  zuhayerSessionLive: () => streamLiveSession(),
  zuhayerComments: () =>
    commentAs(
      "zuhayer",
      cues.zuhayerComment.session,
      cues.zuhayerComment.step,
      cues.zuhayerComment.body,
    ),
  zuhayerMessage: () => zuhayerMessage(cues.zuhayerMessage.body, cues.zuhayerMessage.sessionRef),
  zuhayerDraftEdit: () =>
    zuhayerDraftEdit(
      cues.zuhayerDraftEdit.draftTitle,
      cues.zuhayerDraftEdit.text,
      cues.zuhayerDraftEdit.afterText,
    ),
  zuhayerShare: () => zuhayerMessage(cues.zuhayerShare.body, cues.zuhayerShare.sessionRef),
  zuhayerTyping: () => zuhayerTyping("shop"),
  zuhayerMovesNote: () => zuhayerMovesNote(),
  // Clear what the last take left in browser storage, then reload: the
  // scenario's own state is seeded fresh on every load.
  reset: () => {
    clearStoredContent();
    location.reload();
  },
};

/** Physical key → cue, for Ctrl+Option+<key>. */
const SHORTCUTS: Record<string, keyof typeof actions> = {
  Digit1: "zuhayerOnline",
  Digit2: "zuhayerSessionLive",
  Digit3: "zuhayerComments",
  Digit4: "zuhayerMessage",
  Digit5: "zuhayerDraftEdit",
  Digit6: "zuhayerShare",
  Digit7: "zuhayerTyping",
  Digit8: "zuhayerMovesNote",
  Backspace: "reset",
};

function installShortcuts(): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
      const cue = SHORTCUTS[event.code];
      if (!cue) return;
      // Capture phase, and swallowed: the app never sees a cue's keystroke.
      event.preventDefault();
      event.stopImmediatePropagation();
      console.info(`[northwind] cue: ${cue}`);
      void actions[cue]();
    },
    { capture: true },
  );
}

/**
 * Browser-storage keys that hold CONTENT from an earlier page load — recent
 * chats, the notification bell, pinned chat messages, another project's file
 * index. Layout and theme keys are left alone, so the window keeps the shape
 * it was arranged in for the take.
 */
const CONTENT_KEYS = [
  /^atlas-recent-chats$/,
  /^atlas-notifications$/,
  /^atlas-chat-pins$/,
  /^atlas:fileindex-cache:/,
  // Per-agent model and mode lists cached by whatever scenario ran last.
  /^atlas:acp-(models|modes|config-options):/,
];

function clearStoredContent(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (CONTENT_KEYS.some((re) => re.test(key))) localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: there is nothing stale to clear either.
  }
}

/** What an approval card's Allow does in Atlas Agent's scripted runs. */
const text = (args: Record<string, unknown>, key: string) => String(args[key] ?? "");

export const northwind: Scenario = {
  name: "northwind",
  description:
    "Atlas Learn demo org: Northwind, northwind-shop on Cloud, #shop, Zuhayer — with live cues (Ctrl+Option+1…8).",
  commands: {
    ...northwindMiscCommands,
    ...northwindGitCommands,
    ...northwindCommsCommands,
    ...northwindSpacesCommands,
    ...northwindTimelineCommands,
  },
  rawCommands: { ...northwindMiscRawCommands, ...northwindGitRawCommands },
  init: () => {
    installNorthwindAgent({
      effects: {
        postShopReport: (args) =>
          void postAsMe("shop", text(args, "message"), { session: "s-normalize" }),
        postDiscountSession: (args) =>
          void postAsMe("shop", text(args, "message"), { session: "s-discount" }),
        replyToComment: (args) =>
          commentAs("uzayer", "s-normalize", "e-api", text(args, "reply"), "cm-expired"),
      },
      rememberDecision,
    });
    clearStoredContent();
    northwindMiscInit();
    installShortcuts();
    keepLiveFresh();
  },
  setup: async () => {
    // Open the agent chat the videos come back to (see `?chat=`), unless this
    // is video 1's starting state, which begins in the editor.
    if (BEFORE_VIDEO_1) return;
    // Reuses the chat tab the app opens on its own rather than adding a second.
    const { openNewAgentChat } = await import("@/features/chat/lib/open-agent-session");
    openNewAgentChat("claude-code");
  },
  actions,
};
