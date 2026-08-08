// Export the Spaces canvas to PNG / JPEG / SVG / PDF. Uses the standard React
// Flow recipe: fit all nodes into a target box via getNodesBounds +
// getViewportForBounds, then html-to-image the `.react-flow__viewport`. Files are
// written through the Tauri save dialog + the existing fs write commands.

import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getNodesBounds, getViewportForBounds, type ReactFlowInstance } from "@xyflow/react";

export type ExportFormat = "png" | "jpeg" | "svg" | "pdf";
export type ExportResult = "ok" | "empty" | "cancelled";

const EXT: Record<ExportFormat, string> = { png: "png", jpeg: "jpg", svg: "svg", pdf: "pdf" };
const MAX_DIM = 4096; // cap the longest side (px) to keep files/memory sane

/** Canvas background (matches the app) — used for formats without alpha. */
function canvasBg(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim();
  return v || "#0a0a0a";
}

/** Raw base64 payload from a `data:...;base64,<b64>` (or uri-encoded) data URL. */
function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** Drop React Flow chrome (connection handles, resize controls) from the capture. */
function filterChrome(el: HTMLElement): boolean {
  const cl = el.classList;
  if (!cl) return true;
  return !cl.contains("react-flow__handle") && !cl.contains("react-flow__resize-control");
}

export async function exportCanvas(
  format: ExportFormat,
  rf: ReactFlowInstance,
): Promise<ExportResult> {
  const nodes = rf.getNodes();
  if (nodes.length === 0) return "empty";
  // Load the heavy export libs (jspdf ~390KB + html-to-image) ONLY when an
  // export actually runs — not when the Canvas tab opens. (MC does the same.)
  const [{ toPng, toJpeg, toSvg }, { jsPDF }] = await Promise.all([
    import("html-to-image"),
    import("jspdf"),
  ]);
  const viewportEl = document.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewportEl) return "empty";

  const bounds = getNodesBounds(nodes);
  const pad = 48;
  const width = Math.max(1, Math.ceil(bounds.width + pad * 2));
  const height = Math.max(1, Math.ceil(bounds.height + pad * 2));
  // Fit the nodes' bounds into the target box (with a small inner margin).
  const vp = getViewportForBounds(bounds, width, height, 0.1, 2, 0.1);
  const transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
  // Crisp on retina, but never let the longest side exceed MAX_DIM.
  const pixelRatio = Math.min(2, MAX_DIM / Math.max(width, height));
  const bg = canvasBg();

  const baseOpts = {
    width,
    height,
    pixelRatio,
    filter: filterChrome,
    style: { width: `${width}px`, height: `${height}px`, transform },
  } as const;

  // Decide the destination up front so a huge render isn't wasted on a cancel.
  const path = await save({
    defaultPath: `spaces-canvas.${EXT[format]}`,
    filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }],
  });
  if (!path) return "cancelled";

  if (format === "svg") {
    const dataUrl = await toSvg(viewportEl, baseOpts);
    // toSvg returns `data:image/svg+xml;charset=utf-8,<uri-encoded>`.
    const comma = dataUrl.indexOf(",");
    const payload = dataUrl.slice(comma + 1);
    const svg = dataUrl.includes(";base64,") ? atob(payload) : decodeURIComponent(payload);
    await invoke("write_file_content", { path, content: svg });
    return "ok";
  }

  if (format === "png") {
    const dataUrl = await toPng(viewportEl, baseOpts);
    await invoke("write_file_base64", { path, contents: base64FromDataUrl(dataUrl) });
    return "ok";
  }

  // JPEG + PDF both need an opaque background (no alpha).
  const png = await toPng(viewportEl, { ...baseOpts, backgroundColor: bg });
  if (format === "jpeg") {
    const dataUrl = await toJpeg(viewportEl, { ...baseOpts, backgroundColor: bg, quality: 0.95 });
    await invoke("write_file_base64", { path, contents: base64FromDataUrl(dataUrl) });
    return "ok";
  }

  // PDF: one page sized to the raster, image filled edge-to-edge.
  const pdf = new jsPDF({
    orientation: width >= height ? "landscape" : "portrait",
    unit: "px",
    format: [width, height],
  });
  pdf.addImage(png, "PNG", 0, 0, width, height);
  const pdfB64 = base64FromDataUrl(pdf.output("datauristring"));
  await invoke("write_file_base64", { path, contents: pdfB64 });
  return "ok";
}
