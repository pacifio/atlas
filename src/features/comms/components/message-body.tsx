// The message body's container: it owns the opener, so the view and the lazy
// markdown pipeline (`./message-body-impl`) import nothing from `@tauri-apps/*`.
// The rendering, and why it is its own pipeline, is `./views/message-body-view`.

import { memo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MessageBodyView } from "./views/message-body-view";
import type { OrgMemberProfile } from "../types";

export { primeCommsMarkdown } from "./views/message-body-view";

/** Module-level, so the view's memo and its directory hold across renders.
 *  A webview must hand a url to the system browser, not load it in place. */
const openExternal = (url: string) => void openUrl(url).catch(() => {});

export const MessageBody = memo(function MessageBody({
  body,
  members,
  me,
  className,
}: {
  body: string;
  members: Map<string, OrgMemberProfile>;
  /** The current user — a mention of them is styled differently. */
  me: string;
  className?: string;
}) {
  return (
    <MessageBodyView
      body={body}
      members={members}
      me={me}
      onOpenLink={openExternal}
      className={className}
    />
  );
});
