/**
 * Where organisation calls reach the Logs panel. Mounted once at app level,
 * beside the UI action bridge and for the same reason: a call is audited
 * whether or not the calling session's tab is visible. Rust broadcasts each
 * record; the window that shows the session writes its row (the UI actions'
 * ownership rule), so a second window never logs it twice.
 */

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ownsUiActionRequest } from "@/features/ui-actions/lib/ownership";
import { listenOrgAction } from "../lib/org-actions-api";
import { logOrgAction } from "../lib/org-action-log";

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

export function OrgActionLogBridge() {
  useEffect(() => {
    const unlisten = listenOrgAction((record) => {
      if (ownsUiActionRequest(record, windowLabel())) logOrgAction(record);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
  return null;
}
