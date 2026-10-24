import { useState } from "react";
import { Input, type InputProps } from "@/ui/input";

/**
 * A masked field for a secret that is already stored somewhere else.
 *
 * It never holds the stored value: the field is always the replacement draft,
 * and `configured` only changes the placeholder to say one exists. A draft is
 * handed to `onCommit` on Enter or when the field loses focus, then cleared;
 * Escape drops it. An empty draft commits nothing, so tabbing through a row
 * can't erase a key.
 */
export interface SecretInputProps extends Omit<
  InputProps,
  "type" | "value" | "defaultValue" | "onChange" | "autoComplete"
> {
  configured?: boolean;
  onCommit: (value: string) => void;
}

export function SecretInput({
  configured = false,
  placeholder,
  onCommit,
  onBlur,
  onKeyDown,
  ...props
}: SecretInputProps) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    onCommit(value);
  };
  return (
    <Input
      {...props}
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={draft}
      placeholder={configured ? "Stored. Type to replace" : (placeholder ?? "Not set")}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        commit();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape" && draft) {
          event.preventDefault();
          event.stopPropagation();
          setDraft("");
        }
        onKeyDown?.(event);
      }}
    />
  );
}
