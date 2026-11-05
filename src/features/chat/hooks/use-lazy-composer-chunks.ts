import { useEffect, useState } from "react";
import type { ChatInput as ChatInputComponent } from "../components/chat-input";
import type { MentionPicker as MentionPickerComponent } from "@/features/mentions/components/mention-picker";
import type { SlashCommandPicker as SlashCommandPickerComponent } from "../components/slash-command-picker";

// `ChatInput` pulls in Tiptap and ProseMirror (the shared composer core).
// We import it dynamically so the chunk is not in the initial preload set.
// The import is kicked off at module-evaluation time (below, outside the
// component) so the chunk starts downloading the moment this module is
// reached in the import graph — *before* MessageInput even mounts. Until
// the chunk resolves the composer renders a same-sized empty placeholder
// so the panel doesn't reflow when the editor lands.
//
// `MentionPicker` only mounts when the user types `@`, so we let its chunk
// load purely on demand — no eager preload (that would add a wasted Vite
// roundtrip in dev for every MessageInput mount).

// Start the editor chunk download at module-evaluation time. Vite still
// excludes it from `<link rel="modulepreload">` because the static analysis
// only sees a dynamic `import()`. The promise is reused by every MessageInput
// instance.
const chatInputPromise: Promise<typeof import("../components/chat-input")> =
  import("../components/chat-input");
const mentionPickerPromise: Promise<
  typeof import("@/features/mentions/components/mention-picker")
> = import("@/features/mentions/components/mention-picker");
const slashCommandPickerPromise: Promise<typeof import("../components/slash-command-picker")> =
  import("../components/slash-command-picker");

export function useLazyComposerChunks() {
  // The editor chunk started downloading at module-eval time (see the top of this
  // file). Mirror the resolution into component state so React re-renders
  // once the component class is available. We never render a textarea
  // fallback — instead the placeholder div below holds the layout slot at
  // the same height so the swap is invisible (no reflow, no mount/unmount
  // of an interactive element mid-typing).
  const [LazyChatInput, setLazyChatInput] = useState<typeof ChatInputComponent | null>(null);
  const [LazyMentionPicker, setLazyMentionPicker] = useState<typeof MentionPickerComponent | null>(
    null,
  );
  const [LazySlashPicker, setLazySlashPicker] = useState<typeof SlashCommandPickerComponent | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void chatInputPromise.then((m) => {
      if (!cancelled) setLazyChatInput(() => m.ChatInput);
    });
    void mentionPickerPromise.then((m) => {
      if (!cancelled) setLazyMentionPicker(() => m.MentionPicker);
    });
    void slashCommandPickerPromise.then((m) => {
      if (!cancelled) setLazySlashPicker(() => m.SlashCommandPicker);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { LazyChatInput, LazyMentionPicker, LazySlashPicker };
}
