// Attachment paths and image aspect ratios, cached per file id.
//
// Two caches with the same lifetime, both bounded FIFO in the idiom
// `knowledge/lib/cover-url-cache.ts` established — an unbounded Map in a
// long-lived panel is a leak, and a chat transcript can scroll past thousands
// of attachments in a session.
//
// The in-flight map is not an optimisation: two mounts of the same image (a
// re-render, or the same file posted twice) previously fired two downloads for
// one file because the only guard was "is it already in the cache", which is
// false until the first one lands.

import { comms } from "./comms-api";

/** Bounded either way — attachments are immutable, so eviction only costs a
 *  re-fetch of something already on disk in Rust's own cache. */
const CAP = 64;

const paths = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
/** width / height, learned from the first successful decode. */
const ratios = new Map<string, number>();

function remember<V>(map: Map<string, V>, key: string, value: V): V {
  if (map.size >= CAP) {
    // Maps iterate in insertion order, so the first key is the oldest.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
  return value;
}

/** The local path for an attachment, downloading it once if needed. */
export function attachmentPath(fileId: string, filename: string): Promise<string> {
  const cached = paths.get(fileId);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(fileId);
  if (pending) return pending;

  const request = comms
    .fetchAttachment(fileId, filename)
    .then((path) => {
      remember(paths, fileId, path);
      return path;
    })
    .finally(() => {
      inFlight.delete(fileId);
    });

  inFlight.set(fileId, request);
  return request;
}

/** Synchronous peek, so a re-render paints without a flash of placeholder. */
export function cachedAttachmentPath(fileId: string): string | undefined {
  return paths.get(fileId);
}

/**
 * The aspect ratio of an image, once it has decoded once.
 *
 * Nothing on the wire carries dimensions — `ChatAttachment` is
 * `{id, filename, content_type, bytes}` — so the first render of an image has
 * to guess its height. Remembering the ratio means every render after that one
 * reserves exactly the right box, which is what stops the transcript jumping
 * when a scrolled-away image remounts.
 */
export function rememberRatio(fileId: string, width: number, height: number): void {
  if (width > 0 && height > 0) remember(ratios, fileId, width / height);
}

export function cachedRatio(fileId: string): number | undefined {
  return ratios.get(fileId);
}
