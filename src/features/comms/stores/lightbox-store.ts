// The one media lightbox for the comms panel.
//
// Every image used to own a `MediaLightbox` instance, which is why there was
// no "next": a lightbox that knows only its own file cannot walk to the
// neighbour's. Now there is one instance, mounted once in the panel, and the
// thing that opens it hands over the whole list plus a starting index.

import { create } from "zustand";
import { useCommsStore } from "./comms-store";
import type { ChatAttachment } from "../types";

export interface LightboxItem {
  /** Attachment (file) id — also the key for the path/ratio caches. */
  id: string;
  filename: string;
  kind: "image" | "video";
}

interface LightboxState {
  open: boolean;
  items: LightboxItem[];
  index: number;
  actions: {
    show: (items: LightboxItem[], index: number) => void;
    goTo: (index: number) => void;
    close: () => void;
  };
}

export const useLightboxStore = create<LightboxState>((set, get) => ({
  open: false,
  items: [],
  index: 0,
  actions: {
    show: (items, index) => {
      if (items.length === 0) return;
      set({ open: true, items, index: Math.min(Math.max(index, 0), items.length - 1) });
    },
    goTo: (index) => {
      const n = get().items.length;
      if (n === 0) return;
      set({ index: Math.min(Math.max(index, 0), n - 1) });
    },
    close: () => set({ open: false }),
  },
}));

export function mediaKindOf(a: ChatAttachment): LightboxItem["kind"] | null {
  if (a.content_type.startsWith("image/")) return "image";
  if (a.content_type.startsWith("video/")) return "video";
  return null;
}

export function toLightboxItem(a: ChatAttachment): LightboxItem | null {
  const kind = mediaKindOf(a);
  return kind ? { id: a.id, filename: a.filename, kind } : null;
}

/**
 * Open the lightbox on `attachmentId`, with every image/video in the
 * conversation's loaded transcript as the gallery, oldest first. Built at
 * click time from the store: a transcript changes far more often than anyone
 * opens a picture, so nothing is kept in sync between clicks.
 */
export function openConversationMedia(convId: string, attachmentId: string): void {
  const messages = useCommsStore.getState().messages[convId] ?? [];
  const items: LightboxItem[] = [];
  for (const m of messages) {
    if (m.deleted) continue;
    for (const a of m.attachments) {
      const item = toLightboxItem(a);
      if (item) items.push(item);
    }
  }
  const index = items.findIndex((i) => i.id === attachmentId);
  useLightboxStore.getState().actions.show(items, index === -1 ? 0 : index);
}

/** Open the lightbox on an explicit list (the Files tab's own ordering). */
export function openMediaList(items: LightboxItem[], attachmentId: string): void {
  const index = items.findIndex((i) => i.id === attachmentId);
  useLightboxStore.getState().actions.show(items, index === -1 ? 0 : index);
}
