import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { GitHubMark } from "@tryatlas/design";

export { GitHubMark };

/**
 * The GitHub mark as a lucide-shaped component.
 *
 * lucide-react 1.x removed every brand icon, `Github` among them. The call
 * sites that used it want `size` in pixels and `className`, and some pass it
 * as a value into a prop typed `LucideIcon` (a `ForwardRefExoticComponent`,
 * which a plain function component is not assignable to), hence `forwardRef`.
 * The glyph is the package's `GitHubMark`; lucide's stroke props have nothing
 * to act on in a filled mark, so they are dropped.
 */
export const GithubIcon = forwardRef<SVGSVGElement, LucideProps>(function GithubIcon(
  { size = 24, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, ...props },
  ref,
) {
  return <GitHubMark ref={ref} width={size} height={size} {...props} />;
}) as LucideIcon;
