/**
 * Take the Session out of Atlas.
 *
 * Lives in the reader's footer pill beside share and filter (`footer-pill.tsx`),
 * rather than floating in the masthead: it is an action on the open Session,
 * and the footer is where the reader keeps those.
 *
 * The container: it owns the in-flight format and runs the export. The control
 * itself is `views/export-button-view.tsx`.
 */

import { useState } from "react";

import type { SessionDetail as Detail } from "../types";
import { exportSession, type ExportFormat } from "../lib/export";
import { ExportButtonView } from "./views/export-button-view";

export function ExportButton({ detail }: { detail: Detail }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      await exportSession(detail, format);
    } finally {
      setBusy(null);
    }
  };

  return <ExportButtonView busy={busy} onPick={(format) => void run(format)} />;
}
