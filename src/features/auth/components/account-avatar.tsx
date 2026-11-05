import { convertFileSrc } from "@tauri-apps/api/core";

import type { AccountUser } from "../lib/auth-api";
import { AccountAvatarView } from "./views/account-avatar-view";

/** A cached photo's local path as a URL the webview can load. */
export function avatarSrc(path: string | null): string | null {
  return path ? convertFileSrc(path) : null;
}

/**
 * An account's face, from the account record. The adapter in front of
 * `AccountAvatarView`: the photo is a LOCAL cache path resolved in Rust (the
 * provider URL never reaches the frontend), and only this side may turn it
 * into a webview URL.
 */
export function AccountAvatar({ user, size }: { user: AccountUser; size: number }) {
  return (
    <AccountAvatarView
      name={user.name}
      email={user.email}
      src={avatarSrc(user.avatarPath)}
      size={size}
    />
  );
}
