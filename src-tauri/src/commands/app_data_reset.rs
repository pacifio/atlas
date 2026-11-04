//! Settings › Privacy › Local data, and the ⌘K palette: "Clear cache" and
//! "Reset Atlas", the in-app form of `scripts/clean-atlas-config.sh`.
//!
//! Atlas cannot delete its own data while it runs: the WebView holds its store
//! open, `threads.db` is open, and anything still running writes it back. So
//! [`app_data_reset`] only writes a marker naming the scope and asks Tauri to
//! restart. [`apply_pending`] runs first thing in the next process, before
//! logging, before the Tauri builder and so before the WebView exists, wipes
//! the directories and carries on. A reset therefore boots straight into a
//! first run, on every OS, with no helper process to outlive the app.
//!
//! The paths are resolved with `dirs` the way Tauri's own path resolver does
//! (`app_config_dir` = `dirs::config_dir()/<identifier>`, and so on), because
//! there is no `AppHandle` yet; `logging.rs` resolves the log dir the same way
//! for the same reason.
//!
//! Keep [`targets`] in step with `scripts/clean-atlas-config.sh`: the two lists
//! name the same directories. Neither touches agent CLI credentials
//! (`~/.claude` and friends), the home `~/.atlas` directory, or any project.

use std::io;
use std::path::{Path, PathBuf};

use atlas_profile::Profile;
use serde::Deserialize;
use tauri::AppHandle;

/// The marker's file name, inside the app config dir.
const MARKER: &str = "reset-pending";

/// What a reset removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetScope {
    /// The app cache dir only (WebKit's network cache lives inside it).
    Cache,
    /// Everything the script removes: sessions, settings, sign-ins, caches,
    /// WebView storage and preferences.
    All,
}

impl ResetScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cache => "cache",
            Self::All => "all",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "cache" => Some(Self::Cache),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

/// The base directories the targets hang off, injected so tests can point
/// them at a temp dir.
#[derive(Debug, Default, Clone)]
pub(crate) struct Roots {
    /// `dirs::config_dir()`: Tauri's `app_config_dir` parent.
    pub config: Option<PathBuf>,
    /// `dirs::data_dir()`: `app_data_dir`'s parent.
    pub data: Option<PathBuf>,
    /// `dirs::data_local_dir()`: `app_local_data_dir`'s parent.
    pub local_data: Option<PathBuf>,
    /// `dirs::cache_dir()`: `app_cache_dir`'s parent.
    pub cache: Option<PathBuf>,
    pub home: Option<PathBuf>,
    /// `~/.config/atlas` (or `atlas-dev`, or under `$XDG_CONFIG_HOME`).
    pub atlas_config: Option<PathBuf>,
    /// macOS only: the name WKWebView files this process's data under in
    /// `~/Library/{WebKit,Caches,Preferences}`. That is the bundle id when
    /// Atlas runs from an `.app`, and the binary's own name, `atlas`, when it
    /// runs unbundled, as `bun run dev:app` does. `None` off macOS.
    pub webkit_name: Option<String>,
}

impl Roots {
    fn system(profile: Profile) -> Self {
        Self {
            config: dirs::config_dir(),
            data: dirs::data_dir(),
            local_data: dirs::data_local_dir(),
            cache: dirs::cache_dir(),
            home: dirs::home_dir(),
            atlas_config: crate::state::atlas_config::config_root(),
            webkit_name: macos_webkit_name(profile),
        }
    }

    fn marker(&self, profile: Profile) -> Option<PathBuf> {
        Some(
            self.config
                .as_ref()?
                .join(profile.identifier())
                .join(MARKER),
        )
    }
}

#[cfg(target_os = "macos")]
fn macos_webkit_name(profile: Profile) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let bundled = exe
        .parent()
        .filter(|dir| dir.ends_with("Contents/MacOS"))
        .is_some();
    if bundled {
        return Some(profile.identifier().to_string());
    }
    // Only the name cargo gives the binary: a renamed copy must never point a
    // reset at another program's `~/Library` entries.
    (exe.file_name()? == "atlas").then(|| "atlas".to_string())
}

#[cfg(not(target_os = "macos"))]
fn macos_webkit_name(_profile: Profile) -> Option<String> {
    None
}

