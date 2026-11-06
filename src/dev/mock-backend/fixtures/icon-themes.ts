// Icon themes for the browser mock: `list_icon_themes`, `resolve_icons`,
// `get_icon_theme_assets`, `get_icon_theme_fonts`, and the Open VSX trio.
//
// The real backend parses a 444 KB VS Code icon-theme document and serves
// 1,251 SVGs out of the binary. That cannot live in a dev bundle, so this is a
// TRIMMED Material Icon Theme: the same document shape, the same resolution
// order, and the real upstream SVGs — but only the definitions the seeded mock
// project actually needs. Material Icon Theme is MIT; the full vendored copy,
// its LICENSE and its provenance note live in
// `crates/atlas-icon-theme/vendor/material-icon-theme/`.
//
// `resolve_icons` here runs the same precedence the Rust resolver does
// (fileNames > fileExtensions > languageIds > file, longest path suffix and
// longest extension first), so a fake answer that disagrees with Rust is a bug
// in one of the two rather than an artefact of the mock.
//
// @generated in part — the SVG sources and association tables below were
// extracted from the vendored Material Icon Theme 5.38.1.

import type {
  IconAppearance,
  IconAsset,
  IconFontFace,
  IconRequest,
  IconThemeSummary,
  ResolvedIcon,
} from "@/features/icon-theme/lib/icon-theme-api";
import type { OpenVsxExtension } from "@/lib/open-vsx";
import type { TypedHandlers, Unit } from "../types";

