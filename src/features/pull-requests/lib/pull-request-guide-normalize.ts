// A written guide fitted to the change it describes, before it is kept.
//
// The agent's line numbers and paths are checked against the change itself
// (`pr_guide_prepare` reads it): an excerpt is clamped into the hunks it
// overlaps or dropped, excerpts that touch are merged and capped, a file that
// is not in the change is dropped, a note that points outside its stop's
// excerpts goes, and every changed file the tour does not place lands in a
// last "Other files" stop. So the tab never shows a range that is not in the
// diff, and never leaves a changed file out.

import type {
  GeneratedGuide,
  GuideChange,
  GuideExcerpt,
  GuideStop,
} from "./pull-request-guide-types";

const MAX_EXCERPT_LINES = 25;

function clampExcerpt(excerpt: GuideExcerpt, change: GuideChange): GuideExcerpt | null {
  const start = Math.min(excerpt.start, excerpt.end);
  const end = Math.max(excerpt.start, excerpt.end);
  const overlapping = (change.hunks[excerpt.path]?.[excerpt.side] ?? []).filter(
    ([hunkStart, hunkEnd]) => hunkStart <= end && start <= hunkEnd,
  );
  const first = overlapping[0];
  const last = overlapping[overlapping.length - 1];
  if (first === undefined || last === undefined) return null;
  return { ...excerpt, start: Math.max(start, first[0]), end: Math.min(end, last[1]) };
}

function mergeExcerpts(excerpts: readonly GuideExcerpt[]): GuideExcerpt[] {
  const merged: GuideExcerpt[] = [];
  for (const excerpt of excerpts) {
    const index = merged.findIndex(
      (other) =>
        other.path === excerpt.path &&
        other.side === excerpt.side &&
        other.start <= excerpt.end + 1 &&
        excerpt.start <= other.end + 1,
    );
    const other = merged[index];
    if (other === undefined) {
      merged.push(excerpt);
      continue;
    }
    merged[index] = {
      ...other,
      start: Math.min(other.start, excerpt.start),
      end: Math.max(other.end, excerpt.end),
      caption: other.caption || excerpt.caption,
    };
  }
  return merged.map((excerpt) => ({
    ...excerpt,
    end: Math.min(excerpt.end, excerpt.start + MAX_EXCERPT_LINES - 1),
  }));
}

const nonEmpty = (value: string) => value.trim() !== "";

export function normalizeGuide(guide: GeneratedGuide, change: GuideChange): GeneratedGuide {
  const changed = new Set(change.files);
  const inChange = (path: string) => changed.has(path);

  const shaped: GuideStop[] = guide.stops
    .filter((stop) => nonEmpty(stop.title))
    .map((stop) => {
      const excerpts = mergeExcerpts(
        stop.excerpts.flatMap((excerpt) => {
          const clamped = inChange(excerpt.path) ? clampExcerpt(excerpt, change) : null;
          return clamped === null ? [] : [clamped];
        }),
      );
      return {
        ...stop,
        attention: stop.attention !== null && nonEmpty(stop.attention.note) ? stop.attention : null,
        excerpts,
        files: stop.files
          .filter((file) => inChange(file.path))
          .map(({ path, note }) => (note?.trim() ? { path, note } : { path })),
        notes: stop.notes.filter(
          (note) =>
            nonEmpty(note.title) &&
            excerpts.some(
              (excerpt) =>
                excerpt.path === note.path &&
                excerpt.start <= note.line &&
                note.line <= excerpt.end,
            ),
        ),
        questions: stop.questions.filter(nonEmpty),
      };
    });

  const placed = new Set(shaped.flatMap((stop) => stop.excerpts.map((excerpt) => excerpt.path)));
  const stops = shaped.map((stop) => {
    const files = stop.files.filter((file) => !placed.has(file.path));
    for (const file of files) placed.add(file.path);
    return { ...stop, files };
  });
  const unplaced = change.files.filter((path) => !placed.has(path));
  if (unplaced.length > 0) {
    stops.push({
      title: "Other files",
      summary: "Changed files the tour does not otherwise cover.",
      attention: null,
      excerpts: [],
      files: unplaced.map((path) => ({ path })),
      notes: [],
      questions: [],
    });
  }

  return { ...guide, stops };
}
