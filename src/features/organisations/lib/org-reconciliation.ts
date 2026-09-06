/**
 * Has the desktop's active organisation been pushed to Rust this launch?
 *
 * Two things push it: the one-shot boot reconciliation in `App.tsx` (the org
 * store hydrates from disk long before the credential is confirmed, so the
 * push waits for sign-in) and every explicit `switchOrg`. They used to be
 * independent, and the boot push is fire-and-forget — so a user who clicked
 * an org while the launch revalidate was still settling could have the boot
 * push land AFTER the switch's, re-pointing the chat socket at the org they
 * had just left. A switch now marks reconciliation done, and the boot effect
 * checks here rather than only its own ref.
 */
let done = false;

export function markOrgReconciled(): void {
  done = true;
}

export function isOrgReconciled(): boolean {
  return done;
}
