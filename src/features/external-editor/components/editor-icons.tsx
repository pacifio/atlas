// The editors' own marks, for "Open in <editor>" rows. A recoloured logo is
// the wrong logo, so the marks that have a colour keep it (this file is in
// the design-system ratchet's EXEMPT_FILES on that argument); the
// monochrome ones draw in `currentColor` and follow the theme.
//
// Only the editors Atlas detects most often have a mark here. Any other id —
// a JetBrains IDE, Sublime, Xcode — gets the generic "open externally" glyph.

import { useId, type SVGProps } from "react";
import { SquareArrowOutUpRight } from "lucide-react";

import { cn } from "@/lib/utils";

type MarkProps = SVGProps<SVGSVGElement>;

function VisualStudioCodeMark(props: MarkProps) {
  const id = useId();
  const maskId = `${id}-vscode-mask`;
  return (
    <svg {...props} fill="none" viewBox="0 0 100 100" aria-hidden>
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <path
          fill="#007ACC"
          d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
        />
        <path
          fill="#1F9CF0"
          d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
        />
      </g>
    </svg>
  );
}

function VSCodiumMark(props: MarkProps) {
  const id = useId();
  const gradientId = `${id}-vscodium-gradient`;
  return (
    <svg {...props} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          x2="100"
          y1="0"
          y2="100"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#62A0EA" />
          <stop offset="1" stopColor="#1A5FB4" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M48.26 2.274C45.406 4.105 44.583 7.898 46.422 10.742C56.531 26.397 58.917 38.205 57.882 48.553C53.698 68.369 44.603 72.389 36.655 72.389C28.895 72.389 30.973 59.618 36.806 55.88C40.288 53.706 44.748 52.293 48.171 52.293C51.563 52.293 54.313 49.552 54.313 46.17C54.313 42.787 51.563 40.046 48.171 40.046C44.173 40.046 40.251 40.886 36.59 42.316C37.338 38.787 37.614 34.973 36.647 30.919C35.179 24.763 30.953 18.883 23.615 13.183C22.33 12.183 20.7 11.734 19.083 11.934C17.466 12.134 15.995 12.966 14.994 14.248C12.912 16.918 13.394 20.766 16.072 22.843C22.05 27.486 24.024 30.923 24.699 33.752C25.374 36.581 24.831 39.616 23.475 43.786C21.742 49.406 19.73 54.423 18.848 59.234C18.414 61.602 18.377 64.179 18.265 66.238C13.96 62.042 12.275 56.502 12.275 48.407C12.274 45.025 9.524 42.283 6.133 42.284C2.744 42.287-0.002 45.027-0.003 48.407C-0.003 59.463 3.23 69.983 11.895 77.001C19.739 84.474 39.686 81.712 39.686 93.709C39.686 97.095 44.642 98.743 48.033 98.743C51.511 98.743 55.888 96.418 55.888 93.709C55.888 80.097 70.233 71.824 93.848 71.86C97.24 71.865 99.992 69.126 99.997 65.744C100.003 62.361 97.259 59.614 93.867 59.608C92.252 59.606 90.678 59.661 89.126 59.753C91.766 53.544 92.937 46.708 92.695 39.324C92.583 35.943 89.745 33.293 86.356 33.403C82.963 33.513 80.305 36.346 80.416 39.729C80.736 49.397 80.374 58.03 73.171 62.581C71.123 63.874 68.742 64.996 66.484 64.996C68.237 60.228 69.561 55.195 70.103 49.77C70.449 46.308 70.486 42.195 70.091 39C69.478 34.05 68.738 28.436 70.617 24.207C72.305 20.565 76.087 19.04 81.64 19.04C85.029 19.037 87.775 16.296 87.776 12.917C87.778 9.534 85.031 6.79 81.64 6.787C73.388 6.787 67.133 11.13 63.587 16.377C61.733 12.417 59.475 8.336 56.747 4.112C55.866 2.747 54.478 1.788 52.887 1.443C52.099 1.272 51.285 1.257 50.491 1.399C49.697 1.542 48.939 1.839 48.26 2.274z"
      />
    </svg>
  );
}

function CursorMark({ className, ...props }: MarkProps) {
  return (
    <svg
      {...props}
      viewBox="0 0 466.73 532.09"
      className={cn("fill-current", className)}
      aria-hidden
    >
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  );
}

function ZedMark(props: MarkProps) {
  return (
    <svg {...props} fill="none" viewBox="0 0 96 96" aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.379c4.009 0 6.016 4.847 3.182 7.682L43.055 57.187H57V51h6v7.688a4.5 4.5 0 0 1-4.5 4.5H37.055L26.743 73.5H73.5V36h6v37.5a6 6 0 0 1-6 6H20.743L10.243 90H87a3 3 0 0 0 3-3V21h6v66a9 9 0 0 1-9 9H6.621c-4.009 0-6.016-4.847-3.182-7.682L52.757 39H39v6h-6v-7.5a4.5 4.5 0 0 1 4.5-4.5h21.257l10.5-10.5H22.5V60h-6V22.5a6 6 0 0 1 6-6h52.757L85.757 6H9Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const MARKS: Record<string, (props: MarkProps) => React.ReactElement> = {
  vscode: VisualStudioCodeMark,
  "vscode-insiders": VisualStudioCodeMark,
  vscodium: VSCodiumMark,
  cursor: CursorMark,
  zed: ZedMark,
};

/** The mark for editor `id`, or the generic glyph for one without a mark. */
export function EditorIcon({ id, className }: { id: string; className?: string }) {
  const Mark = MARKS[id];
  if (!Mark) {
    return (
      <SquareArrowOutUpRight
        size={14}
        className={cn("shrink-0 text-muted-foreground", className)}
        aria-hidden
      />
    );
  }
  // 14px like the fallback glyph: `size-3.5` is rem, and the root is 13px.
  return <Mark className={cn("size-[14px] shrink-0", className)} />;
}
