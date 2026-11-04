import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { themeBase } from "@/features/theme/theme-values";
import { copyText } from "@/lib/clipboard";

import { MermaidBlockView } from "./views/mermaid-block-view";

/**
 * Export scale. Mermaid emits vector SVG, so the only thing a PNG loses is
 * resolution — rasterising at 2× keeps a diagram legible when it is pasted into
 * a ticket and viewed at 100%.
 */
const EXPORT_SCALE = 2;

/**
 * A Mermaid diagram: the container for `MermaidBlockView`, which renders it.
 * This file fills in what the view may not reach — the clipboard, the save
 * dialog and the file write.
 *
 * `controls` adds zoom, copy-source and export-as-PNG.
 */
export function MermaidBlock({ code, controls = false }: { code: string; controls?: boolean }) {
  return (
    <MermaidBlockView
      code={code}
      controls={controls}
      onCopySource={copyText}
      onExportPng={exportPng}
    />
  );
}

async function exportPng(svg: string): Promise<void> {
  try {
    const path = await save({
      defaultPath: "diagram.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!path) return;
    const base64 = await svgToPngBase64(svg);
    await invoke("write_file_base64", { path, contents: base64 });
  } catch {
    /* a cancelled dialog and a failed raster both leave the diagram intact */
  }
}

/**
 * Rasterise an SVG string to base64 PNG.
 *
 * The size comes from the SVG's own `viewBox` rather than the rendered element:
 * the element is under a zoom transform, and exporting whatever the reader
 * happened to be zoomed to would make the file's resolution an accident.
 *
 * The image is loaded from a data URL rather than a blob URL because a
 * `securityLevel: "strict"` mermaid SVG is self-contained — no external refs —
 * so the canvas never becomes tainted and `toDataURL` stays legal.
 *
 * theme-subscription-allow: reads the background once, at the moment the user asks for the file; nothing is kept to go stale.
 */
async function svgToPngBase64(svg: string): Promise<string> {
  const viewBox = svg
    .match(/viewBox="([\d.\-\s]+)"/)?.[1]
    ?.trim()
    .split(/\s+/);
  const width = viewBox ? Number(viewBox[2]) : 1200;
  const height = viewBox ? Number(viewBox[3]) : 800;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not rasterise the diagram"));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * EXPORT_SCALE));
  canvas.height = Math.max(1, Math.round(height * EXPORT_SCALE));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  // Mermaid draws no background of its own, so a PNG without this is a diagram
  // on transparency — invisible in any light-background document.
  ctx.fillStyle = themeBase("background");
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/png").split(",")[1];
}
