import { invoke } from "@tauri-apps/api/core";
import { fmtTokens, fmtCost } from "@/features/monitor/lib/usage-format";
import type { MissionControlUsage } from "../types";

// Lazy-load the heavy libs only when an export is actually triggered.
async function htmlToImage() {
  return import("html-to-image");
}

/** Capture a DOM node to a PNG/JPEG data URL on the AMOLED background. */
async function capture(node: HTMLElement, kind: "png" | "jpeg"): Promise<string> {
  // Fonts must be ready or text renders as fallback in the capture.
  if (document.fonts?.ready) await document.fonts.ready;
  const { toPng, toJpeg } = await htmlToImage();
  const opts = {
    backgroundColor: "#000000",
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
  const target = await pickSave(`atlas-console-${stamp()}.jpg`, "jpg");
  if (!target) return;
  await invoke("mission_control_write_file", {
    targetPath: target,
    bytes: dataUrlToBytes(dataUrl),
  });
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
  const imgW = pageW;
  const imgH = (img.height / img.width) * imgW; // full image height scaled to page width
  let remaining = imgH;
  let y = 0;
  // Paint the same scaled image shifted up each page so it tiles vertically.
  while (remaining > 0) {
    pdf.setFillColor(0, 0, 0);
    pdf.rect(0, 0, pageW, pageH, "F");
    pdf.addImage(dataUrl, "PNG", 0, y, imgW, imgH);
    remaining -= pageH;
    if (remaining > 0) {
      y -= pageH;
      pdf.addPage();
    }
  }

  const target = await pickSave(`atlas-console-${stamp()}.pdf`, "pdf");
  if (!target) return;
  const buf = pdf.output("arraybuffer");
  await invoke("mission_control_write_file", {
    targetPath: target,
    bytes: Array.from(new Uint8Array(buf)),
  });
}

/** Export a Markdown report of the metrics. */
export async function exportMarkdown(data: MissionControlUsage): Promise<void> {
  const md = buildMarkdown(data);
  const target = await pickSave(`atlas-console-${stamp()}.md`, "md");
  if (!target) return;
  await invoke("mission_control_export_markdown", { targetPath: target, markdown: md });
}

function buildMarkdown(data: MissionControlUsage): string {
  const t = data.totals;
  const lines: string[] = [];
  lines.push(`# Atlas — Console Report`);
  lines.push("");
  lines.push(
    `_Generated ${new Date(data.generatedAt).toLocaleString()} · ${data.projects.length} projects_`,
  );
  lines.push("");
  lines.push(`## Totals`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Total tokens | ${fmtTokens(t.totalTokens)} |`);
  lines.push(
    `| Claude input / output | ${fmtTokens(t.claudeInput)} / ${fmtTokens(t.claudeOutput)} |`,
  );
  lines.push(`| Claude cache | ${fmtTokens(t.claudeCache)} |`);
  lines.push(`| Requests / sessions | ${fmtTokens(t.claudeRequests)} / ${t.claudeSessions} |`);
  lines.push(`| Codex tokens | ${fmtTokens(t.codexTokens)} (${t.codexSessions} threads) |`);
  lines.push();
  lines.push(
    `| BYOK tokens / calls | ${fmtTokens(t.byokInput + t.byokOutput)} / ${t.byokRequests} |`,
  );
  lines.push(`| Total cost | ${fmtCost(t.totalCostUsd)} |`);
  lines.push("");
  lines.push(`## Per project`);
  lines.push("");
  lines.push(`| Project | Claude (in/out) | Cost | Requests | Codex |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const p of [...data.projects].sort((a, b) => b.totalTokens - a.totalTokens)) {
    lines.push(
      `| ${p.projectName} | ${fmtTokens(p.claude.inputTokens)} / ${fmtTokens(p.claude.outputTokens)} | ${fmtCost(p.claude.costUsd)} | ${fmtTokens(p.claude.requests)} | ${fmtTokens(p.codex.tokens)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
