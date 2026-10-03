// Which data profile the backend runs under — the released app's, or the
// separate one `bun run dev:app` uses so a source build never touches the
// installed Atlas's data (`crates/atlas-profile`). Rust derives it from the
// bundle identifier the binary was built with, so the window asks instead of
// guessing from its own build mode: `import.meta.env.DEV` is true for any
// `tauri dev`, profile or not.
//
// The window only needs it for names: the title ("Atlas Dev") and copy that
// spells out Atlas's directory (`.atlas-dev/repos/`). Every path is still
// resolved in Rust.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors `AppProfile` in `src-tauri/src/commands/app_state.rs`. */
export interface AppProfile {
  dev: boolean;
  productName: string;
  dirName: string;
}

/** What a released build always is, and what the window shows until the
 *  backend answers (or when there is no backend to ask). */
export const DEFAULT_APP_PROFILE: AppProfile = {
  dev: false,
  productName: "Atlas",
  dirName: ".atlas",
};

function isAppProfile(value: unknown): value is AppProfile {
  const v = value as Partial<AppProfile> | null | undefined;
  return (
    typeof v?.dev === "boolean" &&
    typeof v.productName === "string" &&
    typeof v.dirName === "string"
  );
}

let pending: Promise<AppProfile> | null = null;

/** The profile, asked for once per window — it cannot change while the
 *  process runs. Falls back to the default rather than failing: a wrong
 *  title is better than no title. */
export function loadAppProfile(): Promise<AppProfile> {
  pending ??= Promise.resolve()
    .then(() => invoke<unknown>("app_profile"))
    .then((p) => (isAppProfile(p) ? p : DEFAULT_APP_PROFILE))
    .catch(() => DEFAULT_APP_PROFILE);
  return pending;
}

/** The profile for rendering: the default on the first frame, the backend's
 *  answer from then on. */
export function useAppProfile(): AppProfile {
  const [profile, setProfile] = useState(DEFAULT_APP_PROFILE);
  useEffect(() => {
    let live = true;
    void loadAppProfile().then((p) => {
      if (live) setProfile(p);
    });
    return () => {
      live = false;
    };
  }, []);
  return profile;
}
