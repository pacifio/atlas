// @vitest-environment happy-dom
// Registry icons are third-party artwork, and almost all of it is monochrome
// `currentColor` art. Rendering that in an `<img>` is a trap: the SVG is its own
// document, CSS does not cascade into it, and `currentColor` falls back to the
// initial `color` — black — so every icon vanished against Atlas's black
// surfaces. These tests pin the rule that decides between the two paths.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { ExternalAgentIcon } from "./agent-icons";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const MONOCHROME = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M0 0h24v24H0z"/></svg>',
);
const BRANDED = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#72716d" d="M0 0h24v24H0z"/></svg>',
);

describe("ExternalAgentIcon", () => {
  it("draws a currentColor icon as a mask, so it takes the surrounding text color", () => {
    const { container } = render(<ExternalAgentIcon dataUrl={MONOCHROME} size={16} />);
    const glyph = container.firstElementChild as HTMLElement;

    expect(glyph.tagName).toBe("SPAN");
    // The whole point: the shape is a mask and the COLOR comes from CSS, which
    // an <img> can never inherit.
    expect(glyph.style.backgroundColor).toBe("currentcolor");
    expect(glyph.style.getPropertyValue("-webkit-mask") || glyph.style.mask).toContain(MONOCHROME);
    expect(container.querySelector("img")).toBeNull();
  });

  it("leaves an icon that carries its own colors alone", () => {
    // Masking a real multicolor logo would flatten it to one tone, which is a
    // different kind of wrong from being invisible.
    const { container } = render(<ExternalAgentIcon dataUrl={BRANDED} size={16} />);
    const img = container.querySelector("img");

    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(BRANDED);
  });

  it("falls back to drawing an undecodable data URL rather than masking it", () => {
    const { container } = render(<ExternalAgentIcon dataUrl="data:image/svg+xml;base64,%%%" />);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("is decorative — it never reaches the accessibility tree", () => {
    const { container } = render(<ExternalAgentIcon dataUrl={MONOCHROME} />);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});
