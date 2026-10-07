/**
 * A comment body as a person edits it, and back.
 *
 * Stored bodies carry mentions as `<@user-id>` — the token the server parses
 * mentions from. Handing that to someone to edit would put raw ids in the box,
 * so an edit opens with `@Name` instead and is turned back into tokens on save.
 * The same two steps the web's comment composer takes (`toDisplay` / `toWire`
 * in `apps/web/src/components/session/comments.tsx`), so an edit made on either
 * client keeps the other's mentions intact.
 */

import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

/**
 * `<@id>` → `@Name`. An id the roster cannot name stays a token, and so does
 * one whose name another member shares: `@Sam` would come back as whichever
 * Sam {@link toWireBody} met first, re-pointing the mention at someone else.
 */
export function toEditable(body: string, directory: OrgDirectory): string {
  const holders = new Map<string, number>();
  for (const m of directory.byId.values()) {
    if (m.name) holders.set(m.name, (holders.get(m.name) ?? 0) + 1);
  }
  return body.replace(/<@([^>\s]+)>/g, (whole, id: string) => {
    const name = directory.byId.get(id)?.name;
    return name && holders.get(name) === 1 ? `@${name}` : whole;
  });
}

/**
 * `@Name` → `<@id>`, longest names first so "Ada Lovelace" wins over "Ada".
 * Only names in the roster convert; anything else after an `@` stays text and
 * mentions nobody.
 */
export function toWireBody(text: string, directory: OrgDirectory): string {
  const holders = new Map<string, number>();
  for (const m of directory.byId.values()) {
    if (m.name) holders.set(m.name, (holders.get(m.name) ?? 0) + 1);
  }
  // A name two members share names neither: it stays text.
  const people = [...directory.byId.entries()]
    .filter(([, m]) => m.name && holders.get(m.name) === 1)
    .sort((a, b) => b[1].name.length - a[1].name.length);
  let out = text;
  for (const [id, m] of people) {
    const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(^|[^\\w<])@${escaped}(?![\\w])`, "g"),
      (_match, lead: string) => `${lead}<@${id}>`,
    );
  }
  return out;
}
