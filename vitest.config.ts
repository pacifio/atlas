import { defineConfig } from "vitest/config";
import path from "path";

// Deliberately standalone rather than extending `vite.config.ts`. That config
// carries the dev-server warmup list, `optimizeDeps` pre-bundling and the
// Rollup chunk splitter — all of it irrelevant to tests, and all of it work
// Vitest would redo on every run. Tests only need the `@` alias.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // `node` by default: the contract tests read the repo off disk and the
    // API-seam tests only need a mocked `invoke`. Files that need a DOM opt in
    // per-file with `// @vitest-environment happy-dom`.
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    // `src-tauri/target` and `crates/*/target` hold vendored dependency
    // sources; without this Vitest walks 38 GB of build artifacts.
    exclude: ["**/node_modules/**", "**/target/**", "**/dist/**"],
  },
});
