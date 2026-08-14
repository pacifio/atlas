import type { SVGProps } from "react";

/**
 * Brand icons for the coding agents Atlas integrates. Each is a self-contained
 * `<svg>` primitive sized at `1em` by default (override via `className`, e.g.
 * `className="size-4"`). Grouped under `AgentIcons` for ergonomic imports:
 *   <AgentIcons.Claude /> · <AgentIcons.Codex />
 */

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

/** Anthropic Claude Code mark (monochrome — inherits `currentColor`). */
export function ClaudeIcon({ title = "Claude Code", ...props }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  );
}

/** OpenAI Codex mark (inherits `currentColor`). */
export function CodexIcon({ title = "Codex", ...props }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

/** OpenCode brand mark (official dark-variant logo — fixed brand fills, not
 *  `currentColor`; the 240×300 viewBox letterboxes inside the square em box). */
export function OpenCodeIcon({ title = "OpenCode", ...props }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 240 300"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path d="M180 240H60V120H180V240Z" fill="#4B4646" />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#F1ECEC" />
    </svg>
  );
}

/** Cursor brand mark (official 2.5D cube — fixed brand fills, not
 *  `currentColor`; the 466.73×533.32 viewBox letterboxes in the square em box). */
export function CursorIcon({ title = "Cursor", ...props }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 466.73 533.32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path
        fill="#72716d"
        d="M233.37,266.66l231.16,133.46c-1.42,2.46-3.48,4.56-6.03,6.03l-216.06,124.74c-5.61,3.24-12.53,3.24-18.14,0L8.24,406.15c-2.55-1.47-4.61-3.57-6.03-6.03l231.16-133.46h0Z"
      />
      <path
        fill="#55544f"
        d="M233.37,0v266.66L2.21,400.12c-1.42-2.46-2.21-5.3-2.21-8.24v-250.44c0-5.89,3.14-11.32,8.24-14.27L224.29,2.43c2.81-1.62,5.94-2.43,9.07-2.43h.01Z"
      />
      <path
        fill="#43413c"
        d="M464.52,133.2c-1.42-2.46-3.48-4.56-6.03-6.03L242.43,2.43c-2.8-1.62-5.93-2.43-9.06-2.43v266.66l231.16,133.46c1.42-2.46,2.21-5.3,2.21-8.24v-250.44c0-2.95-.78-5.77-2.21-8.24h-.01Z"
      />
      <path
        fill="#d6d5d2"
        d="M448.35,142.54c1.31,2.26,1.49,5.16,0,7.74l-209.83,363.42c-1.41,2.46-5.16,1.45-5.16-1.38v-239.48c0-1.91-.51-3.75-1.44-5.36l216.42-124.95h.01Z"
      />
      <path
        fill="#fff"
        d="M448.35,142.54l-216.42,124.95c-.92-1.6-2.26-2.96-3.92-3.92L20.62,143.83c-2.46-1.41-1.45-5.16,1.38-5.16h419.65c2.98,0,5.4,1.61,6.7,3.87Z"
      />
    </svg>
  );
}

/** Kilo Code mark — PLACEHOLDER bold-K glyph (inherits `currentColor`) until
 *  the official brand SVG is dropped in (same flow as Cursor's was). */
export function KiloIcon({ title = "Kilo", ...props }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path d="M5 2h4v8.2L16.6 2h5.1l-8.6 9.5L22 22h-5.1l-6.4-8.2-1.5 1.6V22H5V2z" />
    </svg>
  );
}

/** Grouped export so callers can do `<AgentIcons.Claude />` / `.Codex`. */
export const AgentIcons = {
  Claude: ClaudeIcon,
  Codex: CodexIcon,
  OpenCode: OpenCodeIcon,
  Cursor: CursorIcon,
  Kilo: KiloIcon,
};

/** Registry-installed external agent icon — the manifest's SVG delivered as a
 *  base64 data URL (asset protocol can't serve the hidden cache dir). */
export function ExternalAgentIcon({
  dataUrl,
  size = 14,
  className,
}: {
  dataUrl: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: "contain", borderRadius: 3 }}
      alt=""
      aria-hidden
    />
  );
}

/** Last-resort agent glyph: the label's initial in a monogram — replaces the
 *  old bare "?" for agents with no icon source (purged registry metadata). */
export function AgentMonogram({ label, size = 14 }: { label: string; size?: number }) {
  return (
    <span
      className="font-mono font-semibold leading-none"
      style={{ fontSize: Math.round(size * 0.72) }}
      aria-hidden
    >
      {(label.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
