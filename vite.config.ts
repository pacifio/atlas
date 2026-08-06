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
    // CRITICAL: dedupe CodeMirror + Lezer. In production the lang packages
    // (lang-json, lang-rust, …) get lazy-imported as separate chunks and
    // each transitively imports @codemirror/{state,view,language} and
    // @lezer/{common,highlight,lr}. Without dedup Rollup can ship two copies;
    // `EditorView.theme(...)` registers against copy A's StyleModule but the
    // EditorView constructor uses copy B's, so the theme silently no-ops and
    // text renders with default styling (often invisible against the dark
    // background). The dev server doesn't hit this because Vite serves
    // pre-bundled deps as a single instance.
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
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;
          // Never route a STYLESHEET into a vendor JS chunk. `highlight.js/
          // styles/github-dark.css` matched the markdown rule below, which
          // made the entry emit a bare `import "./vendor-markdown.js"` purely
          // to attach that CSS — 554 KB of JS parsed before first paint for a
          // theme file, even after every real JS edge had been cut.
          if (id.endsWith(".css")) return undefined;
          // Tiny shared utils get their OWN chunk, and this rule must come
          // first. `cn()` (clsx + tailwind-merge) is used all over the eager
          // boot path AND by react-pdf; left unassigned, Rollup folded clsx
          // into the `vendor-pdf` manual chunk, so the entry imported a single
          // 200-byte function from a 482 KB chunk and `index.html` preloaded
          // all of pdfjs before first paint — silently defeating the lazy
          // `PdfViewer` boundary in center-panel.tsx.
          if (
            id.includes("/node_modules/clsx/") ||
            id.includes("/node_modules/tailwind-merge/")
          ) {
            return "vendor-utils";
          }
          // Language grammars are dynamically imported per-language in
          // editor/lib/languages.ts. Leaving them unassigned lets Rollup give
          // each its own chunk; folding them into `vendor-codemirror` (as the
          // old blanket `@codemirror`/`@lezer` match did) collapsed all 13
          // lazy boundaries into one chunk, so opening a JSON file loaded
          // every grammar. `@lezer/{common,highlight,lr}` are core runtime,
          // not grammars, and stay with the editor chunk.
          if (id.includes("@codemirror/lang-")) return undefined;
          if (
            id.includes("@codemirror") ||
            /@lezer\/(common|highlight|lr)\//.test(id)
          ) {
            return "vendor-codemirror";
          }
          if (id.includes("@xterm") || id.includes("/xterm/") || id.includes("/xterm-")) {
            return "vendor-xterm";
          }
          if (
            id.includes("react-markdown") ||
            id.includes("remark-") ||
            id.includes("rehype-") ||
            id.includes("shiki") ||
            id.includes("highlight.js")
          ) {
            return "vendor-markdown";
          }
          if (id.includes("@radix-ui")) {
            return "vendor-radix";
          }
          if (id.includes("@tanstack")) {
            return "vendor-tanstack";
          }
          if (id.includes("pdfjs-dist") || id.includes("react-pdf")) {
            return "vendor-pdf";
          }
          if (id.includes("@tauri-apps")) {
            return "vendor-tauri";
          }
          // Keep the heavy lazy-panel libs OUT of vendor-react. `@xyflow/react`
          // (Canvas) and `@tiptap/react` (Knowledge) are only reached through
          // lazy() panels, so they must land in their own lazy chunks — the old
          // `/react/` substring match pulled them into the EAGER vendor-react
          // chunk, loading ~500KB+ at startup and defeating those lazy boundaries.
          if (id.includes("@xyflow")) return "vendor-xyflow";
          if (id.includes("@tiptap")) return "vendor-tiptap";
          // Exact package roots only — NOT a `/react/` substring (which matches
          // @xyflow/react, @tiptap/react, react-markdown, …).
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          return undefined;
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
