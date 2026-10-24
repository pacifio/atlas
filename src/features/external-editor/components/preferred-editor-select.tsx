// Settings ▸ General ▸ Files ▸ Preferred editor: the detected editors only,
// with "Automatic" (the first one found) on top, and a button to probe again
// after installing one.

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Select, type SelectOption } from "@/ui/select";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { useScopedSetting } from "@/features/settings/lib/use-scoped-setting";
import { useExternalEditorStore } from "../stores/external-editor-store";
import type { ExternalEditor } from "../lib/external-editor-api";
import { editorName, usePreferredEditor } from "../lib/preferred-editor";

/** The select's options: Automatic (naming what it resolves to), every
 *  detected editor, and a saved id that is no longer installed, marked, so
 *  the select still shows what the file says. */
export function preferredEditorOptions(
  editors: readonly ExternalEditor[] | null,
  saved: string,
): SelectOption<string>[] {
  const first = editors?.[0] ?? null;
  const options: SelectOption<string>[] = [
    { value: "", label: first ? `Automatic (${editorName(first)})` : "Automatic" },
    ...(editors ?? []).map((e) => ({ value: e.id, label: editorName(e) })),
  ];
  if (saved && editors && !editors.some((e) => e.id === saved)) {
    options.push({ value: saved, label: `${saved} (not installed)` });
  }
  return options;
}

export function PreferredEditorSelect() {
  const scoped = useScopedSetting("preferredEditor");
  const { editors } = usePreferredEditor();
  const [probing, setProbing] = useState(false);
  const refresh = () => {
    setProbing(true);
    void useExternalEditorStore
      .getState()
      .actions.load(true)
      .finally(() => setProbing(false));
  };
  return (
    <div className="flex items-center gap-1">
      <Select
        value={scoped.value}
        options={preferredEditorOptions(editors, scoped.value)}
        disabled={scoped.globalOnly || !editors}
        aria-label="Files: Preferred editor"
        onValueChange={(next) => scoped.set(next)}
      />
      <Hint label="Look for installed editors again">
        <IconButton
          icon={RefreshCw}
          size="sm"
          label="Look for installed editors again"
          disabled={probing}
          onClick={refresh}
        />
      </Hint>
    </div>
  );
}
