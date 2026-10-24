/**
 * Where to scroll so a revealed line sits in the middle of the file view.
 *
 * The viewer virtualizes, so before the line is mounted only its estimated
 * position is known; once it renders, its real geometry corrects the
 * estimate. Clamped to the scroll range, so a line near either end is shown
 * as far toward the middle as the file allows.
 */

interface LineGeometry {
  readonly top: number;
  readonly height: number;
}

interface CenteredFileLineScrollInput {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly fileTop: number;
  readonly estimatedLine: LineGeometry;
  readonly renderedLine?: LineGeometry;
}

export function resolveCenteredFileLineScrollTop(input: CenteredFileLineScrollInput): number {
  const lineTop =
    input.renderedLine === undefined
      ? input.fileTop + input.estimatedLine.top
      : input.scrollTop + input.renderedLine.top - input.viewportTop;
  const lineHeight = input.renderedLine?.height ?? input.estimatedLine.height;
  const centeredTop = Math.max(0, lineTop - Math.max(0, (input.viewportHeight - lineHeight) / 2));
  return Math.min(centeredTop, Math.max(0, input.scrollHeight - input.viewportHeight));
}

/** `requestedLine` clamped to the lines `contents` has (`\n`, `\r\n` or `\r`). */
export function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}