/** Trimmed `iconDefinitions`: id -> SVG source, exactly as Rust serves it. */
const ICONS: Record<string, string> = {
  bun: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#fff8e1" d="M30 17.045a9.8 9.8 0 0 0-.32-2.306l-.004.034a11.2 11.2 0 0 0-5.762-6.786c-3.495-1.89-5.243-3.326-6.8-3.811h.003c-1.95-.695-3.949.82-5.825 1.927-4.52 2.481-9.573 5.45-9.28 11.417.008-.029.017-.052.026-.08a9.97 9.97 0 0 0 3.934 7.257l-.01-.006C13.747 31.473 30.05 27.292 30 17.045"/><path fill="#37474f" d="M19.855 20.236A.8.8 0 0 0 19.26 20h-6.514a.8.8 0 0 0-.596.236.51.51 0 0 0-.137.463 4.37 4.37 0 0 0 1.641 2.339 4.2 4.2 0 0 0 2.349.926 4.2 4.2 0 0 0 2.343-.926 4.37 4.37 0 0 0 1.642-2.339.5.5 0 0 0-.132-.463Z"/><ellipse cx="22.5" cy="18.5" fill="#f8bbd0" rx="2.5" ry="1.5"/><ellipse cx="9.5" cy="18.5" fill="#f8bbd0" rx="2.5" ry="1.5"/><circle cx="10" cy="16" r="2" fill="#37474f"/><circle cx="22" cy="16" r="2" fill="#37474f"/><path fill="#455a64" d="M9.996 18A2 2 0 1 0 8 15.996V16a2 2 0 0 0 1.996 2"/><circle cx="9" cy="15" r="1" fill="#fafafa"/><circle cx="21" cy="15" r="1" fill="#fafafa"/></svg>',
  css: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#7e57c2" d="M20 18h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 20 22h2v2h2v-2c0-.388-.562-.851-1.254-1.034C20.356 20.34 20 18.84 20 18m-3.254 2.966C14.356 20.34 14 18.84 14 18h-2v-2h-2v8h2v-2h4v2h2v-2c0-.388-.562-.851-1.254-1.034"/><path fill="#7e57c2" d="M24 4H4v20a4 4 0 0 0 4 4h16.16A3.84 3.84 0 0 0 28 24.16V8a4 4 0 0 0-4-4m2 14h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 26 22v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2Z"/></svg>',
  docker:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0288d1" d="M21.81 10.25c-.06-.04-.56-.43-1.64-.43-.28 0-.56.03-.84.08-.21-1.4-1.38-2.11-1.43-2.14l-.29-.17-.18.27c-.24.36-.43.77-.51 1.19-.2.8-.08 1.56.33 2.21-.49.28-1.29.35-1.46.35H2.62c-.34 0-.62.28-.62.63 0 1.15.18 2.3.58 3.38.45 1.19 1.13 2.07 2 2.61.98.6 2.59.94 4.42.94.79 0 1.61-.07 2.42-.22 1.12-.2 2.2-.59 3.19-1.16A8.3 8.3 0 0 0 16.78 16c1.05-1.17 1.67-2.5 2.12-3.65h.19c1.14 0 1.85-.46 2.24-.85.26-.24.45-.53.59-.87l.08-.24zm-17.96.99h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H3.85c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.43 0h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H6.28c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.47 0h1.75c.1 0 .17-.07.17-.16V9.5c0-.08-.06-.16-.17-.16H8.75c-.08 0-.15.07-.15.16v1.58c0 .09.06.16.15.16m2.44 0h1.77c.08 0 .15-.07.15-.16V9.5c0-.08-.06-.16-.15-.16h-1.77c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16M6.28 9h1.76c.08 0 .16-.09.16-.18V7.25c0-.09-.07-.16-.16-.16H6.28c-.09 0-.16.06-.16.16v1.57c.01.09.07.18.16.18m2.47 0h1.75c.1 0 .17-.09.17-.18V7.25c0-.09-.06-.16-.17-.16H8.75c-.08 0-.15.06-.15.16v1.57c0 .09.06.18.15.18m2.44 0h1.77c.08 0 .15-.09.15-.18V7.25c0-.09-.07-.16-.15-.16h-1.77c-.08 0-.15.06-.15.16v1.57c0 .09.07.18.15.18m0-2.28h1.77c.08 0 .15-.07.15-.16V5c0-.1-.07-.17-.15-.17h-1.77c-.08 0-.15.06-.15.17v1.56c0 .08.07.16.15.16m2.46 4.52h1.76c.09 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16h-1.76c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16"/></svg>',
  document:
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/><path fill="#42a5f5" d="M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z"/></svg>',
  file: '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m8.668 6h3.6641l-3.6641-3.668v3.668m-4.668-4.668h5.332l4 4v8c0 0.73828-0.59375 1.3359-1.332 1.3359h-8c-0.73828 0-1.332-0.59766-1.332-1.3359v-10.664c0-0.74219 0.59375-1.3359 1.332-1.3359m3.332 1.3359h-3.332v10.664h8v-6h-4.668z" fill="#90a4ae" /></svg>',
  folder:
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232" fill="#90a4ae" /></svg>',
  "folder-components":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#c0ca33" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#f0f4c3" d="M6 10h4v4H6zm5 0h4v4h-4zM6 5h4v4H6zm4.172 2L13 4.172 15.829 7 13 9.829z"/></svg>',
  "folder-components-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#c0ca33" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#f0f4c3" d="M6 10h4v4H6zm5 0h4v4h-4zM6 5h4v4H6zm4.172 2L13 4.172 15.829 7 13 9.829z"/></svg>',
  "folder-css":
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16"><defs><path id="a" fill="#d1c4e9" d="M7 10V9H6v4h1v-1h1v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1Zm5 0V9a1 1 0 0 0-1-1h-1a1 1 0 0 0-1 1v1c0 .42.179 1.17 1.373 1.483.346.092.627.323.627.517v1h-1v-1H9v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1a1.67 1.67 0 0 0-1.373-1.483C10 10.352 10 10.097 10 10V9h1v1Zm4 0V9a1 1 0 0 0-1-1h-1a1 1 0 0 0-1 1v1c0 .42.179 1.17 1.373 1.483.346.092.627.323.627.517v1h-1v-1h-1v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1a1.67 1.67 0 0 0-1.373-1.483C14 10.352 14 10.097 14 10V9h1v1Z"/></defs><path id="folder" fill="#7e57c2" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><g id="motive"><use xlink:href="#a"/><use xlink:href="#a"/></g></svg>',
  "folder-css-open":
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16"><defs><path id="a" fill="#d1c4e9" d="M7 10V9H6v4h1v-1h1v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1Zm5 0V9a1 1 0 0 0-1-1h-1a1 1 0 0 0-1 1v1c0 .42.179 1.17 1.373 1.483.346.092.627.323.627.517v1h-1v-1H9v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1a1.67 1.67 0 0 0-1.373-1.483C10 10.352 10 10.097 10 10V9h1v1Zm4 0V9a1 1 0 0 0-1-1h-1a1 1 0 0 0-1 1v1c0 .42.179 1.17 1.373 1.483.346.092.627.323.627.517v1h-1v-1h-1v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1a1.67 1.67 0 0 0-1.373-1.483C14 10.352 14 10.097 14 10V9h1v1Z"/></defs><path id="folder" fill="#7e57c2" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><g id="motive"><use xlink:href="#a"/><use xlink:href="#a"/></g></svg>',
  "folder-dist":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#e57373" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#ffcdd2" d="M15 7h-2V6l-1-1h-2L9 6v1H7a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1m-5 0V6h2v1z"/></svg>',
  "folder-dist-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#e57373" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#ffcdd2" d="M15 7h-2V6l-1-1h-2L9 6v1H7a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1m-5 0V6h2v1z"/></svg>',
  "folder-docs":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#0277bd" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#b3e5fc" d="M12 5H8.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V8Zm0 8H9v-1h3zm2-2H9v-1h5zm-2.414-2.586V6L14 8.414Z"/></svg>',
  "folder-docs-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#0277bd" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#b3e5fc" d="M12 5H8.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V8Zm0 8H9v-1h3zm2-2H9v-1h5zm-2.414-2.586V6L14 8.414Z"/></svg>',
  "folder-github":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#546e7a" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#eceff1" d="M11.5 5A4.516 4.516 0 0 0 7 9.532a4.54 4.54 0 0 0 3.079 4.305c.225.036.296-.105.296-.226v-.766c-1.246.272-1.512-.607-1.512-.607a1.2 1.2 0 0 0-.499-.667c-.41-.28.031-.272.031-.272a.95.95 0 0 1 .689.466.963.963 0 0 0 1.31.377.98.98 0 0 1 .283-.607c-1-.114-2.047-.504-2.047-2.23a1.76 1.76 0 0 1 .463-1.228 1.63 1.63 0 0 1 .045-1.196s.377-.123 1.237.462a4.3 4.3 0 0 1 2.25 0c.86-.585 1.239-.462 1.239-.462a1.63 1.63 0 0 1 .044 1.196 1.76 1.76 0 0 1 .464 1.228c0 1.731-1.053 2.112-2.057 2.225a1.1 1.1 0 0 1 .311.839v1.242c0 .122.072.266.301.226A4.54 4.54 0 0 0 11.501 5"/></svg>',
  "folder-github-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#546e7a" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#eceff1" d="M11.5 5A4.516 4.516 0 0 0 7 9.532a4.54 4.54 0 0 0 3.079 4.305c.225.036.296-.105.296-.226v-.766c-1.246.272-1.512-.607-1.512-.607a1.2 1.2 0 0 0-.499-.667c-.41-.28.031-.272.031-.272a.95.95 0 0 1 .689.466.963.963 0 0 0 1.31.377.98.98 0 0 1 .283-.607c-1-.114-2.047-.504-2.047-2.23a1.76 1.76 0 0 1 .463-1.228 1.63 1.63 0 0 1 .045-1.196s.377-.123 1.237.462a4.3 4.3 0 0 1 2.25 0c.86-.585 1.239-.462 1.239-.462a1.63 1.63 0 0 1 .044 1.196 1.76 1.76 0 0 1 .464 1.228c0 1.731-1.053 2.112-2.057 2.225a1.1 1.1 0 0 1 .311.839v1.242c0 .122.072.266.301.226A4.54 4.54 0 0 0 11.501 5"/></svg>',
  "folder-lib":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#c0ca33" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#f0f4c3" d="M11.5 8a1.5 1.5 0 0 0 .002-3H11.5A1.5 1.5 0 0 0 10 6.5 1.5 1.5 0 0 0 11.5 8m0 1.987C10.387 8.947 8.523 7.996 7 8v5c1.595 0 3.425 1.002 4.5 2 1.113-1.039 2.978-2.002 4.5-2V8c-1.522-.003-3.387.947-4.5 1.986"/></svg>',
  "folder-lib-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#c0ca33" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#f0f4c3" d="M11.5 8a1.5 1.5 0 0 0 .002-3H11.5A1.5 1.5 0 0 0 10 6.5 1.5 1.5 0 0 0 11.5 8m0 1.987C10.387 8.947 8.523 7.996 7 8v5c1.595 0 3.425 1.002 4.5 2 1.113-1.039 2.978-2.002 4.5-2V8c-1.522-.003-3.387.947-4.5 1.986"/></svg>',
  "folder-node":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#8bc34a" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#dcedc8" d="M12.5 6 9 8.036v3.927L12.5 14l3.5-2.037V8.036Z"/></svg>',
  "folder-node-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#8bc34a" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#dcedc8" d="M12.5 6 9 8.036v3.927L12.5 14l3.5-2.037V8.036Z"/></svg>',
  "folder-open":
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6" fill="#90a4ae" /></svg>',
  "folder-public":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#039be5" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#b3e5fc" d="M11 5a5 5 0 1 0 5 5 5 5 0 0 0-5-5m3.459 3H12.98a8 8 0 0 0-.671-1.77A4.02 4.02 0 0 1 14.459 8M11 6a7 7 0 0 1 .945 2h-1.89A7 7 0 0 1 11 6m-1.309.23A8 8 0 0 0 9.02 8H7.541a4.02 4.02 0 0 1 2.15-1.77M7.131 11a3.85 3.85 0 0 1 0-2h1.704a7.8 7.8 0 0 0 0 2zm.41 1H9.02a8 8 0 0 0 .671 1.77A4.02 4.02 0 0 1 7.541 12M11 14a7 7 0 0 1-.945-2h1.89A7 7 0 0 1 11 14m1.155-3h-2.31a6.7 6.7 0 0 1 0-2h2.31a6.7 6.7 0 0 1 0 2m.154 2.77A8 8 0 0 0 12.98 12h1.479a4.02 4.02 0 0 1-2.15 1.77m2.56-2.77h-1.704a7.8 7.8 0 0 0 0-2h1.704a3.85 3.85 0 0 1 0 2"/></svg>',
  "folder-public-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#039be5" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#b3e5fc" d="M11 5a5 5 0 1 0 5 5 5 5 0 0 0-5-5m3.459 3H12.98a8 8 0 0 0-.671-1.77A4.02 4.02 0 0 1 14.459 8M11 6a7 7 0 0 1 .945 2h-1.89A7 7 0 0 1 11 6m-1.309.23A8 8 0 0 0 9.02 8H7.541a4.02 4.02 0 0 1 2.15-1.77M7.131 11a3.85 3.85 0 0 1 0-2h1.704a7.8 7.8 0 0 0 0 2zm.41 1H9.02a8 8 0 0 0 .671 1.77A4.02 4.02 0 0 1 7.541 12M11 14a7 7 0 0 1-.945-2h1.89A7 7 0 0 1 11 14m1.155-3h-2.31a6.7 6.7 0 0 1 0-2h2.31a6.7 6.7 0 0 1 0 2m.154 2.77A8 8 0 0 0 12.98 12h1.479a4.02 4.02 0 0 1-2.15 1.77m2.56-2.77h-1.704a7.8 7.8 0 0 0 0-2h1.704a3.85 3.85 0 0 1 0 2"/></svg>',
  "folder-root":
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" fill="none" stroke="#90a4ae" stroke-width="2"/><circle cx="8" cy="8" r="3" fill="#90a4ae"/></svg>',
  "folder-root-open":
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" fill="none" stroke="#90a4ae" stroke-width="2"/></svg>',
  "folder-src":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#4caf50" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#c8e6c9" d="M9.225 15a.5.5 0 0 1-.12-.014.57.568 0 0 1-.414-.661l1.549-7.872a.566.565 0 0 1 .254-.372.53.53 0 0 1 .4-.067.57.57 0 0 1 .415.662l-1.552 7.872a.56.56 0 0 1-.253.371.53.53 0 0 1-.28.081m3.105-1h-.038a.54.54 0 0 1-.382-.206.583.582 0 0 1 .057-.774l2.664-2.483-2.653-2.312a.583.582 0 0 1-.08-.772.54.54 0 0 1 .377-.218.53.53 0 0 1 .406.129l3.126 2.727a.579.578 0 0 1 .002.862l-3.114 2.904a.536.535 0 0 1-.365.144zm-4.661 0a.536.535 0 0 1-.365-.146L4.186 10.95a.58.58 0 0 1-.005-.846l.01-.01 3.128-2.726a.516.515 0 0 1 .4-.13.54.54 0 0 1 .38.218.583.582 0 0 1-.08.773l-2.65 2.31 2.663 2.482a.579.578 0 0 1 .056.774.536.535 0 0 1-.381.206z"/></svg>',
  "folder-src-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#4caf50" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#c8e6c9" d="M9.225 15a.5.5 0 0 1-.12-.014.57.568 0 0 1-.414-.661l1.549-7.872a.566.565 0 0 1 .254-.372.53.53 0 0 1 .4-.067.57.57 0 0 1 .415.662l-1.552 7.872a.56.56 0 0 1-.253.371.53.53 0 0 1-.28.081m3.105-1h-.038a.54.54 0 0 1-.382-.206.583.582 0 0 1 .057-.774l2.664-2.483-2.653-2.312a.583.582 0 0 1-.08-.772.54.54 0 0 1 .377-.218.53.53 0 0 1 .406.129l3.126 2.727a.579.578 0 0 1 .002.862l-3.114 2.904a.536.535 0 0 1-.365.144zm-4.661 0a.536.535 0 0 1-.365-.146L4.186 10.95a.58.58 0 0 1-.005-.846l.01-.01 3.128-2.726a.516.515 0 0 1 .4-.13.54.54 0 0 1 .38.218.583.582 0 0 1-.08.773l-2.65 2.31 2.663 2.482a.579.578 0 0 1 .056.774.536.535 0 0 1-.381.206z"/></svg>',
  "folder-src-tauri":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#455a64" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><g id="motive"><path fill="#ffca28" d="M13.579 8.276a.857.857 0 0 1-1.287.741 1 1 0 0 1-.177-.135.857.857 0 0 1 .383-1.434.858.858 0 0 1 1.08.827"/><path fill="#26c6da" d="M11.278 9.872a.857.857 0 1 0-.001 1.714.857.857 0 0 0 .001-1.714"/><path fill="#ffca28" d="M14.498 11.02a3.3 3.3 0 0 1-1.13.46 2.3 2.3 0 0 0 .112-1.036 2.297 2.297 0 0 0 .261-4.227 2.3 2.3 0 0 0-2.887.72 3.8 3.8 0 0 0-1.255.365 3.275 3.275 0 0 1 6.399 1.096 3.27 3.27 0 0 1-1.5 2.623M9.637 7.898l.804.098a2.3 2.3 0 0 1 .101-.456 3.3 3.3 0 0 0-.905.358" clip-rule="evenodd"/><path fill="#26c6da" d="M9.498 7.984a3.3 3.3 0 0 1 1.138-.463 2.3 2.3 0 0 0-.129 1.039 2.3 2.3 0 0 0-1.431 1.503 2.297 2.297 0 0 0 2.226 2.957 2.3 2.3 0 0 0 1.844-.956 3.9 3.9 0 0 0 1.255-.363 3.277 3.277 0 0 1-5.106 1.633c-1.809-1.37-1.705-4.12.203-5.35m4.86 3.122-.015.008z" clip-rule="evenodd"/></g></svg>',
  "folder-src-tauri-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#455a64" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><g id="motive"><path fill="#ffca28" d="M13.579 8.276a.857.857 0 0 1-1.287.741 1 1 0 0 1-.177-.135.857.857 0 0 1 .383-1.434.858.858 0 0 1 1.08.827"/><path fill="#26c6da" d="M11.278 9.872a.857.857 0 1 0-.001 1.714.857.857 0 0 0 .001-1.714"/><path fill="#ffca28" d="M14.498 11.02a3.3 3.3 0 0 1-1.13.46 2.3 2.3 0 0 0 .112-1.036 2.297 2.297 0 0 0 .261-4.227 2.3 2.3 0 0 0-2.887.72 3.8 3.8 0 0 0-1.255.365 3.275 3.275 0 0 1 6.399 1.096 3.27 3.27 0 0 1-1.5 2.623M9.637 7.898l.804.098a2.3 2.3 0 0 1 .101-.456 3.3 3.3 0 0 0-.905.358" clip-rule="evenodd"/><path fill="#26c6da" d="M9.498 7.984a3.3 3.3 0 0 1 1.138-.463 2.3 2.3 0 0 0-.129 1.039 2.3 2.3 0 0 0-1.431 1.503 2.297 2.297 0 0 0 2.226 2.957 2.3 2.3 0 0 0 1.844-.956 3.9 3.9 0 0 0 1.255-.363 3.277 3.277 0 0 1-5.106 1.633c-1.809-1.37-1.705-4.12.203-5.35m4.86 3.122-.015.008z" clip-rule="evenodd"/></g></svg>',
  "folder-test":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#00bfa5" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/><path id="motive" fill="#a7ffeb" d="M8 6v1h1v6a2 2 0 0 0 4 0V7h1V6Zm2.5 7a.5.5 0 1 1 .5-.5.5.5 0 0 1-.5.5m1-2a.5.5 0 1 1 .5-.5.5.5 0 0 1-.5.5m.5-2h-2V7h2z"/></svg>',
  "folder-test-open":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#00bfa5" d="M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"/><path id="motive" fill="#a7ffeb" d="M8 6v1h1v6a2 2 0 0 0 4 0V7h1V6Zm2.5 7a.5.5 0 1 1 .5-.5.5.5 0 0 1-.5.5m1-2a.5.5 0 1 1 .5-.5.5.5 0 0 1-.5.5m.5-2h-2V7h2z"/></svg>',
  git: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#e64a19" d="M13.172 2.828 11.78 4.22l1.91 1.91 2 2A2.986 2.986 0 0 1 20 10.81a3.25 3.25 0 0 1-.31 1.31l2.06 2a2.68 2.68 0 0 1 3.37.57 2.86 2.86 0 0 1 .88 2.117 3.02 3.02 0 0 1-.856 2.109A2.9 2.9 0 0 1 23 19.81a2.93 2.93 0 0 1-2.13-.87 2.694 2.694 0 0 1-.56-3.38l-2-2.06a3 3 0 0 1-.31.12V20a3 3 0 0 1 1.44 1.09 2.92 2.92 0 0 1 .56 1.72 2.88 2.88 0 0 1-.878 2.128 2.98 2.98 0 0 1-2.048.871 2.981 2.981 0 0 1-2.514-4.719A3 3 0 0 1 16 20v-6.38a2.96 2.96 0 0 1-1.44-1.09 2.9 2.9 0 0 1-.56-1.72 2.9 2.9 0 0 1 .31-1.31l-3.9-3.9-7.579 7.572a4 4 0 0 0-.001 5.658l10.342 10.342a4 4 0 0 0 5.656 0l10.344-10.344a4 4 0 0 0 0-5.656L18.828 2.828a4 4 0 0 0-5.656 0"/></svg>',
  html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#e65100" d="m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z"/></svg>',
  image:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#26a69a" d="M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9"/></svg>',
  license:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#ff5722" d="M8 1a5.5 5.5 0 0 0-4 9.26V15l4-1.5 4 1.5v-4.74A5.49 5.49 0 0 0 8 1m0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8m0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/></svg>',
  nodejs:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#8bc34a" d="M16 20.003v2h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-2v-2h4v-2h-4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2v2Z"/><path fill="#8bc34a" d="m16 3.003-12 7v14l4 2h6v-13.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v11.5H8l-2-1.034V11.15l10-5.833 10 5.833v11.703l-10 5.833-1.745-1.022L13 29.253l3 1.75 12-7v-14Z"/></svg>',
  pdf: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ef5350" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z"/></svg>',
  python:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0288d1" d="M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711"/><path fill="#fdd835" d="M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89"/></svg>',
  react_ts:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6"/><path fill="#0288d1" d="M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2"/><path fill="#0288d1" d="M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z"/><path fill="#0288d1" d="M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369"/></svg>',
  readme:
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16"><path d="M0 0h24v24H0z"/><path fill="#42a5f5" d="M8 1C4.136 1 1 4.136 1 8s3.136 7 7 7 7-3.136 7-7-3.136-7-7-7m1 11H7V7.5h2zm0-6H7V4h2z"/></svg>',
  rust: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ff7043" d="m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10"/></svg>',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ffb300" d="M29.168 14.03a2.7 2.7 0 0 0-1.968-.83 2.51 2.51 0 0 0-1.929.8h-4.443l3.078-3.078a2.835 2.835 0 0 0 2.857-2.842 2.6 2.6 0 0 0-.831-1.969 2.82 2.82 0 0 0-2.014-.788 2.67 2.67 0 0 0-1.968.788 2.36 2.36 0 0 0-.812 1.922L18 11.17V6.726a2.51 2.51 0 0 0 .8-1.929 2.7 2.7 0 0 0-.832-1.968 2.745 2.745 0 0 0-3.936 0 2.7 2.7 0 0 0-.832 1.968 2.51 2.51 0 0 0 .8 1.93v4.443l-3.138-3.138a2.36 2.36 0 0 0-.812-1.922 2.66 2.66 0 0 0-1.968-.788 2.83 2.83 0 0 0-2.014.788 2.6 2.6 0 0 0-.831 1.969 2.74 2.74 0 0 0 .831 2.013 2.8 2.8 0 0 0 2.026.829l3.078 3.078H6.729a2.51 2.51 0 0 0-1.929-.8 2.7 2.7 0 0 0-1.968.831 2.745 2.745 0 0 0 0 3.937 2.7 2.7 0 0 0 1.968.832 2.51 2.51 0 0 0 1.929-.8h4.443l-3.078 3.077a2.835 2.835 0 0 0-2.857 2.842 2.6 2.6 0 0 0 .831 1.969 2.82 2.82 0 0 0 2.014.788 2.67 2.67 0 0 0 1.968-.788 2.36 2.36 0 0 0 .812-1.922L14 20.827v4.444a2.51 2.51 0 0 0-.8 1.929 2.784 2.784 0 0 0 4.768 1.968A2.7 2.7 0 0 0 18.8 27.2a2.51 2.51 0 0 0-.8-1.929v-4.444l3.138 3.138a2.36 2.36 0 0 0 .812 1.922 2.66 2.66 0 0 0 1.968.788 2.83 2.83 0 0 0 2.014-.788 2.6 2.6 0 0 0 .831-1.969 2.74 2.74 0 0 0-.831-2.013 2.8 2.8 0 0 0-2.026-.829L20.828 18h4.443a2.51 2.51 0 0 0 1.93.8 2.784 2.784 0 0 0 1.967-4.769Z"/></svg>',
  toml: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#cfd8dc" d="M4 6V4h8v2H9v7H7V6z"/><path fill="#ef5350" d="M4 1v1H2v12h2v1H1V1zm8 0v1h2v12h-2v1h3V1z"/></svg>',
  tsconfig:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#757575" d="M15 2H6a2.006 2.006 0 0 0-2 2v22a2.006 2.006 0 0 0 2 2h6v-4H6v-2h6v-2H6v-2h6v-2H6v-2h6v-2h2V4l8 8h2v-1Z" data-mit-no-recolor="true"/><path fill="#0288d1" d="M12 12v18h18V12Zm8 6h-2v8h-2v-8h-2v-2h6Zm8 0h-4v2h2a2.006 2.006 0 0 1 2 2v2a2.006 2.006 0 0 1-2 2h-4v-2h4v-2h-2a2.006 2.006 0 0 1-2-2v-2a2.006 2.006 0 0 1 2-2h4Z"/></svg>',
  tune: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#fbc02d" d="M12 10h10v2H12z"/><path fill="#fbc02d" d="M16 4h2v8h-2zm4 18h10v2H20zm4 2h2v4h-2zm0-20h2v14h-2zM2 18h10v2H2z"/><path fill="#fbc02d" d="M6 18h2v10H6zM6 4h2v10H6zm10 12h2v12h-2z"/></svg>',
  typescript:
    '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 16 16"><path fill="#0288d1" d="M2 2v12h12V2zm4 6h3v1H8v4H7V9H6zm5 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1"/></svg>',
  vite: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#a0f" d="M29.313 12h-6.664a1.427 1.427 0 0 1-1.1-2.24l4.398-6.676A.703.703 0 0 0 25.397 2H8.428a.62.62 0 0 0-.55.289l-5.77 8.627A.703.703 0 0 0 2.658 12h8.175a1.427 1.427 0 0 1 1.099 2.24l-4.48 6.676A.702.702 0 0 0 8 22l6.695.002A1.34 1.34 0 0 1 16 23.375v5.934a.652.652 0 0 0 1.168.433l12.694-16.586a.725.725 0 0 0-.55-1.156"/></svg>',
  yaml: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff5252" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2m12 16v-2H9v2zm-4-4v-2H6v2z"/></svg>',
};

