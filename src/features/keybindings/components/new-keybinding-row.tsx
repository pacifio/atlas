import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Select } from "@/ui/select";
import { Hint } from "@/ui/tooltip";
import { ACTION_BY_ID, ACTIONS, type ActionId } from "../lib/actions";
import { type Combo, comboFromEvent, displayLabel, serializeCombo } from "../lib/combo";
import { bindingsForCombo } from "../lib/resolve";
import {
  defaultWhenExpression,
  neverMatches,
  parseWhen,
  whenToExpression,
  type WhenNode,
} from "../lib/when";
import { WHEN_PHRASES } from "../lib/keybindings-view";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { WhenClauseControl } from "./when-clause-control";

const COMMAND_OPTIONS = ACTIONS.map((a) => ({
  value: a.id as ActionId,
  label: a.title,
  description: a.category,
}));

/**
 * "Add keybinding": pick a command, press its shortcut, optionally set where
 * it works, and Save.
 *
 * An Atlas condition belongs to the command, not to one shortcut, so the
 * When here starts from the command's current condition and saving one
 * changes it for all of that command's shortcuts.
 */
/** `onDone` gets the command a shortcut was saved to, or null on Cancel. */
export function NewKeybindingRow({ onDone }: { onDone: (saved: ActionId | null) => void }) {
  const { addBinding, setWhen, setRecording } = useKeybindingsStore.use.actions();
  const resolved = useKeybindingsStore.use.resolved();
  const [command, setCommand] = useState<ActionId | null>(null);
  const [combo, setCombo] = useState<Combo | null>(null);
  const [recordingKeys, setRecordingKeys] = useState(false);
  const [when, setWhenDraft] = useState<WhenNode | undefined>(undefined);
  const [whenTouched, setWhenTouched] = useState(false);

  // The dispatchers stay silent while the key field owns the keyboard.
  useEffect(() => {
    setRecording(recordingKeys);
    return () => setRecording(false);
  }, [recordingKeys, setRecording]);

  const currentWhen = command ? resolved.perAction.get(command)?.whenExpr : undefined;
  const whenValue = whenTouched ? when : (parseWhen(currentWhen ?? "") ?? undefined);
  const whenExpression = whenToExpression(whenValue);
  const title = command ? ACTION_BY_ID[command].title : "New keybinding";
  const phrase = command ? WHEN_PHRASES[ACTION_BY_ID[command].when] : "";
  const warning =
    command && neverMatches(whenValue, ACTION_BY_ID[command].when)
      ? phrase
        ? `This shortcut only runs ${phrase.toLowerCase()}, and this condition is never true there.`
        : "This condition is never true, so the shortcut never runs."
      : null;

  const conflicts =
    combo && command
      ? [
          ...new Set(
            bindingsForCombo(resolved.list, combo, command)
              .filter((b) => b.whenExpr === whenExpression || !b.whenExpr || !whenExpression)
              .map((b) => ACTION_BY_ID[b.actionId].title),
          ),
        ]
      : [];

  const save = () => {
    if (!command || !combo) return;
    addBinding(command, serializeCombo(combo));
    if (whenTouched && whenExpression !== currentWhen) {
      const own = whenToExpression(
        parseWhen(defaultWhenExpression(ACTION_BY_ID[command].when)) ?? undefined,
      );
      setWhen(command, whenExpression === own ? null : whenExpression);
    }
    onDone(command);
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">New keybinding</h3>
        <WhenClauseControl
          // Re-mount the builder when the command changes, so its text field
          // starts from that command's condition.
          key={command ?? ""}
          label={title}
          expression={whenExpression}
          value={whenValue}
          warning={warning}
          scope={command ? WHEN_PHRASES[ACTION_BY_ID[command].when] : undefined}
          onChange={(next) => {
            setWhenTouched(true);
            setWhenDraft(next);
          }}
        />
      </div>
      {command && whenTouched && (resolved.byAction.get(command)?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          The condition applies to every shortcut for {title}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={command ?? ("" as ActionId)}
          onValueChange={(next) => {
            setCommand(next);
            setWhenTouched(false);
          }}
          options={COMMAND_OPTIONS}
          placeholder={command ? undefined : "Command"}
          size="sm"
          aria-label="Command"
          className="min-w-0 flex-1"
        />
        {conflicts.length > 0 && (
          <Hint
            label={`${displayLabel(combo!)} is also ${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? ", and more" : ""}.`}
          >
            <span
              tabIndex={0}
              aria-label="Conflicts"
              className="inline-flex size-control-xs items-center justify-center text-warning"
            >
              <Icon icon={AlertTriangle} size="xs" />
            </span>
          </Hint>
        )}
        <Input
          aria-label={`Keybinding for ${title}`}
          readOnly
          value={recordingKeys ? "" : combo ? displayLabel(combo) : ""}
          placeholder={recordingKeys ? "Press shortcut" : "Unassigned"}
          size="sm"
          className="w-44 font-mono"
          onFocus={() => setRecordingKeys(true)}
          onBlur={() => setRecordingKeys(false)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && !recordingKeys) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
              setCombo(null);
              setRecordingKeys(false);
              e.currentTarget.blur();
              return;
            }
            const next = comboFromEvent(e.nativeEvent);
            if (!next) return;
            setCombo(next);
            setRecordingKeys(false);
          }}
          onClick={() => setRecordingKeys(true)}
        />
        <Button size="sm" disabled={!command || !combo} onClick={save}>
          Save
        </Button>
        <Hint label="Cancel">
          <IconButton
            icon={X}
            size="sm"
            label="Cancel new keybinding"
            onClick={() => onDone(null)}
          />
        </Hint>
      </div>
    </div>
  );
}
