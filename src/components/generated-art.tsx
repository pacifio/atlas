/**
 * Atlas's generated identity art — a field of dots over a gradient (see
 * `lib/generated-art.ts`) — for anything that has an identity but no picture.
 *
 * In this app that is one thing: a guest who commented on a shared Session.
 * They have no account, so there is no face to show and no initials worth
 * showing either — a guest called "Guest 1" would be a grey "G" next to every
 * other grey "G". The art is distinct per guest and stable forever, so two
 * guests on one thread are told apart at a glance.
 *
 * The same seed draws the same art everywhere. It fills its box; the caller
 * gives it a shape.
 */

import { memo, useId, useMemo } from "react";
import { ART_BOX, generatedArt } from "@/lib/generated-art";

/**
 * The art is an image, not a surface: its colours are its own in both themes,
 * like a photo, so its white stays white.
 */
// ratchet-allow: generated art whose ink is fixed in both themes, like a photo
const INK = "#fff";

/** Memoized: a few dozen circles per mark, and a list row holding one is
 *  re-rendered by its virtualizer on every scroll frame. */
export const GeneratedArt = memo(function GeneratedArt({ seed }: { seed: string }) {
  const art = useMemo(() => generatedArt(seed), [seed]);
  // Gradient ids are document-global; two marks for one seed on one page must
  // not share — and fight over — a definition.
  const uid = useId().replace(/:/g, "");
  const fill = `art-fill-${uid}`;
  const glow = `art-glow-${uid}`;
  const half = ART_BOX / 2;

  return (
    <svg
      viewBox={`0 0 ${ART_BOX} ${ART_BOX}`}
      className="size-full"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <linearGradient
          id={fill}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1={half}
          x2={ART_BOX}
          y2={half}
          gradientTransform={`rotate(${art.angle} ${half} ${half})`}
        >
          <stop offset="0" stopColor={art.stops[0]} />
          <stop offset="0.55" stopColor={art.stops[1]} />
          <stop offset="1" stopColor={art.stops[2]} />
        </linearGradient>
        <radialGradient
          id={glow}
          gradientUnits="userSpaceOnUse"
          cx={art.glow.x}
          cy={art.glow.y}
          r={ART_BOX * 0.7}
        >
          <stop offset="0" stopColor={INK} stopOpacity="0.38" />
          <stop offset="1" stopColor={INK} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={ART_BOX} height={ART_BOX} fill={`url(#${fill})`} />
      <rect width={ART_BOX} height={ART_BOX} fill={`url(#${glow})`} />
      <g fill={INK}>
        {art.dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} fillOpacity={d.o} />
        ))}
      </g>
    </svg>
  );
});