/// The `~/Library/Caches` and `~/Library/Preferences` names this process
/// owns on macOS: the identifier, plus the WebKit name when that differs.
fn library_names(profile: Profile, roots: &Roots) -> Vec<String> {
    let mut names = vec![profile.identifier().to_string()];
    if let Some(name) = &roots.webkit_name {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    names
}

/// The web view's own caches, inside `app_local_data_dir` where Tauri puts
/// the web view's data on Linux (WebKitGTK) and Windows (WebView2).
const WEBVIEW_CACHE_ENTRIES: &[&str] = &[
    "WebKitCache",
    "EBWebView/Default/Cache",
    "EBWebView/Default/Code Cache",
    "EBWebView/Default/GPUCache",
];

/// What a cache clear removes when the cache dir is not a directory of its own.
/// On Windows `app_cache_dir` and `app_local_data_dir` are both
/// `%LOCALAPPDATA%\<identifier>`, which also holds the logs and WebView2's
/// whole profile (its cookies and local storage), so only the subdirectories
/// Atlas's own cache writers use go. A new one belongs here too.
const SHARED_DIR_CACHE_ENTRIES: &[&str] = &[
    "notification-icons",
    "spaces-media",
    "comms-recordings",
    "comms-attachments",
    "remote-sessions",
    "pasted",
    "security",
];

/// Every file and directory `scope` removes for `profile`. Kept in step with
/// `scripts/clean-atlas-config.sh`, with one deliberate difference: the
/// script's default profile also removes the `atlas` WebKit/Caches entries,
/// which belong to an unbundled build; here each process removes only the
/// names it uses itself.
pub(crate) fn targets(scope: ResetScope, profile: Profile, roots: &Roots) -> Vec<PathBuf> {
    let id = profile.identifier();
    let names = library_names(profile, roots);
    let mut out = Vec::new();
    let under = |base: &Option<PathBuf>, out: &mut Vec<PathBuf>| {
        if let Some(base) = base {
            out.push(base.join(id));
        }
    };

    if let Some(cache) = &roots.cache {
        let app_cache = cache.join(id);
        let shared = [&roots.config, &roots.data, &roots.local_data]
            .into_iter()
            .flatten()
            .any(|base| base.join(id) == app_cache);
        if scope == ResetScope::Cache && shared {
            out.extend(SHARED_DIR_CACHE_ENTRIES.iter().map(|e| app_cache.join(e)));
        } else {
            out.push(app_cache);
        }
        // WKWebView's network cache, under the WebKit name.
        if let Some(name) = &roots.webkit_name {
            out.push(cache.join(name));
        }
    }
    if let Some(local) = &roots.local_data {
        let local = local.join(id);
        out.extend(WEBVIEW_CACHE_ENTRIES.iter().map(|e| local.join(e)));
    }
    if scope == ResetScope::All {
        under(&roots.config, &mut out);
        under(&roots.data, &mut out);
        under(&roots.local_data, &mut out);
        if let Some(dir) = &roots.atlas_config {
            out.push(dir.clone());
        }
        if let (Some(name), Some(home)) = (&roots.webkit_name, &roots.home) {
            let library = home.join("Library");
            out.push(library.join("WebKit").join(name));
            for name in &names {
                out.push(library.join("Preferences").join(format!("{name}.plist")));
            }
        }
    }
    // On macOS config, data and local data are one directory; on Windows the
    // cache and local data are. A full reset already takes the parents of the
    // per-entry cache paths, so those go too.
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    if scope == ResetScope::All {
        let whole = out.clone();
        out.retain(|p| !whole.iter().any(|w| w != p && p.starts_with(w)));
    }
    out
}

/// Remove a file or a directory tree; already gone counts as removed.
fn remove(path: &Path) -> io::Result<()> {
    let result = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) => Err(e),
    };
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// What [`apply_pending`] did, logged once logging is up.
#[derive(Debug)]
pub struct Applied {
    scope: ResetScope,
    failed: Vec<(PathBuf, String)>,
}

impl Applied {
    pub fn log(&self) {
        if self.failed.is_empty() {
            tracing::info!(scope = self.scope.as_str(), "app data reset applied");
        }
        for (path, error) in &self.failed {
            tracing::warn!(path = %path.display(), %error, "app data reset could not remove");
        }
    }
}

