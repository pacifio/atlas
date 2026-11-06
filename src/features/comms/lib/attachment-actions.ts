import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { comms } from "./comms-api";
import { useCommsStore } from "../stores/comms-store";
import type { ChatAttachment } from "../types";

/** Save an attachment wherever the user wants it. */
export async function saveAttachment(attachment: ChatAttachment): Promise<void> {
  try {
    const dest = await saveFileDialog({ defaultPath: attachment.filename });
    if (!dest) return;
    await comms.saveAttachment(attachment.id, attachment.filename, dest, attachment.id);
    toast.success(`Saved ${attachment.filename}`);
  } catch (e) {
    console.warn("comms: save attachment failed:", attachment.id, e);
    toast.error("Could not save that file.");
  }
}

/**
 * Copy the attachment's canonical URL.
 *
 * NOT a public share link — this API has no such concept by design (ADR-0010
 * §3: no presigned URLs; `GET /files/{id}` answers a 302 to a ticket that dies
 * in sixty seconds). What this copies is the addressable resource, which
 * resolves for a colleague who is signed in and in the conversation, and 404s
 * for everyone else. The toast says so rather than implying a share.
 */
export async function copyAttachmentLink(attachment: ChatAttachment): Promise<void> {
  try {
    const base = await comms.baseUrl();
    const org = useCommsStore.getState().connection.orgId;
    const url = `${base}/files/${attachment.id}${org ? `?org=${org}` : ""}`;
    await copyText(url);
    toast.success("Link copied — opens for members of this conversation.");
  } catch (e) {
    console.warn("comms: copy link failed:", attachment.id, e);
    toast.error("Could not copy that link.");
  }
}
