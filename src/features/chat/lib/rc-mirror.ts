/**
 * Keeps `rc-store` in step with Rust: one `atlas:rc` listener for the life of
 * the window, seeded from `rc_status` so a reload mid-room still shows it.
 *
 * Installed lazily by the first header that wants it rather than at boot:
 * nothing here matters until somebody looks at a chat. Idempotent.
 */

import { rc } from "./rc-api";
import { useRcStore } from "../stores/rc-store";

let installed = false;

export function ensureRcMirror(): void {
  if (installed) return;
  installed = true;
  const { upsert, seed } = useRcStore.getState().actions;
  // Listen first, then seed: a change that lands between the two is applied
  // by the listener and then confirmed by the seed, never lost.
  void rc
    .listen(upsert)
    .then(() => rc.status())
    .then(seed)
    .catch((e) => {
      installed = false;
      console.warn("[rc] could not mirror remote-control state", e);
    });
}
