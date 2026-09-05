// Markdown parse worker. Runs the remark/rehype/highlight/sanitize pipeline
// off the main thread so a large, code-heavy chat answer never blocks the
// chat composer's keystrokes (the parse is a long synchronous task — see
// `feedback-chat-input-idle-lag`). The main thread posts `{ id, source }` and
// gets back `{ id, html }`; correlation + caching live in `markdown-cache.tsx`.
//
// `self` is typed manually rather than via the `webworker` lib to avoid
// conflicting with the DOM lib in the project's single tsconfig.

import { parseMarkdown } from "./markdown-render";

interface ParseRequest {
  id: number;
  source: string;
}
interface ParseResponse {
  id: number;
  html: string;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ParseRequest>) => void) | null;
  postMessage: (msg: ParseResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, source } = e.data;
  ctx.postMessage({ id, html: parseMarkdown(source) });
};