/// Run a reset the previous process asked for, if it asked. Call before
/// anything opens an app directory.
pub fn apply_pending(profile: Profile) -> Option<Applied> {
    let roots = Roots::system(profile);
    let applied = apply_pending_in(profile, &roots)?;
    // `defaults delete` also drops cfprefsd's cached copy, which would
    // otherwise write the plist straight back (the script does the same).
    #[cfg(target_os = "macos")]
    if applied.scope == ResetScope::All {
        for name in library_names(profile, &roots) {
            let _ = std::process::Command::new("defaults")
                .args(["delete", &name])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
    Some(applied)
}

fn apply_pending_in(profile: Profile, roots: &Roots) -> Option<Applied> {
    let marker = roots.marker(profile)?;
    let raw = std::fs::read_to_string(&marker).ok()?;
    // Gone before the wipe starts: a reset that fails must not run again on
    // every launch. A marker that can't be removed would do exactly that, so
    // then nothing runs.
    if let Err(e) = std::fs::remove_file(&marker) {
        if e.kind() != io::ErrorKind::NotFound {
            return None;
        }
    }
    let mut lines = raw.lines();
    let scope = ResetScope::parse(lines.next().unwrap_or_default())?;
    // Tauri spawns this process a moment before the old one exits, and the old
    // one's WebView helpers may still be flushing; let them finish first.
    let pid = lines.next().and_then(|l| l.trim().parse::<u32>().ok());
    if let Some(pid) = pid.filter(|&pid| pid != std::process::id()) {
        wait_for_exit(pid);
    }

    let mut failed = Vec::new();
    for path in targets(scope, profile, roots) {
        if let Err(e) = remove_retrying(&path) {
            failed.push((path, e.to_string()));
        }
    }
    Some(Applied { scope, failed })
}

/// Wait, at most five seconds, for the process that scheduled the reset.
#[cfg(unix)]
fn wait_for_exit(pid: u32) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    for _ in 0..50 {
        // SAFETY: signal 0 sends nothing; it only asks whether `pid` exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// No liveness check without more `windows` features; [`remove_retrying`]
/// waits out the old process's open handles instead.
#[cfg(not(unix))]
fn wait_for_exit(_pid: u32) {}

/// [`remove`], retried on Windows for up to five seconds: a file another
/// process still holds open cannot be deleted there, and WebView2's helper
/// processes can outlive the app for a while.
fn remove_retrying(path: &Path) -> io::Result<()> {
    let retries = if cfg!(windows) { 25 } else { 0 };
    let mut result = remove(path);
    for _ in 0..retries {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        result = remove(path);
    }
    result
}

fn write_marker(roots: &Roots, profile: Profile, scope: ResetScope) -> Result<(), String> {
    let marker = roots
        .marker(profile)
        .ok_or("couldn't find Atlas's config directory")?;
    if let Some(dir) = marker.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let contents = format!("{}\n{}\n", scope.as_str(), std::process::id());
    std::fs::write(&marker, contents).map_err(|e| e.to_string())
}

/// Schedule `scope` for the next launch and restart into it. Returns once the
/// restart is requested; the app exits through its normal quit path (agents
/// are stopped, the quit guard is skipped because a restart carries an exit
/// code).
///
/// Atlas Dev quits instead: under `bun run dev:app` the dev server stops with
/// the app, so a relaunched binary would open onto nothing. The wipe runs the
/// next time it is started.
#[tauri::command]
pub async fn app_data_reset(app: AppHandle, scope: ResetScope) -> Result<(), String> {
    let profile = atlas_profile::current();
    tauri::async_runtime::spawn_blocking(move || {
        write_marker(&Roots::system(profile), profile, scope)
    })
    .await
    .map_err(|e| e.to_string())??;
    if profile.is_dev() {
        app.exit(0);
    } else {
        app.request_restart();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `webkit` is `Roots::webkit_name`: the bundle id for an `.app`, `atlas`
    /// for an unbundled binary, `None` off macOS.
    fn roots(base: &Path, webkit: Option<&str>) -> Roots {
        Roots {
            config: Some(base.join("config")),
            data: Some(base.join("data")),
            local_data: Some(base.join("local")),
            cache: Some(base.join("cache")),
            home: Some(base.join("home")),
            atlas_config: Some(base.join("home/.config/atlas")),
            webkit_name: webkit.map(str::to_string),
        }
    }

    const APP: Option<&str> = Some("dev.atlas.ide");

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }

    #[test]
    fn cache_scope_names_only_cache_dirs() {
        let r = roots(Path::new("/r"), APP);
        assert_eq!(
            targets(ResetScope::Cache, Profile::Default, &r),
            paths(&[
                "/r/cache/dev.atlas.ide",
                "/r/local/dev.atlas.ide/WebKitCache",
                "/r/local/dev.atlas.ide/EBWebView/Default/Cache",
                "/r/local/dev.atlas.ide/EBWebView/Default/Code Cache",
                "/r/local/dev.atlas.ide/EBWebView/Default/GPUCache",
            ])
        );
        // Unbundled, WKWebView's cache is under the binary's name.
        let r = roots(Path::new("/r"), Some("atlas"));
        let dev = targets(ResetScope::Cache, Profile::Dev, &r);
        assert_eq!(
            dev[..2],
            paths(&["/r/cache/dev.atlas.ide.dev", "/r/cache/atlas"])
        );
    }

    #[test]
    fn all_scope_on_macos_matches_the_script() {
        let r = roots(Path::new("/r"), APP);
        let got = targets(ResetScope::All, Profile::Default, &r);
        assert_eq!(
            got,
            paths(&[
                "/r/cache/dev.atlas.ide",
                "/r/config/dev.atlas.ide",
                "/r/data/dev.atlas.ide",
                "/r/local/dev.atlas.ide",
                "/r/home/.config/atlas",
                "/r/home/Library/WebKit/dev.atlas.ide",
                "/r/home/Library/Preferences/dev.atlas.ide.plist",
            ])
        );
    }

    #[test]
    fn an_unbundled_dev_build_resets_its_own_webkit_names() {
        let mut r = roots(Path::new("/r"), Some("atlas"));
        r.atlas_config = Some(PathBuf::from("/r/home/.config/atlas-dev"));
        let got = targets(ResetScope::All, Profile::Dev, &r);
        for want in [
            "/r/cache/atlas",
            "/r/home/Library/WebKit/atlas",
            "/r/home/Library/Preferences/atlas.plist",
            "/r/home/Library/Preferences/dev.atlas.ide.dev.plist",
        ] {
            assert!(got.contains(&PathBuf::from(want)), "{want}");
        }
    }

    #[test]
    fn dev_and_installed_resets_share_no_path() {
        let mut dev_roots = roots(Path::new("/r"), Some("atlas"));
        dev_roots.atlas_config = Some(PathBuf::from("/r/home/.config/atlas-dev"));
        let dev = targets(ResetScope::All, Profile::Dev, &dev_roots);
        let app = targets(
            ResetScope::All,
            Profile::Default,
            &roots(Path::new("/r"), APP),
        );
        for path in &app {
            assert!(!dev.contains(path), "{}", path.display());
        }
        for path in &dev {
            assert!(
                !app.iter().any(|a| path.starts_with(a)),
                "{}",
                path.display()
            );
        }
    }

    #[test]
    fn a_cache_dir_shared_with_data_is_cleared_entry_by_entry() {
        // Windows: `dirs::cache_dir()` and `dirs::data_local_dir()` are both
        // `%LOCALAPPDATA%`.
        let mut r = roots(Path::new("/r"), None);
        r.cache = r.local_data.clone();
        let got = targets(ResetScope::Cache, Profile::Default, &r);
        assert!(!got.contains(&PathBuf::from("/r/local/dev.atlas.ide")));
        assert!(got.contains(&PathBuf::from("/r/local/dev.atlas.ide/notification-icons")));
        assert!(got.contains(&PathBuf::from(
            "/r/local/dev.atlas.ide/EBWebView/Default/Cache"
        )));
        // A full reset still takes the whole directory.
        let all = targets(ResetScope::All, Profile::Default, &r);
        assert!(all.contains(&PathBuf::from("/r/local/dev.atlas.ide")));
    }

    #[test]
    fn the_marker_names_the_scope_and_the_process() {
        let tmp = tempfile::tempdir().unwrap();
        let r = roots(tmp.path(), APP);
        write_marker(&r, Profile::Default, ResetScope::All).unwrap();
        let raw = std::fs::read_to_string(r.marker(Profile::Default).unwrap()).unwrap();
        assert_eq!(raw, format!("all\n{}\n", std::process::id()));
    }

    #[test]
    fn off_macos_there_are_no_library_or_legacy_entries() {
        let r = roots(Path::new("/r"), None);
        let got = targets(ResetScope::All, Profile::Default, &r);
        assert!(got.iter().all(|p| !p.starts_with("/r/home/Library")));
        assert!(!got.contains(&PathBuf::from("/r/cache/atlas")));
    }

    #[test]
    fn no_marker_means_nothing_happens() {
        let tmp = tempfile::tempdir().unwrap();
        let r = roots(tmp.path(), APP);
        touch(&tmp.path().join("cache/dev.atlas.ide/f"));
        assert!(apply_pending_in(Profile::Default, &r).is_none());
        assert!(tmp.path().join("cache/dev.atlas.ide/f").exists());
    }

    #[test]
    fn a_cache_reset_keeps_everything_else() {
        let tmp = tempfile::tempdir().unwrap();
        let r = roots(tmp.path(), APP);
        let p = |s: &str| tmp.path().join(s);
        touch(&p("cache/dev.atlas.ide/WebKit/blob"));
        touch(&p("config/dev.atlas.ide/state.json"));
        touch(&p("home/Library/WebKit/dev.atlas.ide/localstorage"));
        write_marker(&r, Profile::Default, ResetScope::Cache).unwrap();

        let applied = apply_pending_in(Profile::Default, &r).unwrap();
        assert!(applied.failed.is_empty());
        assert!(!p("cache/dev.atlas.ide").exists());
        assert!(p("config/dev.atlas.ide/state.json").exists());
        assert!(p("home/Library/WebKit/dev.atlas.ide/localstorage").exists());
        // The marker is consumed, so the next launch is a normal one.
        assert!(apply_pending_in(Profile::Default, &r).is_none());
    }

    #[test]
    fn a_full_reset_removes_the_profiles_data_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let r = roots(tmp.path(), APP);
        let p = |s: &str| tmp.path().join(s);
        touch(&p("config/dev.atlas.ide/atlas-session.json"));
        touch(&p("cache/dev.atlas.ide/x"));
        touch(&p("home/.config/atlas/config.toml"));
        touch(&p("home/Library/WebKit/dev.atlas.ide/x"));
        touch(&p("home/Library/Preferences/dev.atlas.ide.plist"));
        // Not Atlas's, or the other profile's: must survive.
        touch(&p("config/dev.atlas.ide.dev/state.json"));
        touch(&p("home/.claude/credentials.json"));
        write_marker(&r, Profile::Default, ResetScope::All).unwrap();

        let applied = apply_pending_in(Profile::Default, &r).unwrap();
        assert!(applied.failed.is_empty(), "{:?}", applied.failed);
        assert!(!p("config/dev.atlas.ide").exists());
        assert!(!p("cache/dev.atlas.ide").exists());
        assert!(!p("home/.config/atlas").exists());
        assert!(!p("home/Library/WebKit/dev.atlas.ide").exists());
        assert!(!p("home/Library/Preferences/dev.atlas.ide.plist").exists());
        assert!(p("config/dev.atlas.ide.dev/state.json").exists());
        assert!(p("home/.claude/credentials.json").exists());
    }

    #[test]
    fn an_unknown_scope_is_dropped_without_deleting() {
        let tmp = tempfile::tempdir().unwrap();
        let r = roots(tmp.path(), APP);
        touch(&tmp.path().join("cache/dev.atlas.ide/x"));
        touch(&r.marker(Profile::Default).unwrap());
        assert!(apply_pending_in(Profile::Default, &r).is_none());
        assert!(tmp.path().join("cache/dev.atlas.ide/x").exists());
        assert!(!r.marker(Profile::Default).unwrap().exists());
    }
}
