// The items of a linked pull request's menu: Open, Open on GitHub, Copy
// link, Watch / Stop watching, Unlink from this session. One list, drawn as
// a dropdown (the row's ⋯) or a context menu (a right-click), so the two
// never drift apart. The caller supplies the item and separator components
// of whichever menu it is in.

import type { ComponentType, ReactNode } from "react";
import { ArrowUpRight, Eye, EyeOff, GitPullRequest, Link, Unlink } from "lucide-react";

import type { PullRequestLink } from "@/features/chat/lib/history-api";

import {
  canWatch,
  copySessionLink,
  openLinkOnHost,
  setSessionLinkWatching,
  unlinkSessionLink,
} from "../lib/session-pull-request-actions";

interface MenuParts {
  Item: ComponentType<{ onClick?: () => void; children: ReactNode }>;
  Separator: ComponentType;
}

export function SessionPullRequestMenuItems({
  Item,
  Separator,
  threadId,
  link,
  onOpen,
}: MenuParts & {
  threadId: string;
  link: PullRequestLink;
  /** Open it in Atlas (a tab, or the host when no checkout is its). */
  onOpen: () => void;
}) {
  const watchable = canWatch(link);
  return (
    <>
      <Item onClick={onOpen}>
        <GitPullRequest aria-hidden />
        Open #{link.number}
      </Item>
      <Item onClick={() => openLinkOnHost(link)}>
        <ArrowUpRight aria-hidden />
        Open on GitHub
      </Item>
      <Item onClick={() => void copySessionLink(link)}>
        <Link aria-hidden />
        Copy link
      </Item>
      <Separator />
      {link.watching || watchable ? (
        <Item onClick={() => void setSessionLinkWatching(threadId, link, !link.watching)}>
          {link.watching ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {link.watching ? "Stop watching" : "Watch for changes"}
        </Item>
      ) : null}
      <Item onClick={() => void unlinkSessionLink(threadId, link)}>
        <Unlink aria-hidden />
        Unlink from this session
      </Item>
    </>
  );
}
