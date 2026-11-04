import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The graph components destroy their pixi `Application` through
 * `destroyPixiApp`, never directly.
 *
 * `destroy(true, …)` reads as "remove the canvas" but also means
 * `releaseGlobalResources`, which frees pixi's process-global batch, texture
 * and canvas pools while the OTHER live renderer still uses them. That one
 * throws inside `DefaultBatcher.break` a frame later, too late for any
 * try/catch around the destroy to see. `src/lib/pixi-app.ts` exists to count
 * live Applications and release the pools only with the last one; this guards
 * the two call sites so the shorthand cannot come back.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = [
  "src/features/knowledge/components/views/knowledge-graph-canvas.tsx",
  "src/features/memory/components/views/memory-graph-canvas-view.tsx",
];

describe("the graph components", () => {
  it("never call Application.destroy directly", () => {
    for (const rel of SOURCES) {
      const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(text, `${rel} must destroy its Application via destroyPixiApp`).not.toMatch(
        /\.destroy\(\s*true/,
      );
      expect(text, `${rel} must register its Application`).toContain("registerPixiApp(app)");
    }
  });
});