/** `fileNames` — beats every extension rule. */
const FILE_NAMES: Record<string, string> = {
  ".env.local": "tune",
  ".gitignore": "git",
  "bun.lock": "bun",
  dockerfile: "docker",
  license: "license",
  "package.json": "nodejs",
  "readme.md": "readme",
  "tsconfig.json": "tsconfig",
  "vite.config.ts": "vite",
};

/** `fileExtensions`, lowercased as Rust lowercases them. */
const FILE_EXTENSIONS: Record<string, string> = {
  css: "css",
  html: "html",
  pdf: "pdf",
  png: "image",
  py: "python",
  rs: "rust",
  svg: "svg",
  toml: "toml",
  ts: "typescript",
  tsx: "react_ts",
  txt: "document",
  yaml: "yaml",
};

/** `folderNames`. */
const FOLDER_NAMES: Record<string, string> = {
  ".github": "folder-github",
  components: "folder-components",
  dist: "folder-dist",
  docs: "folder-docs",
  lib: "folder-lib",
  node_modules: "folder-node",
  public: "folder-public",
  src: "folder-src",
  "src-tauri": "folder-src-tauri",
  styles: "folder-css",
  tests: "folder-test",
};

/** `folderNamesExpanded`. */
const FOLDER_NAMES_EXPANDED: Record<string, string> = {
  ".github": "folder-github-open",
  components: "folder-components-open",
  dist: "folder-dist-open",
  docs: "folder-docs-open",
  lib: "folder-lib-open",
  node_modules: "folder-node-open",
  public: "folder-public-open",
  src: "folder-src-open",
  "src-tauri": "folder-src-tauri-open",
  styles: "folder-css-open",
  tests: "folder-test-open",
};
/** The light section: one override, so switching appearance is observable. */
const LIGHT_FILE_EXTENSIONS: Record<string, string> = { svg: "svg" };

