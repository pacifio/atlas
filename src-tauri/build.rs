fn main() {
    // Telemetry bakes the official PostHog key/host in at compile time via
    // `option_env!` (see `src/telemetry/mod.rs`). Cargo doesn't track env vars
    // read by `option_env!` unless we tell it to, so without these the embedded
    // value would go stale across rebuilds when `.env` changes. The build is
    // normally driven through `scripts/with-posthog-env.mjs`, which loads `.env`
    // into the environment before invoking the Tauri CLI.
    println!("cargo:rerun-if-env-changed=ATLAS_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=ATLAS_POSTHOG_HOST");

    let mut windows = tauri_build::WindowsAttributes::new();
    if embed_windows_manifest_with_linker() {
        // The linker embeds the manifest for every target below, so tauri-build
        // must not also add one to the app's resource file: two manifests fail
        // the link (`CVT1100: duplicate resource. type:MANIFEST`).
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    }

    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}

/// Gives every executable this package links on Windows (MSVC) the application
/// manifest, and reports whether it did.
///
/// tauri-build embeds the manifest through the app's resource file, which Cargo
/// links into `[[bin]]` targets only. The `--lib` test executable gets none, so
/// Windows loads comctl32 v5 for it. Tauri's dialog code imports
/// `TaskDialogIndirect`, which only v6 exports, so the loader refuses to start
/// the process (`0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND`) before a single test
/// runs. `rustc-link-arg` is the one instruction that reaches unit tests:
/// `rustc-link-arg-tests` covers integration tests only.
fn embed_windows_manifest_with_linker() -> bool {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV");
    if target_os.as_deref() != Ok("windows") || target_env.as_deref() != Ok("msvc") {
        // `/MANIFEST:EMBED` is an MSVC linker option.
        return false;
    }

    let manifest = std::env::current_dir()
        .expect("build scripts run in the package directory")
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
}
