// The language label and Copy button on a code fence in cached markdown
// (`CachedMarkdown` portals one into each `pre`; see `codeActions` there).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "@tryatlas/design";
import { copyText } from "@/lib/clipboard";

export interface CodeActionsContext {
  /** The fence's language, or null for `text`, `plaintext` or none. */
  lang: string | null;
  /** The fence's code as it is when called: read at click time. */
  getText: () => string;
}

/** How long Copy shows its tick. */
const COPIED_MS = 1200;

export function CodeActions({ lang, getText }: CodeActionsContext): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    // `copyText` is the WKWebView-safe path; the tick shows only when the
    // write landed, never for a copy that silently failed.
    if (!(await copyText(getText()))) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <>
      {lang && <span className="font-mono text-2xs text-muted-foreground uppercase">{lang}</span>}
      <IconButton
        icon={copied ? Check : Copy}
        label="Copy code"
        size="xs"
        onClick={() => void copy()}
      />
    </>
  );
}

/** The default `codeActions`: one `CodeActions` per fence. */
export function renderCodeActions(ctx: CodeActionsContext): ReactNode {
  return <CodeActions lang={ctx.lang} getText={ctx.getText} />;
}
