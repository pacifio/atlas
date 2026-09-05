import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Force the DOM-free build of `decode-named-character-reference`. Its
      // package `browser` condition points at `index.dom.js`, which calls
      // `document.createElement` at module scope. That module is a transitive
      // dep of the remark/micromark markdown stack, which we run inside a Web
      // Worker (markdown.worker.ts) — where `document` doesn't exist, so it
      // threw `ReferenceError: Can't find variable: document`, killed the
      // worker, and forced ALL markdown parsing onto the main thread (the
      // fallback in markdown-cache.tsx). That congested the main thread during
      // agent streaming + workspace switches. `index.js` is a table-based,
      // DOM-free build with identical output.
      "decode-named-character-reference": path.resolve(
        __dirname,
        "node_modules/decode-named-character-reference/index.js",
      ),
    },
    // Dedupe CodeMirror + Lezer. The lang packages (lang-json, lang-rust, …)
    // are lazy-imported as separate chunks and each transitively imports
    // @codemirror/{state,view,language} and @lezer/{common,highlight,lr};
    // without dedup Rollup can ship two copies, and facets/extensions from
    // one copy are invisible to an EditorView built from the other.
    //
    // NOTE (2026-09-06): "CodeMirror unstyled in production, fine in dev" was
    // NOT this. It was the Tauri CSP: a nonce injected into index.html's
    // inline <style> disables `style-src 'unsafe-inline'`, blocking every
    // runtime-injected stylesheet. See the comment in index.html and
    // `dangerousDisableAssetCspModification` in src-tauri/tauri.conf.json.
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/search",
      "@codemirror/autocomplete",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      // Single pdfjs-dist instance: react-pdf re-exports `pdfjs`, and the
      // worker is imported separately via `?url`. Two copies would mismatch
      // the worker against the main-thread API version and fail to render.
      "pdfjs-dist",
    ],
  },
  clearScreen: false,
  // Pre-bundle the heavy dependency graphs into single ESM files served as
  // one request, instead of letting Vite's dev server stream hundreds of
  // tiny `node_modules/...` modules over individual HTTP roundtrips. The
  // single biggest dev-mode startup speedup — `tauri dev` cold launch goes
  // from "8 s to open devtools" territory down to a couple of seconds
  // because the WebKit main thread isn't blocked on per-module fetches.
  // Production builds ignore this; it's purely a dev-mode optimization.
  optimizeDeps: {
    include: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/autocomplete",
      "@codemirror/search",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      "react-markdown",
      "remark-gfm",
      "rehype-highlight",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-dialog",
      "@radix-ui/react-context-menu",
      // Pre-bundle the Tiptap stack so opening the Knowledge tab for
      // the first time doesn't trigger Vite's "new dependencies
      // optimized → reloading" cycle (which dumps editor state and
      // looks like a full app reload to the user).
      "@tiptap/core",
      // NOTE: @tiptap/pm has no root export — it's only accessed via
      // subpaths (@tiptap/pm/state, /view, etc.) which Vite picks up
      // through the dep walker automatically. Including the bare name
      // here errors with "Missing '.' specifier".
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/extension-task-list",
      "@tiptap/extension-task-item",
      "@tiptap/extension-link",
      "@tiptap/extension-placeholder",
      "@tiptap/extension-typography",
      "@tiptap/extension-highlight",
      "@tiptap/extension-table",
      "@tiptap/extension-table-row",
      "@tiptap/extension-table-header",
      "@tiptap/extension-table-cell",
      "@tiptap/extension-code-block-lowlight",
      "@tiptap/extension-mention",
      "@tiptap/suggestion",
      "tiptap-markdown",
      "lowlight",
      // Pre-bundle the graph view's renderer + physics stack for the
      // same reason as Tiptap — first open of the Graph tab would
      // otherwise trigger a "new dependencies optimized → reloading"
      // cycle and dump in-progress state.
      "pixi.js",
      "matter-js",
      // Pre-bundle the PDF stack so first open of a PDF tab doesn't trigger
      // Vite's "new dependencies optimized → reloading" cycle.
      "react-pdf",
      "pdfjs-dist",
      // Terminal stack — pre-bundle so first terminal open doesn't trigger a
      // "new deps optimized → reload" cycle.
      "@xterm/xterm",
      "@xterm/addon-fit",
      "@xterm/addon-webgl",
      "@xterm/addon-unicode11",
    ],
    // The worker is a separate ESM entry loaded via `?url`; pre-bundling it
    // would rewrite its imports and break worker instantiation.
    exclude: ["pdfjs-dist/build/pdf.worker.min.mjs"],
  },
  build: {
    // Vendor splitting so the initial chunk only holds what first paint
    // needs (React + the chat panel). Heavy panel-specific vendors live in
    // their own chunks and load on demand when the user opens a tab that
    // pulls them in.
    //
    // PORTED from `rollupOptions.output.manualChunks` (a Rollup if-chain) to
    // Rolldown's `codeSplitting.groups` when Vite 8 made Rolldown the bundler.
    // The function form still "works" under Rolldown's compat shim, but it does
    // NOT preserve exclusivity: measured on this repo, `clsx` was claimed by
    // `vendor-pdf` and React's CJS build by `vendor-markdown` despite rules
    // assigning both elsewhere, which made the entry statically import ~1 MB of
    // lazy-panel vendors (rolldown#7473). `priority` is what fixes it — a
    // higher-priority group matches first and its modules are REMOVED from
    // lower-priority groups. Ordering alone cannot express that.
    //
    // Numbers are spaced by 10 so a rule can be slotted between two others
    // without renumbering the file.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Tiny shared utils, highest priority. `cn()` (clsx +
            // tailwind-merge) is used all over the eager boot path AND by
            // react-pdf. Left to a lower priority, clsx gets folded into
            // `vendor-pdf`, so the entry imports a 200-byte function from a
            // 425 KB chunk and preloads all of pdfjs before first paint —
            // silently defeating the lazy `PdfViewer` boundary in
            // center-panel.tsx. `\0vite/preload-helper` (the `__vitePreload`
            // runtime) rides along for the same reason: it is needed eagerly,
            // and wherever it lands the entry must import that chunk.
            {
              name: "vendor-utils",
              priority: 100,
              test: (id) =>
                !id.endsWith(".css") &&
                (id.includes("/node_modules/clsx/") ||
                  id.includes("/node_modules/tailwind-merge/") ||
                  id.includes("vite/preload-helper")),
            },
            // Exact package roots only — NOT a `/react/` substring (which
            // matches @xyflow/react, @tiptap/react, react-markdown, …). Above
            // vendor-markdown deliberately: react-markdown pulls React in, and
            // at equal priority React's CJS build lands in `vendor-markdown`.
            {
              name: "vendor-react",
              priority: 90,
              test: (id) =>
                !id.endsWith(".css") &&
                (id.includes("/node_modules/react/") ||
                  id.includes("/node_modules/react-dom/") ||
                  id.includes("/node_modules/scheduler/")),
            },
            // `@codemirror/lang-*` is deliberately absent from every group, so
            // each grammar keeps its own chunk. They are dynamically imported
            // per-language in editor/lib/languages.ts; capturing them here
            // collapses all 13 lazy boundaries into one chunk, so opening a
            // JSON file would load every grammar. `@lezer/{common,highlight,lr}`
            // are core runtime, not grammars, and stay with the editor chunk.
            {
              name: "vendor-codemirror",
              priority: 80,
              test: (id) =>
                !id.endsWith(".css") &&
                !id.includes("@codemirror/lang-") &&
                (id.includes("@codemirror") ||
                  /@lezer\/(common|highlight|lr)\//.test(id)),
            },
            {
              name: "vendor-xterm",
              priority: 70,
              test: (id) =>
                !id.endsWith(".css") &&
                (id.includes("@xterm") || id.includes("/xterm/") || id.includes("/xterm-")),
            },
            // Never route a STYLESHEET into a vendor JS chunk (every `test`
            // here guards `.css` for this reason). `highlight.js/styles/
            // github-dark.css` matched this rule once, which made the entry
            // emit a bare `import "./vendor-markdown.js"` purely to attach that
            // CSS — 554 KB of JS parsed before first paint for a theme file.
            {
              name: "vendor-markdown",
              priority: 60,
              test: (id) =>
                !id.endsWith(".css") &&
                (id.includes("react-markdown") ||
                  id.includes("remark-") ||
                  id.includes("rehype-") ||
                  id.includes("shiki") ||
                  id.includes("highlight.js")),
            },
            {
              name: "vendor-radix",
              priority: 50,
              test: (id) => !id.endsWith(".css") && id.includes("@radix-ui"),
            },
            {
              name: "vendor-tanstack",
              priority: 40,
              test: (id) => !id.endsWith(".css") && id.includes("@tanstack"),
            },
            {
              name: "vendor-pdf",
              priority: 30,
              test: (id) =>
                !id.endsWith(".css") &&
                (id.includes("pdfjs-dist") || id.includes("react-pdf")),
            },
            {
              name: "vendor-tauri",
              priority: 20,
              test: (id) => !id.endsWith(".css") && id.includes("@tauri-apps"),
            },
            // Keep the heavy lazy-panel libs OUT of vendor-react. `@xyflow/react`
            // (Canvas) and `@tiptap/react` (Knowledge) are only reached through
            // lazy() panels, so they must land in their own lazy chunks — an
            // earlier `/react/` substring match pulled them into the EAGER
            // vendor-react chunk, loading ~500KB+ at startup.
            {
              name: "vendor-xyflow",
              priority: 10,
              test: (id) => !id.endsWith(".css") && id.includes("@xyflow"),
            },
            {
              name: "vendor-tiptap",
              priority: 10,
              test: (id) => !id.endsWith(".css") && id.includes("@tiptap"),
            },
          ],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Only the frontend (`src/`, index.html, the config files) is part of
      // Vite's module graph; everything else in the repo is Rust, scripts,
      // docs or build output. Without ignoring them, editing ANY such file
      // while dogfooding Atlas on its own repo (e.g. tweaking `bump.sh` to
      // watch the workspace git +/- update) makes Vite bounce the whole page.
      ignored: [
        "**/src-tauri/**",
        "**/crates/**",
        "**/landing/**",
        "**/scripts/**",
        "**/dist/**",
        "**/target/**",
        "**/.atlas/**",
        "**/.git/**",
        "**/*.sh",
        "**/*.md",
      ],
    },
    // Pre-transform the boot critical-path the moment `tauri dev` starts the
    // Vite server. Without this, Vite transforms each user-source module on
    // first request, which on a 2400-module project shows up as a ~1.5 s
    // "html → main-eval" gap on cold launch. Warmup hits the cache so the
    // WebView's first request finds the module already transformed.
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/styles/globals.css",
        "./src/features/layout/components/app-layout.tsx",
        "./src/features/layout/components/center-panel.tsx",
        "./src/features/layout/components/left-panel.tsx",
        "./src/features/layout/components/right-panel.tsx",
        "./src/features/layout/stores/layout-store.ts",
        "./src/features/project/stores/project-store.ts",
        "./src/features/project/components/welcome-screen.tsx",
        "./src/features/chat/components/chat-panel.tsx",
        "./src/features/chat/components/message-input.tsx",
        "./src/features/chat/stores/chat-store.ts",
        "./src/features/chat/lib/agents-api.ts",
        "./src/components/titlebar.tsx",
        "./src/components/command-palette.tsx",
        "./src/components/atlas-icon.tsx",
      ],
    },
  },
}));