const MATERIAL_ID = "material-icon-theme";
const MINIMAL_ID = "minimal";
/** A third theme, installed from "Open VSX" in this session. See `install`. */
const INSTALLED_ID = "atlas-tests.pretend-seti";

/** Themes the fake backend currently has. `install` adds to it, `remove` takes
 *  away — so the picker's install/remove flows have somewhere to land. */
const installed = new Map<string, IconThemeSummary>([
  [
    MINIMAL_ID,
    {
      id: MINIMAL_ID,
      name: "Minimal",
      author: "Atlas",
      license: "MIT",
      builtIn: true,
      hidesExplorerArrows: false,
      usesFallbackIcons: true,
    },
  ],
  [
    MATERIAL_ID,
    {
      id: MATERIAL_ID,
      name: "Material Icon Theme",
      author: "Philipp Kief (Material Extensions)",
      license: "MIT",
      builtIn: true,
      hidesExplorerArrows: false,
      usesFallbackIcons: false,
    },
  ],
]);

// ── resolution ────────────────────────────────────────────────────────────

/** Path suffixes, longest first: what makes `.github/workflows` beat `workflows`. */
function suffixes(path: string): string[] {
  const segments = path.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  const start = Math.max(0, segments.length - 4);
  const out: string[] = [];
  for (let from = start; from < segments.length; from += 1) {
    out.push(segments.slice(from).join("/"));
  }
  return out;
}

