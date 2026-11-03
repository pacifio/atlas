// The composer's two pickers, as the editor sees them: what a pick does, and
// the keys the editor forwards while one is open.

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MentionPickerHandle } from "@/features/mentions/components/mention-picker";
import type { ChatInputHandle, MentionTrigger, SlashTrigger } from "../components/chat-input";
import type { SlashCommandPickerHandle, SlashCommand } from "../components/slash-command-picker";
import { commandRequiresArgs } from "../components/slash-command-picker";
import { promptSignIn } from "../lib/agent-signin";
import { forkSessionToNewTab } from "../lib/fork-session";
import type { MentionData } from "../lib/mentions";
import type { AttachSource } from "../lib/session-projects-api";
import type { ValueStore } from "../lib/value-store";
import type { AgentType } from "@/types/agent";

export function useComposerPickers({
  tabId,
  agentType,
  disabled,
  inputRef,
  pickerRef,
  triggerRef,
  setTrigger,
  slashStore,
  slashPickerRef,
  lastAuthReasonRef,
  submitRef,
  attachPicked,
}: {
  tabId: string;
  agentType: AgentType;
  disabled: boolean;
  inputRef: RefObject<ChatInputHandle | null>;
  pickerRef: RefObject<MentionPickerHandle | null>;
  triggerRef: RefObject<MentionTrigger | null>;
  setTrigger: Dispatch<SetStateAction<MentionTrigger | null>>;
  slashStore: ValueStore<SlashTrigger | null>;
  slashPickerRef: RefObject<SlashCommandPickerHandle | null>;
  lastAuthReasonRef: RefObject<string | null>;
  submitRef: RefObject<() => void>;
  attachPicked: (mention: MentionData, source?: AttachSource) => void;
}) {
  const setSlashTrigger = slashStore.set;

  const handleMentionSelect = useCallback(
    (mention: MentionData) => {
      const t = triggerRef.current;
      if (!t) return;
      inputRef.current?.insertMention(mention, { from: t.from, to: t.to });
      attachPicked(mention);
      // Trigger naturally closes when the doc no longer has an `@…` before
      // the caret; the plugin will fire the null transition for us.
    },
    [attachPicked],
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      const t = slashStore.get();
      const input = inputRef.current;
      if (!t || !input) return;
      // An Atlas-local command leaves no literal `/login` behind.
      const clearSlashRange = () => input.replaceRange(t.from, t.to, "");

      if (cmd.handler === "agent-login") {
        // An Atlas-handled command (S1): every agent opens the same
        // `AgentOAuthModal`. `reason` is passed so the modal can tell an
        // "agent wants a provider key" failure from a plain "not signed in".
        clearSlashRange();
        setSlashTrigger(null);
        promptSignIn(agentType, { reason: lastAuthReasonRef.current ?? undefined });
        inputRef.current?.focus();
        return;
      }
      if (cmd.handler === "fork") {
        // Same flow as the header's "branch from here" menu item.
        clearSlashRange();
        setSlashTrigger(null);
        forkSessionToNewTab(tabId);
        inputRef.current?.focus();
        return;
      }
      // "queue" needs a message, so its signature carries `<message>` and the
      // requires-args branch below inserts "/queue " for the user to fill in;
      // the actual queueing happens in `submit`, which intercepts the typed
      // form.

      // Passthrough: every other command is sent verbatim to the agent.
      // claude-agent-acp's SDK processes the slash command client-side
      // and emits the result as `<local-command-*>` blocks via the
      // normal `agent_message_chunk` channel, so the response renders in
      // the chat thread alongside regular assistant output.
      //
      // Gate on `disabled` — passthrough requires a working ACP
      // connection, and sending a slash command to a not-yet-authed
      // agent would just surface an error. `/login` bypasses this gate
      // above because it's the path that fixes "not authed".
      if (disabled) {
        clearSlashRange();
        setSlashTrigger(null);
        return;
      }
      if (commandRequiresArgs(cmd)) {
        // Drop `/<name> ` into the composer and put the caret at the
        // end so the user can fill in the required args. Don't send
        // until they press Enter.
        input.replaceRange(t.from, t.to, `/${cmd.name} `);
        setSlashTrigger(null);
        input.focus();
        return;
      }

      // No required args — commit the full command name in place of the
      // typed token (the query may be a prefix, e.g. "he" → "help"). Since
      // the trigger can sit mid-message, replacing just [from, to] preserves
      // any surrounding text instead of wiping the whole composer.
      input.replaceRange(t.from, t.to, `/${cmd.name}`);
      setSlashTrigger(null);
      if (!t.atStart) {
        // Mid-message: complete the text and stop. Only a command at byte 0
        // resolves — auto-sending from here would ship `/foo` to the agent as
        // prose and silently do nothing. Leaving it in the composer matches
        // the mention picker (Enter selects, it doesn't send) and keeps the
        // user's next Enter meaningful.
        inputRef.current?.focus();
        return;
      }
      // At byte 0 the command will actually run, so fall through to the normal
      // submit path — trim/mentions/queueing behave exactly like a typed Enter.
      submitRef.current();
    },
    [disabled, agentType, tabId],
  );

  // Forward Up/Down/Enter/Esc/Backspace/Tab from the editor to whichever
  // picker is open. Slash and mention pickers are mutually exclusive in
  // practice (each trigger requires its own sigil to open the token being
  // typed), but we still route deterministically.
  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape" | "Backspace" | "Tab") => {
      // Slash takes precedence when both happen to be open.
      const sp = slashPickerRef.current;
      const st = slashStore.get();
      if (st && sp) {
        switch (key) {
          case "Up":
            sp.moveUp();
            return true;
          case "Down":
            sp.moveDown();
            return true;
          case "Enter":
            return sp.commit();
          case "Escape":
            setSlashTrigger(null);
            return true;
          case "Backspace":
            // Let the editor delete a query char or the `/` itself (which closes
            // the picker via the trigger detector).
            return false;
          case "Tab": {
            const active = sp.activeCommand();
            if (!active) return true;
            // Only real passthrough commands get "complete without sending"
            // — that's for filling in args before Enter. Host-handled rows
            // (login, open-settings, unavailable guards) take no args, so
            // completing them into plain text would let a guard row like
            // dimmed `/clear` slip past its own handler on the next Enter
            // and get sent to the agent as literal passthrough text — the
            // exact silent no-op these guard rows exist to prevent. Those
            // run through the normal commit path instead, same as Enter.
            if (active.handler !== "passthrough") {
              return sp.commit();
            }
            // Complete to the full command name (never sends). The caret
            // lands right after a trailing space, which the trigger
            // detector reads as "hit whitespace" and closes the picker on
            // its own — same as if the user had typed the space by hand.
            inputRef.current?.replaceRange(st.from, st.to, `/${active.name} `);
            return true;
          }
        }
      }

      const p = pickerRef.current;
      const t = triggerRef.current;
      if (!t || !p) return false;
      switch (key) {
        case "Up":
          p.moveUp();
          return true;
        case "Down":
          p.moveDown();
          return true;
        case "Enter":
          return p.commit();
        case "Escape":
          // At a sublevel, Esc pops back. At the top level, it closes.
          if (p.goBack()) return true;
          setTrigger(null);
          return true;
        case "Backspace":
          // Only consume Backspace when at a sublevel AND the query is
          // empty — otherwise let the editor delete a character in the query (or
          // the `@` itself, which closes the picker via the trigger
          // detector).
          if (t.query === "" && p.goBack()) return true;
          return false;
        case "Tab":
          // Not handled for the mention picker — fall through to the
          // composer's Tab (list indent / outdent).
          return false;
      }
    },
    [],
  );

  return { handleMentionSelect, handleSlashSelect, keyInterceptor };
}
