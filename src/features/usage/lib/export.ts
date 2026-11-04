import { invoke } from "@tauri-apps/api/core";
import { fmtCost, fmtNum, fmtPct, fmtTokens } from "@/features/monitor/lib/usage-format";
import { copyText } from "@/lib/clipboard";
import { themeBase } from "@/features/theme/theme-values";
import type { GroupBy } from "../types";
import { fmtRange } from "./date-range";
import { agentDisplay, modelDisplay, projectLabel, rankBy, tokensOf } from "./derive";
import type { UsageView } from "./use-usage-view";
import { formatDateTime } from "@/lib/format-time";
import { hexOf } from "@tryatlas/design/theme";

/**
 * Exports for the Usage tab: the rendered dashboard as PDF/JPEG, and the
 * derived view as a Markdown report (file or clipboard). Every number in the
 * report is what the screen shows — same range, same facets — so the two
 * never disagree.
 */

// Lazy-load the heavy libs only when an export is actually triggered.
async function htmlToImage() {
  return import("html-to-image");
}

/** Capture a DOM node to a PNG/JPEG data URL on the theme's own background. */
async function capture(node: HTMLElement, kind: "png" | "jpeg"): Promise<string> {
  // Fonts must be ready or text renders as fallback in the capture.
  if (document.fonts?.ready) await document.fonts.ready;
  const { toPng, toJpeg } = await htmlToImage();
  const opts = {
    backgroundColor: themeBase("background"),
    pixelRatio: 2,
    // Skip anything explicitly marked non-exportable (e.g. interactive controls).
    filter: (el: HTMLElement) => !(el.dataset && el.dataset.noexport === "true"),
  };
  return kind === "png" ? toPng(node, opts) : toJpeg(node, { ...opts, quality: 0.95 });
}

