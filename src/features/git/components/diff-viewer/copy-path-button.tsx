import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";

/** Copy a file's repository-relative path, from its diff header. */
export function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Hint label={copied ? "Copied" : "Copy path"}>
      <IconButton
        size="xs"
        icon={copied ? Check : Copy}
        label="Copy file path"
        onClick={(event) => {
          // The header toggles its file on click; this button must not.
          event.stopPropagation();
          void copyText(path).then((ok) => setCopied(ok));
        }}
      />
    </Hint>
  );
}
