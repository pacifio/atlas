import { memo, useSyncExternalStore, type Ref } from "react";
import type { SlashTrigger } from "./chat-input";
import type {
  SlashCommandPicker as SlashCommandPickerComponent,
  SlashCommandPickerHandle,
  SlashCommand,
} from "./slash-command-picker";
import type { ValueStore } from "../lib/value-store";

/** The slash picker, fed from the trigger store: per keystroke, only this
 *  re-renders. Memoized so the composer's own re-renders pass it by. */
export const SlashPickerHost = memo(function SlashPickerHost({
  Picker,
  store,
  pickerRef,
  ...rest
}: {
  Picker: typeof SlashCommandPickerComponent;
  store: ValueStore<SlashTrigger | null>;
  pickerRef: Ref<SlashCommandPickerHandle>;
  onSelect: (cmd: SlashCommand) => void;
  commands: SlashCommand[];
  loading: boolean;
  footerLabel: string;
}) {
  const trigger = useSyncExternalStore(store.subscribe, store.get);
  return (
    <Picker
      ref={pickerRef}
      open={trigger !== null}
      query={trigger?.query ?? ""}
      anchor={trigger?.anchor ?? null}
      onClose={() => store.set(null)}
      {...rest}
    />
  );
});