function dataUrlToBytes(dataUrl: string): number[] {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const out = Array.from<number>({ length: bin.length });
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pickSave(defaultName: string, ext: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const chosen = await save({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return (chosen as string | null) ?? null;
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** Export the dashboard node as a JPEG image. */
export async function exportJpeg(node: HTMLElement): Promise<void> {
  const dataUrl = await capture(node, "jpeg");
  const target = await pickSave(`atlas-usage-${stamp()}.jpg`, "jpg");
  if (!target) return;
  await invoke("usage_write_file", { targetPath: target, bytes: dataUrlToBytes(dataUrl) });
}

/** Export the dashboard node as a multi-page PDF (image-per-page slices). */
export async function exportPdf(node: HTMLElement): Promise<void> {
  const dataUrl = await capture(node, "png");
  const { jsPDF } = await import("jspdf");
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataUrl;
  });

  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  // The page fill has to be the same background the capture was taken on, or
  // a light theme exports black margins around its own screenshot. jsPDF takes
  // channels, not a token, so this is one more resolved value.
  const page = hexOf(themeBase("background"));
  const imgW = pageW;
  const imgH = (img.height / img.width) * imgW; // full image height scaled to page width
  let remaining = imgH;
  let y = 0;
  // Paint the same scaled image shifted up each page so it tiles vertically.
  while (remaining > 0) {
    pdf.setFillColor((page >> 16) & 0xff, (page >> 8) & 0xff, page & 0xff);
    pdf.rect(0, 0, pageW, pageH, "F");
    pdf.addImage(dataUrl, "PNG", 0, y, imgW, imgH);
    remaining -= pageH;
    if (remaining > 0) {
      y -= pageH;
      pdf.addPage();
    }
  }

  const target = await pickSave(`atlas-usage-${stamp()}.pdf`, "pdf");
  if (!target) return;
  const buf = pdf.output("arraybuffer");
  await invoke("usage_write_file", { targetPath: target, bytes: Array.from(new Uint8Array(buf)) });
}

/** Export a Markdown report of the current view. */
export async function exportMarkdown(view: UsageView): Promise<void> {
  const md = buildMarkdown(view);
  const target = await pickSave(`atlas-usage-${stamp()}.md`, "md");
  if (!target) return;
  await invoke("usage_export_markdown", { targetPath: target, markdown: md });
}

/** Copy the same Markdown report used for file export straight to the clipboard. */
export async function copyMarkdownReport(view: UsageView): Promise<boolean> {
  return copyText(buildMarkdown(view));
}

const TOP_N = 20;

const pctOrDash = (v: number | null) => (v === null ? "—" : fmtPct(v));
const costOrDash = (v: number | null) => (v === null ? "—" : fmtCost(v));
const ratioOrDash = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}×`);

function facetLine(view: UsageView): string | null {
  const { facets, data } = view;
  const parts: string[] = [];
  if (facets.projects.length)
    parts.push(`projects: ${facets.projects.map((p) => projectLabel(p, data)).join(", ")}`);
  if (facets.agents.length) parts.push(`agents: ${facets.agents.map(agentDisplay).join(", ")}`);
  if (facets.models.length) parts.push(`models: ${facets.models.map(modelDisplay).join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}

function rankedTable(view: UsageView, g: GroupBy, heading: string): string[] {
  const ranked = rankBy(view.rows, g, view.metric, view.data).slice(0, TOP_N);
  const col = g === "project" ? "Project" : g === "agent" ? "Agent" : "Model";
  const lines = [`## ${heading}`, ""];
  if (!ranked.length) {
    lines.push("_No activity in this window._", "");
    return lines;
  }
  lines.push(
    `| ${col} | Tokens | Input | Output | Cache read | Est. cost | Messages | Share |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  );
  for (const r of ranked) {
    const m = r.metrics;
    lines.push(
      `| ${r.label} | ${fmtTokens(tokensOf(m))} | ${fmtTokens(m.input)} | ${fmtTokens(m.output)} | ${fmtTokens(m.cacheRead)} | ${fmtCost(m.cost)} | ${fmtNum(m.messages)} | ${fmtPct(r.share)} |`,
    );
  }
  lines.push("");
  return lines;
}

/** The report body — exported for tests; the app goes through `exportMarkdown`/`copyMarkdownReport`. */
export function buildMarkdown(view: UsageView): string {
  const { totals, eff, sessionCount, resolved } = view;
  const lines: string[] = [];
  lines.push(`# Atlas — Usage report`);
  lines.push("");
  const facetsLine = facetLine(view);
  lines.push(`_${fmtRange(resolved)}${facetsLine ? ` · ${facetsLine}` : ""}_`);
  lines.push(`_Generated ${formatDateTime(new Date())}_`);
  lines.push("");
  lines.push(`## Totals`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Tokens (in + out) | ${fmtTokens(tokensOf(totals))} |`);
  lines.push(`| Input | ${fmtTokens(totals.input)} |`);
  lines.push(`| Output | ${fmtTokens(totals.output)} |`);
  lines.push(`| Cache read | ${fmtTokens(totals.cacheRead)} |`);
  lines.push(`| Cache write | ${fmtTokens(totals.cacheWrite)} |`);
  if (totals.reasoning > 0) lines.push(`| Reasoning | ${fmtTokens(totals.reasoning)} |`);
  lines.push(`| Est. cost | ${fmtCost(totals.cost)} |`);
  lines.push(`| Sessions | ${fmtNum(sessionCount)} |`);
  lines.push(`| Messages | ${fmtNum(totals.messages)} |`);
  lines.push("");
  lines.push(`## Efficiency`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Cache hit rate | ${pctOrDash(eff.cacheHitRate)} |`);
  lines.push(`| Output per input | ${ratioOrDash(eff.outputPerInput)} |`);
  lines.push(`| Est. cost per session | ${costOrDash(eff.costPerSession)} |`);
  lines.push(`| Est. cost per message | ${costOrDash(eff.costPerMessage)} |`);
  lines.push(
    `| Tokens per session | ${eff.tokensPerSession === null ? "—" : fmtTokens(Math.round(eff.tokensPerSession))} |`,
  );
  lines.push(`| Est. cost per 1K output | ${costOrDash(eff.blendedCostPer1kOutput)} |`);
  lines.push("");
  lines.push(...rankedTable(view, "project", "By project"));
  lines.push(...rankedTable(view, "agent", "By agent"));
  lines.push(...rankedTable(view, "model", "By model"));
  return lines.join("\n");
}