/** Extensions, longest first: `d.ts` before `ts`. Index 0 is skipped so a
 *  dotfile's whole name is never read as its extension. */
function extensions(name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  let from = 1;
  for (;;) {
    const dot = lower.indexOf(".", from);
    if (dot < 0) break;
    from = dot + 1;
    if (from < lower.length) out.push(lower.slice(from));
  }
  return out;
}

function definitionFor(request: IconRequest, appearance: IconAppearance): string | null {
  const paths = suffixes(request.path);
  const name = paths[paths.length - 1] ?? "";
  if (request.kind === "folder" || request.kind === "rootFolder") {
    for (const key of paths) if (FOLDER_NAMES[key]) return FOLDER_NAMES[key];
    return "folder";
  }
  if (request.kind === "folderExpanded" || request.kind === "rootFolderExpanded") {
    for (const key of paths) if (FOLDER_NAMES_EXPANDED[key]) return FOLDER_NAMES_EXPANDED[key];
    for (const key of paths) if (FOLDER_NAMES[key]) return FOLDER_NAMES[key];
    return "folder-open";
  }
  for (const key of paths) if (FILE_NAMES[key]) return FILE_NAMES[key];
  for (const extension of extensions(name)) {
    if (appearance === "light" && LIGHT_FILE_EXTENSIONS[extension]) {
      return LIGHT_FILE_EXTENSIONS[extension];
    }
    if (FILE_EXTENSIONS[extension]) return FILE_EXTENSIONS[extension];
  }
  return "file";
}

