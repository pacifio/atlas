// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactFlowInstance } from "@xyflow/react";

const { save, invoke, toPng } = vi.hoisted(() => ({
  save: vi.fn(async () => "/tmp/out.png"),
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined),
  toPng: vi.fn(async (_el: HTMLElement, _opts?: unknown) => "data:image/png;base64,AAAA"),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("html-to-image", () => ({ toPng, toJpeg: vi.fn(), toSvg: vi.fn() }));
vi.mock("jspdf", () => ({ jsPDF: vi.fn() }));
vi.mock("@/features/theme/theme-values", () => ({ themeBase: () => "canvas-bg" }));

const { exportCanvas } = await import("./canvas-export");

/** A board container holding its own `.react-flow__viewport`. */
function board(id: string): HTMLElement {
  const container = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.className = "react-flow__viewport";
  viewport.dataset.board = id;
  container.appendChild(viewport);
  document.body.appendChild(container);
  return container;
}

function rfWith(nodes: unknown[]): ReactFlowInstance {
  return { getNodes: () => nodes } as unknown as ReactFlowInstance;
}

const ONE_NODE = [
  { id: "n1", position: { x: 0, y: 0 }, data: {}, measured: { width: 200, height: 100 } },
];

describe("exportCanvas", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    save.mockClear();
    invoke.mockClear();
    toPng.mockClear();
  });

  it("rasterises only the viewport inside the container it was given", async () => {
    board("a");
    const b = board("b");
    const result = await exportCanvas("png", rfWith(ONE_NODE), b);
    expect(result).toBe("ok");
    expect(toPng).toHaveBeenCalledTimes(1);
    expect(toPng.mock.calls[0][0].dataset.board).toBe("b");
    expect(invoke).toHaveBeenCalledWith("write_file_base64", {
      path: "/tmp/out.png",
      contents: "AAAA",
    });
  });

  it("returns empty for a board with no nodes, before asking where to save", async () => {
    const result = await exportCanvas("png", rfWith([]), board("a"));
    expect(result).toBe("empty");
    expect(save).not.toHaveBeenCalled();
  });
});
