/** Active annotation tool. `none` = read/select (PDF stays interactive). */
export type PdfTool = "none" | "highlight" | "pencil" | "note" | "erase";

/** All geometry is normalized to 0..1 of the page, so annotations stay
 *  anchored across zoom/scroll regardless of the rendered pixel size. */
export interface Point {
  x: number;
  y: number;
}

interface Base {
  id: string;
  page: number;
  color: string;
  createdAt: string;
}
export interface HighlightAnnotation extends Base {
  kind: "highlight";
  rect: { x: number; y: number; w: number; h: number };
}
export interface PencilAnnotation extends Base {
  kind: "pencil";
  points: Point[];
}
export interface NoteAnnotation extends Base {
  kind: "note";
  x: number;
  y: number;
  text: string;
}
export type PdfAnnotation = HighlightAnnotation | PencilAnnotation | NoteAnnotation;

/**
 * The inks a user picks from. `id` is what gets written into the annotation's
 * `color` (`.atlas/pdf-annotations.json`), so it must never change: saved
 * annotations, the mock seed and older builds all read it back as-is. It is
 * also the paint, because annotations sit on the PDF page, which is paper and
 * stays outside the theme (decision 3).
 */
export const PDF_SWATCHES = [
  { id: "#F5C542", label: "Amber" }, // highlight default
  { id: "#6796E6", label: "Blue" },
  { id: "#5CC28A", label: "Green" },
  { id: "#F44747", label: "Red" },
  { id: "#C4A5E7", label: "Purple" },
] as const;

/** Swatch ids — colors that read on white pages. */
export const PDF_COLORS: readonly string[] = PDF_SWATCHES.map((s) => s.id);

export function newAnnotationId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
