import { useEffect } from "react";
import { useTipsStore } from "../stores/tips-store";

/** Ask for tip `id` the first time this component mounts with `when` true —
 *  how a place says "the user has reached me". Seen tips are ignored by the
 *  store, so mounting again costs nothing. */
export function useTipOnMount(id: string, when = true): void {
  useEffect(() => {
    if (when) useTipsStore.getState().actions.request(id);
  }, [id, when]);
}