// ── Open VSX ──────────────────────────────────────────────────────────────

/**
 * What the fake registry offers.
 *
 * The last entry always fails to install. Decision 36 asks fixtures to cover
 * states rather than happy paths, and "the download died half way" is the
 * state this picker most needs to look right in.
 */
const OPEN_VSX: OpenVsxExtension[] = [
  {
    id: "pkief.material-icon-theme",
    namespace: "PKief",
    name: "material-icon-theme",
    displayName: "Material Icon Theme",
    version: "5.38.1",
    description: "Material Design Icons for Visual Studio Code",
    license: "MIT",
    downloads: 9_400_000,
    installed: true,
  },
  {
    id: "atlas-tests.pretend-seti",
    namespace: "atlas-tests",
    name: "pretend-seti",
    displayName: "Pretend Seti",
    version: "1.2.0",
    description: "A font-glyph icon theme, the shape Seti and its descendants take",
    license: "MIT",
    downloads: 1_204_331,
    installed: false,
  },
  {
    id: "broken.icons",
    namespace: "broken",
    name: "icons",
    displayName: "Half-Published Icons",
    version: "0.0.3",
    description: "Installs fail — the failure state the picker has to render",
    license: "Unspecified",
    downloads: 42,
    installed: false,
  },
];

/**
 * What the frontend reads from each command below — the return type of its
 * wrapper in `icon-theme-api.ts`, which `invoke` infers its `T` from.
 */
