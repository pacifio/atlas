// Build-mode flags injected by Vite. Resolved at build time — the unused
// branch in `if (isDev) { … }` is dead-code-eliminated from production
// bundles, so checks here cost zero runtime bytes.
//
// `bunx tauri dev`       → vite dev server, DEV=true, PROD=false
// `bun run build:app`    → vite production build, DEV=false, PROD=true
//
// The Rust side has the matching constant `cfg!(debug_assertions)`. The
// two are always in lock-step because Tauri compiles Rust in debug mode
// when serving from the Vite dev server and in release mode for bundled
// `.app`s.

export const isDev: boolean = import.meta.env.DEV;
