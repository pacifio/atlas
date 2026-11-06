//! Keeps the main window on the app.
//!
//! The main webview renders content Atlas did not write — a cloned repo's
//! README, an agent's markdown, a pull request body. The renderers sanitise
//! it, but a single slip (a `<meta http-equiv="refresh">` React hoists into
//! `<head>`, a `location.href = …` in some HTML that got through) would
//! navigate the whole window to someone else's page, with the IPC bridge in
//! reach. This is the backstop: the main webview may only navigate within the
//! app's own origins. External links never needed to navigate it — they open
//! in the system browser through the opener plugin.
//!
//! Only the `main` webview is guarded. The built-in browser's webviews exist
//! to load external pages and carry their own labels.

use tauri::{plugin::TauriPlugin, Manager, Runtime, Url};

/// The label of the window `tauri.conf.json` creates.
const MAIN_LABEL: &str = "main";

/// Whether the main webview may navigate to `url`.
///
/// `dev_url` is the Vite server (`build.devUrl`), allowed in debug builds
/// only. The production origins differ by platform: `tauri://localhost` on
/// macOS and Linux, `http(s)://tauri.localhost` on Windows, and the asset
/// protocol's equivalents. `about:` covers `about:blank` and the `about:srcdoc`
/// of the HTML preview's sandboxed iframe (subframe navigations reach this
/// hook too); a `blob:` URL is judged by the origin it was minted in.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "about" => true,
        "tauri" | "asset" => url.host_str() == Some("localhost"),
        "blob" => Url::parse(url.path()).is_ok_and(|inner| is_app_url(&inner, dev_url)),
        "http" | "https" => {
            let host = url.host_str();
            if matches!(host, Some("tauri.localhost" | "asset.localhost")) {
                return true;
            }
            dev_url.is_some_and(|dev| dev.origin() == url.origin())
        }
        _ => false,
    }
}

/// A plugin whose only job is the navigation hook. A plugin, because the main
/// window comes from `tauri.conf.json`, not a builder Atlas could hand a
/// callback to.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("atlas-nav-guard")
        .on_navigation(|webview, url| {
            if webview.label() != MAIN_LABEL {
                return true;
            }
            let dev_url = if cfg!(debug_assertions) {
                webview.app_handle().config().build.dev_url.clone()
            } else {
                None
            };
            let allowed = is_app_url(url, dev_url.as_ref());
            if !allowed {
                tracing::warn!(target: "atlas::nav_guard", "blocked main-window navigation to {url}");
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_the_app_origins() {
        for ok in [
            "tauri://localhost/",
            "tauri://localhost/index.html#/settings",
            "http://tauri.localhost/",
            "https://tauri.localhost/x",
            "asset://localhost/%2Fusers%2Fme%2Fa.png",
            "http://asset.localhost/a.png",
            "about:blank",
            "about:srcdoc",
            "blob:tauri://localhost/0b7c1f1e-1d2c-4c4e-9a43-5c1f3f0f2a11",
        ] {
            assert!(is_app_url(&u(ok), None), "{ok}");
        }
    }

    #[test]
    fn allows_the_dev_server_only_when_given() {
        let dev = u("http://localhost:1420");
        assert!(is_app_url(
            &u("http://localhost:1420/src/main.tsx"),
            Some(&dev)
        ));
        assert!(!is_app_url(&u("http://localhost:1420/"), None));
        assert!(!is_app_url(&u("http://localhost:8080/"), Some(&dev)));
    }

    #[test]
    fn refuses_everything_else() {
        let dev = u("http://localhost:1420");
        for bad in [
            "https://evil.example/",
            "http://evil.example/?u=tauri.localhost",
            "https://tauri.localhost.evil.example/",
            "tauri://evil.example/",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "blob:https://evil.example/0b7c1f1e",
        ] {
            assert!(!is_app_url(&u(bad), Some(&dev)), "{bad}");
        }
    }
}