export interface IconThemeResponses {
  list_icon_themes: IconThemeSummary[];
  resolve_icons: (ResolvedIcon | null)[];
  get_icon_theme_assets: Record<string, IconAsset>;
  get_icon_theme_fonts: IconFontFace[];
  search_icon_themes: OpenVsxExtension[];
  install_icon_theme: IconThemeSummary;
  remove_icon_theme: Unit;
}

export const iconThemeHandlers: TypedHandlers<IconThemeResponses> = {
  list_icon_themes: (): IconThemeSummary[] => [...installed.values()],

  resolve_icons: (a): (ResolvedIcon | null)[] => {
    const themeId = String(a.themeId);
    const appearance = a.appearance as IconAppearance;
    const requests = (a.requests ?? []) as IconRequest[];
    // "Minimal" is not an empty theme, it is no theme: every row keeps the
    // lucide icon it had before icon themes existed.
    if (themeId === MINIMAL_ID) return requests.map(() => null);
    if (themeId === INSTALLED_ID) {
      // The installed fake is glyph-based, which is the branch SVG themes
      // never exercise: a character, a colour and a font id, all inline.
      return requests.map((request) => ({
        kind: "glyph",
        definition: request.kind === "file" ? "_file" : "_folder",
        character: request.kind === "file" ? "" : "",
        color: request.kind === "file" ? "#9ca3af" : "#8ab4f8",
        fontId: "seti",
      }));
    }
    return requests.map((request) => {
      const definition = definitionFor(request, appearance);
      return definition ? { kind: "image", definition } : null;
    });
  },

  get_icon_theme_assets: (a): Record<string, IconAsset> => {
    const out: Record<string, IconAsset> = {};
    if (String(a.themeId) !== MATERIAL_ID) return out;
    for (const definition of (a.definitions ?? []) as string[]) {
      const source = ICONS[definition];
      if (source) out[definition] = { kind: "svg", source };
    }
    return out;
  },

  get_icon_theme_fonts: (a): IconFontFace[] => {
    if (String(a.themeId) !== INSTALLED_ID) return [];
    // No real font file in the mock — the glyphs fall back to the system font,
    // which still shows that the glyph branch renders and takes its colour.
    return [{ id: "seti", weight: "normal", style: "normal", src: [] }];
  },

  search_icon_themes: (a): OpenVsxExtension[] => {
    const query = String(a.query ?? "")
      .trim()
      .toLowerCase();
    if (!query) return [];
    if (query === "offline") {
      // The offline path, reachable on demand: search for "offline".
      throw new Error(
        "The Open VSX search failed — Atlas could not reach open-vsx.org. Are you online?",
      );
    }
    return OPEN_VSX.filter(
      (hit) =>
        hit.displayName.toLowerCase().includes(query) ||
        hit.namespace.toLowerCase().includes(query) ||
        hit.description.toLowerCase().includes(query),
    ).map((hit) => ({ ...hit, installed: installed.has(hit.id) }));
  },

  install_icon_theme: (a): IconThemeSummary => {
    const args = (a.args ?? {}) as { namespace: string; name: string };
    const id = `${args.namespace}.${args.name}`;
    if (id === "broken.icons") {
      throw new Error("The download failed — Open VSX answered 404 to the .vsix request.");
    }
    const summary: IconThemeSummary = {
      id,
      name: OPEN_VSX.find((hit) => hit.id === id)?.displayName ?? args.name,
      author: args.namespace,
      license: "MIT",
      builtIn: false,
      hidesExplorerArrows: false,
      usesFallbackIcons: false,
    };
    installed.set(id, summary);
    void import("@tauri-apps/api/event").then(({ emit }) =>
      emit("atlas:icon-themes-changed", { kind: "icon-themes-changed" }),
    );
    return summary;
  },

  remove_icon_theme: (a): null => {
    const id = String(a.id);
    if (installed.get(id)?.builtIn) throw new Error(`"${id}" is built in and cannot be removed.`);
    if (!installed.delete(id)) throw new Error(`icon theme "${id}" is not installed`);
    void import("@tauri-apps/api/event").then(({ emit }) =>
      emit("atlas:icon-themes-changed", { kind: "icon-themes-changed" }),
    );
    return null;
  },
};
