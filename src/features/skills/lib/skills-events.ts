// Lightweight app-wide signal that the skills/packs on-disk state changed
// (install, projection, adopt, delete, …). The chat reference picker listens
// for this and refetches so freshly installed skills/components appear without
// a remount. Mirrors the knowledge mention self-heal approach.

export const SKILLS_CHANGED_EVENT = "atlas:skills-changed";

function emitSkillsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
  }
}

/** Wrap a mutating skills/packs promise so it fires `atlas:skills-changed` on
 *  success. Pass-through on the resolved value; never swallows rejections. */
export function afterSkillMutation<T>(p: Promise<T>): Promise<T> {
  return p.then((r) => {
    emitSkillsChanged();
    return r;
  });
}
