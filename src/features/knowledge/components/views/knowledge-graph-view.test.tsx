// @vitest-environment happy-dom
// The Knowledge Graph tab's status screens: each non-ready status says what it
// is, and none of them mounts the pixi canvas.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./knowledge-graph-canvas", () => ({
  KnowledgeGraphCanvas: () => <div data-testid="canvas" />,
}));

import { KnowledgeGraphView, type KnowledgeGraphStatus } from "./knowledge-graph-view";

const graph = {
  nodes: [{ id: "a", title: "A", inDegree: 0, outDegree: 0 }],
  edges: [],
};

function renderStatus(status: KnowledgeGraphStatus) {
  return render(
    <KnowledgeGraphView
      status={status}
      graph={graph}
      layout={{ positions: {} }}
      selectedId={null}
      onSelect={() => {}}
      onActivate={() => {}}
      onLayoutChange={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("KnowledgeGraphView", () => {
  it.each<[KnowledgeGraphStatus, RegExp]>([
    ["no-project", /Open a project first/],
    ["loading", /Building graph/],
    ["empty", /\[\[note-id\]\]/],
    ["too-large", /Graph too large — 1 nodes \(cap 1000\)/],
  ])("%s renders its copy and no canvas", (status, copy) => {
    renderStatus(status);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
  });
});
