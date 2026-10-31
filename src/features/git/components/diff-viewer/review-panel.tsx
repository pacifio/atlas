import { DiffPanel } from "./diff-panel";

/**
 * The review surface beside the session: the diff, read rather than signed
 * off, so with no "Viewed" marks. The project's files are a surface of their
 * own (`files`), opened from ⌘T or the command palette.
 */
export interface ReviewPanelProps {
  tabId: string;
  repoPath: string;
  sessionId?: string | null;
}

export function ReviewPanel({ tabId, repoPath, sessionId = null }: ReviewPanelProps) {
  return <DiffPanel tabId={tabId} repoPath={repoPath} sessionId={sessionId} />;
}
