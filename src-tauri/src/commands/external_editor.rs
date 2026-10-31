//! External editors: which ones are installed, and opening a file or a folder
//! in one, at a line and column where the editor can take them.
//!
//! Detection looks where each editor actually puts its launcher: a CLI on
//! `PATH` (boot has already merged the login shell's `PATH` into ours, see
//! `atlas_agent_servers::host_env`), then the app bundle or install folder,
//! then JetBrains Toolbox's script folder. It walks the disk, so it runs on
//! the blocking pool, once per launch; the result is cached until the
//! Settings page asks for a refresh.
//!
//! Opening never goes through a shell. The target is one argument in an argv
//! array, the editor id must name an editor detection found, and the path must
//! be absolute (so it can never be read as a flag) and exist.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

/// The id of "the app the OS opens this path with". Always detected.
pub const SYSTEM_EDITOR_ID: &str = "system";

/// How an editor takes a position on its command line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchStyle {
    /// The VS Code family: `--goto path:line:col`.
    Goto,
    /// `path:line:col` as one argument (Zed, Sublime Text).
    Suffix,
    /// JetBrains IDEs: `--line L --column C path`, the column counted from 0.
    JetBrains,
    /// Xcode's `xed -l L path`; it takes no column.
    Xed,
    /// The system's app for the file. No position.
    System,
}

/// Where inside a macOS app bundle the launcher lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacLauncher {
    /// `Contents/Resources/app/bin/<command>` (VS Code and its forks).
    ElectronBin,
    /// `Contents/MacOS/cli`.
    ZedCli,
    /// `Contents/SharedSupport/bin/subl`.
    Sublime,
    /// No CLI inside the bundle: `open -na <bundle> --args …`.
    JetBrains,
    /// `/usr/bin/xed`, once Xcode itself is installed.
    Xcode,
}

struct EditorDef {
    id: &'static str,
    label: &'static str,
    /// CLI names, in preference order.
    commands: &'static [&'static str],
    style: LaunchStyle,
    /// macOS bundle names (without `.app`). JetBrains Toolbox appends a
    /// version (`IntelliJ IDEA 2026.1.app`), which is matched too.
    mac_apps: &'static [&'static str],
    mac_launcher: MacLauncher,
    /// Windows install folder names under `%LOCALAPPDATA%\Programs` and
    /// `Program Files` (prefix-matched for JetBrains, which appends a version).
    win_dirs: &'static [&'static str],
}

impl EditorDef {
    fn is_jetbrains(&self) -> bool {
        self.style == LaunchStyle::JetBrains
    }
}

macro_rules! jetbrains {
    ($id:literal, $label:literal, $cmd:literal, [$($app:literal),+]) => {
        EditorDef {
            id: $id,
            label: $label,
            commands: &[$cmd],
            style: LaunchStyle::JetBrains,
            mac_apps: &[$($app),+],
            mac_launcher: MacLauncher::JetBrains,
            win_dirs: &[$($app),+],
        }
    };
}

/// Every editor Atlas knows, in the order a default is picked from: the first
/// one installed is what "Open in editor" uses until the user chooses.
const EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "cursor",
        label: "Cursor",
        commands: &["cursor"],
        style: LaunchStyle::Goto,
        mac_apps: &["Cursor"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["cursor", "Cursor"],
    },
    EditorDef {
        id: "vscode",
        label: "VS Code",
        commands: &["code"],
        style: LaunchStyle::Goto,
        mac_apps: &["Visual Studio Code"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["Microsoft VS Code"],
    },
    EditorDef {
        id: "zed",
        label: "Zed",
        commands: &["zed", "zeditor"],
        style: LaunchStyle::Suffix,
        mac_apps: &["Zed"],
        mac_launcher: MacLauncher::ZedCli,
        win_dirs: &["Zed"],
    },
    EditorDef {
        id: "windsurf",
        label: "Windsurf",
        commands: &["windsurf"],
        style: LaunchStyle::Goto,
        mac_apps: &["Windsurf"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["Windsurf"],
    },
    EditorDef {
        id: "vscode-insiders",
        label: "VS Code Insiders",
        commands: &["code-insiders"],
        style: LaunchStyle::Goto,
        mac_apps: &["Visual Studio Code - Insiders"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["Microsoft VS Code Insiders"],
    },
    EditorDef {
        id: "vscodium",
        label: "VSCodium",
        commands: &["codium"],
        style: LaunchStyle::Goto,
        mac_apps: &["VSCodium"],
        mac_launcher: MacLauncher::ElectronBin,
        win_dirs: &["VSCodium"],
    },
    EditorDef {
        id: "sublime",
        label: "Sublime Text",
        commands: &["subl"],
        style: LaunchStyle::Suffix,
        mac_apps: &["Sublime Text"],
        mac_launcher: MacLauncher::Sublime,
        win_dirs: &["Sublime Text", "Sublime Text 3"],
    },
    jetbrains!(
        "idea",
        "IntelliJ IDEA",
        "idea",
        [
            "IntelliJ IDEA",
            "IntelliJ IDEA Ultimate",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Community Edition"
        ]
    ),
    jetbrains!("webstorm", "WebStorm", "webstorm", ["WebStorm"]),
    jetbrains!(
        "pycharm",
        "PyCharm",
        "pycharm",
        ["PyCharm", "PyCharm CE", "PyCharm Community Edition"]
    ),
    jetbrains!("phpstorm", "PhpStorm", "phpstorm", ["PhpStorm"]),
    jetbrains!("goland", "GoLand", "goland", ["GoLand"]),
    jetbrains!("rubymine", "RubyMine", "rubymine", ["RubyMine"]),
    jetbrains!("clion", "CLion", "clion", ["CLion"]),
    jetbrains!("rider", "Rider", "rider", ["Rider", "JetBrains Rider"]),
    jetbrains!("rustrover", "RustRover", "rustrover", ["RustRover"]),
    jetbrains!("datagrip", "DataGrip", "datagrip", ["DataGrip"]),
    EditorDef {
        id: "xcode",
        label: "Xcode",
        commands: &[],
        style: LaunchStyle::Xed,
        mac_apps: &["Xcode"],
        mac_launcher: MacLauncher::Xcode,
        win_dirs: &[],
    },
];

/// One detected editor, as the frontend sees it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditor {
    pub id: String,
    pub label: String,
}

/// How a detected editor is started.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Launcher {
    /// Run `program` with `base_args`, then the target, with `env` added to
    /// the environment.
    Program {
        program: PathBuf,
        base_args: Vec<String>,
        env: Vec<(String, PathBuf)>,
    },
    /// A macOS bundle with no CLI: `open -na <bundle> --args <target…>`.
    MacBundle(PathBuf),
    /// Hand the path to the OS (`tauri_plugin_opener::open_path`).
    System,
}

#[derive(Debug, Clone)]
struct Detected {
    id: &'static str,
    label: &'static str,
    style: LaunchStyle,
    launcher: Launcher,
}

impl Detected {
    fn system() -> Self {
        Self {
            id: SYSTEM_EDITOR_ID,
            label: "System default",
            style: LaunchStyle::System,
            launcher: Launcher::System,
        }
    }

    fn public(&self) -> ExternalEditor {
        ExternalEditor {
            id: self.id.to_string(),
            label: self.label.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// What detection reads from the environment, gathered once so the search
/// itself is a function of its inputs.
struct HostEnv {
    path_var: Option<OsString>,
    home: Option<PathBuf>,
    local_app_data: Option<PathBuf>,
    program_files: Vec<PathBuf>,
    xdg_data_home: Option<PathBuf>,
}

impl HostEnv {
    fn current() -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        Self {
            path_var: var("PATH"),
            home: dirs::home_dir(),
            local_app_data: var("LOCALAPPDATA").map(PathBuf::from),
            program_files: ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
                .iter()
                .filter_map(|name| var(name).map(PathBuf::from))
                .collect(),
            xdg_data_home: var("XDG_DATA_HOME").map(PathBuf::from),
        }
    }
}

/// The filesystem questions detection asks, so a test can answer them.
trait Probe {
    fn is_executable(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    fn list_dir(&self, path: &Path) -> Vec<String>;
    fn on_path(&self, command: &str, path_var: &OsString) -> Option<PathBuf>;
}

struct RealProbe;

impl Probe for RealProbe {
    fn is_executable(&self, path: &Path) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        if !meta.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            true
        }
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn list_dir(&self, path: &Path) -> Vec<String> {
        std::fs::read_dir(path)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn on_path(&self, command: &str, path_var: &OsString) -> Option<PathBuf> {
        atlas_agent_store::detection::find_on_path(command, path_var)
    }
}

/// `IntelliJ IDEA 2026.1.4.app` for `IntelliJ IDEA`, but never `Visual Studio
/// Code - Insiders.app` for `Visual Studio Code`: the suffix must be a version.
fn is_versioned_bundle(entry: &str, name: &str) -> bool {
    let Some(rest) = entry
        .strip_prefix(name)
        .and_then(|r| r.strip_prefix(' '))
        .and_then(|r| r.strip_suffix(".app"))
    else {
        return false;
    };
    rest.starts_with(|c: char| c.is_ascii_digit())
        && rest.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn program(path: PathBuf) -> Launcher {
    Launcher::Program {
        program: path,
        base_args: Vec::new(),
        env: Vec::new(),
    }
}

/// `PATH` without its `sbin` directories. Daemons live there, not editors,
/// and one of them is OpenZFS's event daemon, which is called `zed`.
fn path_without_sbin(path_var: &OsString) -> Option<OsString> {
    let dirs: Vec<PathBuf> = std::env::split_paths(path_var)
        .filter(|dir| !dir.components().any(|c| c.as_os_str() == "sbin"))
        .collect();
    std::env::join_paths(dirs).ok()
}

fn find_on_path(commands: &[&str], env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    let path_var = path_without_sbin(env.path_var.as_ref()?)?;
    commands
        .iter()
        .find_map(|command| probe.on_path(command, &path_var))
        .map(program)
}

fn resolve_mac(def: &EditorDef, env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    // OpenZFS installs a `zed` (its event daemon) on PATH; on a Mac the editor
    // bundle is the trustworthy one, so it is looked for first.
    let bundle_first = def.id == "zed";
    if !bundle_first && def.mac_launcher != MacLauncher::Xcode {
        if let Some(found) = find_on_path(def.commands, env, probe) {
            return Some(found);
        }
    }
    if def.is_jetbrains() {
        if let Some(home) = &env.home {
            let scripts = home.join("Library/Application Support/JetBrains/Toolbox/scripts");
            for command in def.commands {
                let script = scripts.join(command);
                if probe.is_executable(&script) {
                    return Some(program(script));
                }
            }
        }
    }
    let roots = env
        .home
        .iter()
        .map(|h| h.join("Applications"))
        .chain(std::iter::once(PathBuf::from("/Applications")));
    for root in roots {
        let mut bundles: Vec<String> = def.mac_apps.iter().map(|n| format!("{n}.app")).collect();
        if def.is_jetbrains() {
            for entry in probe.list_dir(&root) {
                if def.mac_apps.iter().any(|n| is_versioned_bundle(&entry, n)) {
                    bundles.push(entry);
                }
            }
        }
        for bundle in bundles {
            let bundle = root.join(bundle);
            if !probe.is_dir(&bundle) {
                continue;
            }
            let contents = bundle.join("Contents");
            let launcher = match def.mac_launcher {
                MacLauncher::ElectronBin => def
                    .commands
                    .iter()
                    .map(|c| contents.join("Resources/app/bin").join(c))
                    .find(|p| probe.is_executable(p))
                    .map(program),
                MacLauncher::ZedCli => Some(contents.join("MacOS/cli"))
                    .filter(|p| probe.is_executable(p))
                    .map(program),
                MacLauncher::Sublime => Some(contents.join("SharedSupport/bin/subl"))
                    .filter(|p| probe.is_executable(p))
                    .map(program),
                MacLauncher::JetBrains => Some(Launcher::MacBundle(bundle.clone())),
                // The bundle's own `xed`, with DEVELOPER_DIR naming the
                // bundle: `/usr/bin/xed` is a shim that follows
                // `xcode-select`, which can point at the Command Line Tools,
                // where there is no xed to forward to.
                MacLauncher::Xcode => Some(contents.join("Developer/usr/bin/xed"))
                    .filter(|p| probe.is_executable(p))
                    .map(|xed| Launcher::Program {
                        program: xed,
                        base_args: Vec::new(),
                        env: vec![("DEVELOPER_DIR".to_string(), contents.join("Developer"))],
                    }),
            };
            if launcher.is_some() {
                return launcher;
            }
        }
    }
    if bundle_first {
        return find_on_path(def.commands, env, probe);
    }
    None
}

fn resolve_windows(def: &EditorDef, env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    if let Some(found) = find_on_path(def.commands, env, probe) {
        return Some(found);
    }
    let mut roots: Vec<PathBuf> = env
        .local_app_data
        .iter()
        .map(|d| d.join("Programs"))
        .collect();
    roots.extend(env.program_files.iter().cloned());
    let mut candidates = Vec::new();
    if def.is_jetbrains() {
        if let Some(local) = &env.local_app_data {
            for command in def.commands {
                candidates.push(
                    local
                        .join("JetBrains/Toolbox/scripts")
                        .join(format!("{command}.cmd")),
                );
            }
        }
        for dir in roots.iter().flat_map(|r| [r.clone(), r.join("JetBrains")]) {
            for entry in probe.list_dir(&dir) {
                let matches = def
                    .win_dirs
                    .iter()
                    .any(|n| entry == *n || entry.starts_with(&format!("{n} ")));
                if !matches {
                    continue;
                }
                for command in def.commands {
                    let bin = dir.join(&entry).join("bin");
                    candidates.push(bin.join(format!("{command}64.exe")));
                    candidates.push(bin.join(format!("{command}.exe")));
                }
            }
        }
    } else {
        for root in &roots {
            for name in def.win_dirs {
                let base = root.join(name);
                for command in def.commands {
                    candidates.push(base.join("bin").join(format!("{command}.cmd")));
                    candidates.push(
                        base.join("resources/app/bin")
                            .join(format!("{command}.cmd")),
                    );
                    candidates.push(base.join("bin").join(format!("{command}.exe")));
                    candidates.push(base.join(format!("{command}.exe")));
                }
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| probe.is_executable(p))
        .map(program)
}

fn resolve_linux(def: &EditorDef, env: &HostEnv, probe: &dyn Probe) -> Option<Launcher> {
    // Zed's installer puts `~/.local/bin/zed`; distro packages name it
    // `zeditor`, because `zed` is taken by OpenZFS. Both beat a bare `zed`.
    let zed_order: &[&str] = &["zeditor", "zed"];
    let commands = if def.id == "zed" {
        zed_order
    } else {
        def.commands
    };
    if def.id == "zed" {
        if let Some(local) = env.home.as_ref().map(|h| h.join(".local/bin/zed")) {
            if probe.is_executable(&local) {
                return Some(program(local));
            }
        }
    }
    if let Some(found) = find_on_path(commands, env, probe) {
        return Some(found);
    }
    let mut dirs: Vec<PathBuf> = env.home.iter().map(|h| h.join(".local/bin")).collect();
    dirs.extend(["/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
    if def.is_jetbrains() {
        let data = env
            .xdg_data_home
            .clone()
            .or_else(|| env.home.as_ref().map(|h| h.join(".local/share")));
        if let Some(data) = data {
            dirs.push(data.join("JetBrains/Toolbox/scripts"));
        }
    }
    dirs.iter()
        .flat_map(|dir| commands.iter().map(move |c| dir.join(c)))
        .find(|p| probe.is_executable(p))
        .map(program)
}

fn resolve(
    def: &EditorDef,
    platform: Platform,
    env: &HostEnv,
    probe: &dyn Probe,
) -> Option<Launcher> {
    match platform {
        Platform::Mac => resolve_mac(def, env, probe),
        Platform::Windows if def.mac_launcher == MacLauncher::Xcode => None,
        Platform::Windows => resolve_windows(def, env, probe),
        Platform::Linux if def.mac_launcher == MacLauncher::Xcode => None,
        Platform::Linux => resolve_linux(def, env, probe),
    }
}

/// Every installed editor, in `EDITORS` order, then the system default.
fn detect(platform: Platform, env: &HostEnv, probe: &dyn Probe) -> Vec<Detected> {
    let mut found: Vec<Detected> = EDITORS
        .iter()
        .filter_map(|def| {
            resolve(def, platform, env, probe).map(|launcher| Detected {
                id: def.id,
                label: def.label,
                style: def.style,
                launcher,
            })
        })
        .collect();
    found.push(Detected::system());
    found
}

/// Detection runs at most once per launch unless refreshed. A tokio mutex,
/// held across the blocking probe, so a second caller during the first probe
/// waits for its result instead of probing again.
static DETECTED: Mutex<Option<Arc<Vec<Detected>>>> = Mutex::const_new(None);

#[expect(
    clippy::await_holding_invalid_type,
    reason = "the guard must span the probe: it is what makes a second caller wait for the first probe instead of running its own"
)]
async fn detected(refresh: bool) -> Result<Arc<Vec<Detected>>, String> {
    let mut cache = DETECTED.lock().await;
    if let (Some(list), false) = (cache.as_ref(), refresh) {
        return Ok(list.clone());
    }
    let list = tokio::task::spawn_blocking(|| {
        Arc::new(detect(Platform::current(), &HostEnv::current(), &RealProbe))
    })
    .await
    .map_err(|e| format!("editor detection failed: {e}"))?;
    *cache = Some(list.clone());
    Ok(list)
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/// A 1-based position in a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Position {
    line: u32,
    column: Option<u32>,
}

/// The target arguments for `style`: the path, with the position spelled the
/// way that editor reads it.
/// `notes:12`: a file name that a `path:line` parser would cut short.
fn name_looks_positioned(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.rsplit_once(':').is_some_and(|(stem, digits)| {
        !stem.is_empty() && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
    })
}

fn target_args(style: LaunchStyle, path: &Path, position: Option<Position>) -> Vec<OsString> {
    let suffix_style = matches!(style, LaunchStyle::Goto | LaunchStyle::Suffix);
    // The suffix parsers read `path:line:col` from the right, so a name that
    // itself ends in `:digits` must carry a full `:line:col` after it, or its
    // own digits are taken as the line. Line 1, column 1 when none was asked.
    let ambiguous = suffix_style && name_looks_positioned(path);
    let position = position
        .filter(|p| p.line > 0)
        .or(ambiguous.then_some(Position {
            line: 1,
            column: Some(1),
        }));
    let Some(Position { line, column }) = position else {
        return vec![path.as_os_str().to_owned()];
    };
    let column = column.filter(|c| *c > 0).or(ambiguous.then_some(1));
    let suffixed = || {
        let mut target = path.as_os_str().to_owned();
        target.push(format!(":{line}"));
        if let Some(column) = column {
            target.push(format!(":{column}"));
        }
        target
    };
    match style {
        LaunchStyle::Goto => vec!["--goto".into(), suffixed()],
        LaunchStyle::Suffix => vec![suffixed()],
        LaunchStyle::JetBrains => {
            let mut args: Vec<OsString> = vec!["--line".into(), line.to_string().into()];
            if let Some(column) = column {
                args.push("--column".into());
                args.push((column - 1).to_string().into());
            }
            args.push(path.as_os_str().to_owned());
            args
        }
        LaunchStyle::Xed => vec![
            "-l".into(),
            line.to_string().into(),
            path.as_os_str().to_owned(),
        ],
        LaunchStyle::System => vec![path.as_os_str().to_owned()],
    }
}

/// The program and argv that open `path` in `editor`, or `None` for the
/// system default, which goes through the opener plugin instead.
/// A program to run: what `command_for` builds and `spawn_checked` runs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchCommand {
    program: PathBuf,
    args: Vec<OsString>,
    env: Vec<(String, PathBuf)>,
}

fn command_for(
    editor: &Detected,
    path: &Path,
    position: Option<Position>,
) -> Option<LaunchCommand> {
    let target = target_args(editor.style, path, position);
    match &editor.launcher {
        Launcher::System => None,
        Launcher::Program {
            program,
            base_args,
            env,
        } => {
            let mut args: Vec<OsString> = base_args.iter().map(OsString::from).collect();
            args.extend(target);
            Some(LaunchCommand {
                program: program.clone(),
                args,
                env: env.clone(),
            })
        }
        Launcher::MacBundle(bundle) => {
            let mut args: Vec<OsString> =
                vec!["-na".into(), bundle.as_os_str().to_owned(), "--args".into()];
            args.extend(target);
            Some(LaunchCommand {
                program: PathBuf::from("/usr/bin/open"),
                args,
                env: Vec::new(),
            })
        }
    }
}

/// The file types the system's opener may be handed directly: documents,
/// media and plain-text formats whose default app *shows* them.
///
/// An allowlist, not a list of what would run. The set of extensions macOS
/// and Windows will execute, or hand to something that executes (a
/// `.terminal` file's CommandString, a `.jar`, a `.webloc` that opens any
/// URL scheme, `.scr`, `.hta`, `.wsf`, `.cpl`, `.reg`, `.url`, `.appref-ms`,
/// every scripting language an installer registers…), is open-ended and
/// grows with what the user installs; a list of what merely *displays* is
/// short and stays put. Anything else is shown in Finder / Explorer, where
/// the user decides. Source languages a double-click would run on some
/// system (`.py`, `.rb`, `.pl`, `.js`, `.sh`) are left out on purpose, as are
/// macro-enabled Office formats. Web pages are in: a browser opens a local
/// page in its sandbox.
const SAFE_SYSTEM_OPEN_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml",
    "ini", "xml", "diff", "patch", "rs", "ts", "tsx", "jsx", "mts", "cts", "go", "c", "h", "cc",
    "cpp", "hpp", "cs", "java", "kt", "swift", "m", "mm", "css", "scss", "sass", "less", "sql",
    "graphql", "proto", "vue", "svelte", "html", "htm", "png", "jpg", "jpeg", "gif", "webp", "bmp",
    "tif", "tiff", "heic", "heif", "ico", "svg", "avif", "pdf", "rtf", "doc", "docx", "xls",
    "xlsx", "ppt", "pptx", "odt", "ods", "odp", "pages", "numbers", "key", "epub", "mp3", "wav",
    "m4a", "aac", "flac", "ogg", "opus", "mp4", "m4v", "mov", "webm", "mkv", "avi",
];

/// Whether handing `path` to the system's opener could run something rather
/// than show it. A file opens only when its extension is on
/// [`SAFE_SYSTEM_OPEN_EXTENSIONS`] and, on Unix, it carries no execute bit.
/// A folder opens only when its name has no extension: one that does may be
/// a bundle the system treats as a program (`Foo.app`, `.prefPane`,
/// `.workflow`, `.pkg`).
fn system_open_would_run(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str());
    if path.is_dir() {
        return ext.is_some();
    }
    let safe = ext.is_some_and(|e| {
        SAFE_SYSTEM_OPEN_EXTENSIONS
            .iter()
            .any(|s| e.eq_ignore_ascii_case(s))
    });
    if !safe {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            return meta.is_file() && meta.permissions().mode() & 0o111 != 0;
        }
    }
    false
}

/// The system default: the app the OS opens `path` with, except for anything
/// it would run instead, which is shown in Finder / Explorer.
fn open_with_system(path: &Path) -> Result<(), String> {
    if system_open_would_run(path) {
        return tauri_plugin_opener::reveal_item_in_dir(path)
            .map_err(|e| format!("Couldn't reveal {}: {e}", path.display()));
    }
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|e| format!("Couldn't open {}: {e}", path.display()))
}

fn find_editor<'a>(list: &'a [Detected], id: &str) -> Result<&'a Detected, String> {
    if let Some(found) = list.iter().find(|d| d.id == id) {
        return Ok(found);
    }
    match EDITORS.iter().find(|def| def.id == id) {
        Some(def) => Err(format!("{} isn't installed", def.label)),
        None => Err(format!("Unknown editor: {id}")),
    }
}

/// The path as given, if it is one an editor may be handed: absolute (so it
/// can never be mistaken for a flag) and free of control characters, which no
/// real path holds and a Windows `.cmd` shim would re-parse.
fn checked_target(path: &str) -> Result<PathBuf, String> {
    if path.chars().any(char::is_control) {
        return Err("The path contains a control character".to_string());
    }
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(format!("Not an absolute path: {path}"));
    }
    Ok(target)
}

/// `"` closes the quoting a Windows batch shim (`code.cmd`) relies on; Rust
/// refuses some such arguments itself, but saying so plainly is kinder.
fn check_batch_safe(program: &Path, args: &[OsString]) -> Result<(), String> {
    let is_batch = program
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if is_batch && args.iter().any(|a| a.to_string_lossy().contains('"')) {
        return Err("This editor can't open a path containing a double quote".to_string());
    }
    Ok(())
}

/// How long a launcher is watched for an early failure before it is left to
/// run. Long enough for a CLI that cannot find its app to say so; short
/// enough that a launcher which stays in the foreground (JetBrains Toolbox
/// scripts on Linux) is not mistaken for a hang.
const LAUNCH_WATCH: std::time::Duration = std::time::Duration::from_millis(1500);

/// The most of a launcher's stderr kept for an error message.
const STDERR_KEEP: usize = 4096;

/// Start `command`, and fail with what it printed if it exits non-zero within
/// `watch`. Past that it is left running and reaped in the background.
fn spawn_checked(command: &LaunchCommand, watch: std::time::Duration) -> Result<(), String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::Mutex as StdMutex;

    check_batch_safe(&command.program, &command.args)?;
    let mut process = Command::new(&command.program);
    process
        .args(&command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (key, value) in &command.env {
        process.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a `.cmd` shim would otherwise flash a console.
        process.creation_flags(0x0800_0000);
    }
    let name = command.program.display().to_string();
    let mut child = process
        .spawn()
        .map_err(|e| format!("Couldn't start {name}: {e}"))?;

    // Drained on its own thread, all the way to EOF: a launcher that keeps
    // writing must never block on a full pipe, and the app it starts may hold
    // the pipe open long after the launcher itself has gone.
    let stderr = Arc::new(StdMutex::new(Vec::new()));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    if let Some(mut pipe) = child.stderr.take() {
        let sink = stderr.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut kept) = sink.lock() {
                    let room = STDERR_KEEP.saturating_sub(kept.len());
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
            }
            let _ = done_tx.send(());
        });
    }

    let started = std::time::Instant::now();
    while started.elapsed() < watch {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                // Let the reader catch up with what the launcher wrote
                // before it exited; a grandchild keeping the pipe open must
                // not hold the error back for long.
                let _ = done_rx.recv_timeout(std::time::Duration::from_millis(200));
                let text = stderr
                    .lock()
                    .map(|kept| String::from_utf8_lossy(&kept).trim().to_string())
                    .unwrap_or_default();
                return Err(if text.is_empty() {
                    format!("{name} exited with {status}")
                } else {
                    text
                });
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(e) => return Err(format!("Couldn't watch {name}: {e}")),
        }
    }
    // Still running: a launcher that stays in the foreground. Reap it when it
    // ends so it does not linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The installed editors, in default-preference order, ending with the system
/// default. Cached after the first call; `refresh` probes again.
#[tauri::command]
pub async fn external_editors_detect(refresh: Option<bool>) -> Result<Vec<ExternalEditor>, String> {
    let list = detected(refresh.unwrap_or(false)).await?;
    Ok(list.iter().map(Detected::public).collect())
}

/// Open `path` (a file or a folder) in the detected editor `editor`, at
/// `line`/`column` (1-based) where the editor takes them.
#[tauri::command]
pub async fn external_editor_open(
    editor: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let target = checked_target(&path)?;
    let list = detected(false).await?;
    let chosen = find_editor(&list, &editor)?.clone();
    tokio::task::spawn_blocking(move || {
        if !target.exists() {
            return Err(format!("No such file or folder: {}", target.display()));
        }
        let position = line
            .filter(|_| target.is_file())
            .map(|line| Position { line, column });
        match command_for(&chosen, &target, position) {
            Some(command) => spawn_checked(&command, LAUNCH_WATCH),
            None => open_with_system(&target),
        }
    })
    .await
    .map_err(|e| format!("opening the editor failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn def(id: &str) -> &'static EditorDef {
        EDITORS.iter().find(|d| d.id == id).expect("a known editor")
    }

    fn detected_program(id: &str, program: &str) -> Detected {
        let d = def(id);
        Detected {
            id: d.id,
            label: d.label,
            style: d.style,
            launcher: Launcher::Program {
                program: PathBuf::from(program),
                base_args: Vec::new(),
                env: Vec::new(),
            },
        }
    }

    fn argv(editor: &Detected, path: &str, position: Option<Position>) -> (String, Vec<String>) {
        let LaunchCommand { program, args, .. } =
            command_for(editor, Path::new(path), position).expect("a program");
        (
            program.to_string_lossy().into_owned(),
            args.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
        )
    }

    const SPACED: &str = "/Users/me/My Project/src/main file.rs";
    const AT: Option<Position> = Some(Position {
        line: 12,
        column: Some(5),
    });
    const LINE_ONLY: Option<Position> = Some(Position {
        line: 12,
        column: None,
    });

    #[test]
    fn the_vscode_family_takes_goto_with_line_and_column() {
        for id in [
            "vscode",
            "cursor",
            "windsurf",
            "vscode-insiders",
            "vscodium",
        ] {
            let editor = detected_program(id, "/usr/local/bin/code");
            assert_eq!(
                argv(&editor, SPACED, AT).1,
                ["--goto", &format!("{SPACED}:12:5")],
                "{id}"
            );
            assert_eq!(
                argv(&editor, SPACED, LINE_ONLY).1,
                ["--goto", &format!("{SPACED}:12")]
            );
            assert_eq!(
                argv(&editor, SPACED, None).1,
                [SPACED],
                "no position, no --goto"
            );
        }
    }

    #[test]
    fn zed_and_sublime_take_a_suffixed_path() {
        for id in ["zed", "sublime"] {
            let editor = detected_program(id, "/usr/local/bin/zed");
            assert_eq!(
                argv(&editor, SPACED, AT).1,
                [format!("{SPACED}:12:5")],
                "{id}"
            );
            assert_eq!(argv(&editor, SPACED, LINE_ONLY).1, [format!("{SPACED}:12")]);
            assert_eq!(argv(&editor, SPACED, None).1, [SPACED]);
        }
    }

    #[test]
    fn jetbrains_takes_line_and_a_zero_based_column_before_the_path() {
        let editor = detected_program("idea", "/usr/local/bin/idea");
        assert_eq!(
            argv(&editor, SPACED, AT).1,
            ["--line", "12", "--column", "4", SPACED]
        );
        assert_eq!(argv(&editor, SPACED, LINE_ONLY).1, ["--line", "12", SPACED]);
        assert_eq!(argv(&editor, SPACED, None).1, [SPACED]);
    }

    #[test]
    fn a_jetbrains_bundle_goes_through_open_with_its_args_after_args() {
        let d = def("webstorm");
        let editor = Detected {
            id: d.id,
            label: d.label,
            style: d.style,
            launcher: Launcher::MacBundle(PathBuf::from("/Applications/WebStorm.app")),
        };
        let (program, args) = argv(&editor, SPACED, AT);
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(
            args,
            [
                "-na",
                "/Applications/WebStorm.app",
                "--args",
                "--line",
                "12",
                "--column",
                "4",
                SPACED
            ]
        );
    }

    #[test]
    fn xcode_takes_a_line_but_no_column() {
        let editor = detected_program("xcode", "/usr/bin/xed");
        assert_eq!(argv(&editor, SPACED, AT).1, ["-l", "12", SPACED]);
    }

    #[test]
    fn base_args_come_before_the_target() {
        let mut editor = detected_program("cursor", "/usr/local/bin/cursor");
        editor.launcher = Launcher::Program {
            program: PathBuf::from("/usr/local/bin/cursor"),
            base_args: vec!["--reuse-window".into()],
            env: Vec::new(),
        };
        assert_eq!(
            argv(&editor, SPACED, AT).1,
            ["--reuse-window", "--goto", &format!("{SPACED}:12:5")]
        );
    }

    #[test]
    fn a_zero_line_or_column_is_no_position() {
        let editor = detected_program("vscode", "/usr/local/bin/code");
        let zero_line = Some(Position {
            line: 0,
            column: Some(3),
        });
        assert_eq!(argv(&editor, SPACED, zero_line).1, [SPACED]);
        let zero_col = Some(Position {
            line: 3,
            column: Some(0),
        });
        assert_eq!(
            argv(&editor, SPACED, zero_col).1,
            ["--goto", &format!("{SPACED}:3")]
        );
    }

    #[test]
    fn the_system_default_is_not_a_spawned_program() {
        assert!(command_for(&Detected::system(), Path::new(SPACED), AT).is_none());
    }

    #[test]
    fn unknown_and_uninstalled_ids_are_rejected() {
        let list = vec![
            detected_program("zed", "/usr/local/bin/zed"),
            Detected::system(),
        ];
        assert_eq!(find_editor(&list, "zed").unwrap().id, "zed");
        assert_eq!(find_editor(&list, "system").unwrap().id, "system");
        assert_eq!(
            find_editor(&list, "rm -rf /").unwrap_err(),
            "Unknown editor: rm -rf /"
        );
        assert_eq!(
            find_editor(&list, "vscode").unwrap_err(),
            "VS Code isn't installed"
        );
    }

    #[test]
    fn only_absolute_paths_without_control_characters_are_targets() {
        assert!(checked_target(SPACED).is_ok());
        assert!(
            checked_target("--help").is_err(),
            "a flag-looking path is relative"
        );
        assert!(checked_target("src/main.rs").is_err());
        assert!(checked_target("/tmp/a\nb").is_err());
    }

    #[test]
    fn a_batch_shim_refuses_a_double_quote() {
        let args = vec![OsString::from("C:\\a\"b")];
        assert!(check_batch_safe(Path::new("C:\\x\\code.cmd"), &args).is_err());
        assert!(check_batch_safe(Path::new("C:\\x\\zed.exe"), &args).is_ok());
    }

    #[test]
    fn versioned_bundles_match_only_a_version_suffix() {
        assert!(is_versioned_bundle(
            "IntelliJ IDEA 2026.1.4.app",
            "IntelliJ IDEA"
        ));
        assert!(!is_versioned_bundle(
            "IntelliJ IDEA CE.app",
            "IntelliJ IDEA"
        ));
        assert!(!is_versioned_bundle(
            "Visual Studio Code - Insiders.app",
            "Visual Studio Code"
        ));
    }

    #[test]
    fn editor_ids_are_unique_and_never_the_system_id() {
        let mut seen = HashSet::new();
        for d in EDITORS {
            assert!(seen.insert(d.id), "duplicate id {}", d.id);
            assert_ne!(d.id, SYSTEM_EDITOR_ID);
        }
    }

    /// A pretend disk: executables and directories. `PATH` is searched
    /// against the executables, in the order it is given.
    #[derive(Default)]
    struct FakeProbe {
        executables: HashSet<PathBuf>,
        dirs: HashMap<PathBuf, Vec<String>>,
    }

    impl Probe for FakeProbe {
        fn is_executable(&self, path: &Path) -> bool {
            self.executables.contains(path)
        }
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.contains_key(path)
        }
        fn list_dir(&self, path: &Path) -> Vec<String> {
            self.dirs.get(path).cloned().unwrap_or_default()
        }
        fn on_path(&self, command: &str, path_var: &OsString) -> Option<PathBuf> {
            std::env::split_paths(path_var)
                .map(|dir| dir.join(command))
                .find(|p| self.executables.contains(p))
        }
    }

    fn mac_env() -> HostEnv {
        HostEnv {
            path_var: Some("/usr/bin".into()),
            home: Some("/Users/me".into()),
            local_app_data: None,
            program_files: Vec::new(),
            xdg_data_home: None,
        }
    }

    #[test]
    fn mac_detection_finds_bundles_and_keeps_preference_order() {
        let mut probe = FakeProbe::default();
        let code_app = PathBuf::from("/Applications/Visual Studio Code.app");
        probe.dirs.insert(code_app.clone(), vec![]);
        probe
            .executables
            .insert(code_app.join("Contents/Resources/app/bin/code"));
        // Toolbox's versioned bundle, found by listing the folder.
        let idea_app = PathBuf::from("/Users/me/Applications/IntelliJ IDEA 2026.1.app");
        probe.dirs.insert(
            "/Users/me/Applications".into(),
            vec!["IntelliJ IDEA 2026.1.app".into()],
        );
        probe.dirs.insert(idea_app.clone(), vec![]);
        // Another `zed` on PATH loses to the Zed bundle.
        probe.executables.insert("/usr/bin/zed".into());
        let zed_app = PathBuf::from("/Applications/Zed.app");
        probe.dirs.insert(zed_app.clone(), vec![]);
        probe.executables.insert(zed_app.join("Contents/MacOS/cli"));

        let found = detect(Platform::Mac, &mac_env(), &probe);
        let ids: Vec<_> = found.iter().map(|d| d.id).collect();
        assert_eq!(ids, ["vscode", "zed", "idea", "system"]);
        assert_eq!(
            found[1].launcher,
            program(zed_app.join("Contents/MacOS/cli"))
        );
        assert_eq!(found[2].launcher, Launcher::MacBundle(idea_app));
    }

    #[test]
    fn xcode_needs_its_bundle_and_is_mac_only() {
        let mut probe = FakeProbe::default();
        probe.dirs.insert("/Applications/Xcode.app".into(), vec![]);
        let xed = PathBuf::from("/Applications/Xcode.app/Contents/Developer/usr/bin/xed");
        probe.executables.insert(xed.clone());
        let ids = |p| -> Vec<&str> { detect(p, &mac_env(), &probe).iter().map(|d| d.id).collect() };
        assert_eq!(ids(Platform::Mac), ["xcode", "system"]);
        assert_eq!(ids(Platform::Linux), ["system"]);
        // The bundle's own xed, told where its bundle is.
        let found = detect(Platform::Mac, &mac_env(), &probe);
        assert_eq!(
            found[0].launcher,
            Launcher::Program {
                program: xed,
                base_args: Vec::new(),
                env: vec![(
                    "DEVELOPER_DIR".to_string(),
                    PathBuf::from("/Applications/Xcode.app/Contents/Developer")
                )],
            }
        );
    }

    #[test]
    fn linux_detection_reads_path_then_toolbox_scripts() {
        let mut probe = FakeProbe::default();
        probe.executables.insert("/usr/bin/subl".into());
        probe
            .executables
            .insert("/home/me/.local/share/JetBrains/Toolbox/scripts/pycharm".into());
        let env = HostEnv {
            path_var: Some("/usr/bin".into()),
            home: Some("/home/me".into()),
            local_app_data: None,
            program_files: Vec::new(),
            xdg_data_home: None,
        };
        let ids: Vec<_> = detect(Platform::Linux, &env, &probe)
            .iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, ["sublime", "pycharm", "system"]);
    }

    fn linux_env(path: &str) -> HostEnv {
        HostEnv {
            path_var: Some(path.into()),
            home: Some("/home/me".into()),
            local_app_data: None,
            program_files: Vec::new(),
            xdg_data_home: None,
        }
    }

    fn ids(platform: Platform, env: &HostEnv, probe: &FakeProbe) -> Vec<&'static str> {
        detect(platform, env, probe).iter().map(|d| d.id).collect()
    }

    #[test]
    fn the_zfs_event_daemon_in_sbin_is_not_zed() {
        let mut probe = FakeProbe::default();
        probe.executables.insert("/usr/sbin/zed".into());
        assert_eq!(
            ids(Platform::Linux, &linux_env("/usr/sbin:/usr/bin"), &probe),
            ["system"]
        );
        let mac = HostEnv {
            path_var: Some("/usr/local/sbin:/usr/bin".into()),
            ..mac_env()
        };
        probe.executables.insert("/usr/local/sbin/zed".into());
        assert_eq!(ids(Platform::Mac, &mac, &probe), ["system"]);
    }

    #[test]
    fn linux_zed_prefers_its_own_install_then_zeditor() {
        let mut probe = FakeProbe::default();
        probe.executables.insert("/usr/bin/zed".into());
        probe.executables.insert("/usr/bin/zeditor".into());
        let env = linux_env("/usr/bin");
        let launcher = |probe: &FakeProbe| detect(Platform::Linux, &env, probe)[0].launcher.clone();
        assert_eq!(launcher(&probe), program("/usr/bin/zeditor".into()));
        probe.executables.insert("/home/me/.local/bin/zed".into());
        assert_eq!(launcher(&probe), program("/home/me/.local/bin/zed".into()));
    }

    #[test]
    fn a_name_ending_in_digits_gets_an_explicit_position() {
        let odd = "/p/notes:12";
        for id in ["zed", "sublime"] {
            let editor = detected_program(id, "/usr/local/bin/zed");
            assert_eq!(argv(&editor, odd, None).1, [format!("{odd}:1:1")], "{id}");
            assert_eq!(argv(&editor, odd, LINE_ONLY).1, [format!("{odd}:12:1")]);
            assert_eq!(argv(&editor, odd, AT).1, [format!("{odd}:12:5")]);
        }
        let code = detected_program("vscode", "/usr/local/bin/code");
        assert_eq!(argv(&code, odd, None).1, ["--goto", &format!("{odd}:1:1")]);
        // JetBrains takes the position as flags, so the name needs nothing.
        let idea = detected_program("idea", "/usr/local/bin/idea");
        assert_eq!(argv(&idea, odd, None).1, [odd]);
        // Only a whole run of digits after the last colon counts.
        assert!(!name_looks_positioned(Path::new("/p/a:b")));
        assert!(!name_looks_positioned(Path::new("/p/:12")));
        assert!(!name_looks_positioned(Path::new("/p:12/a")));
    }

    #[test]
    fn the_system_default_refuses_to_run_what_it_would_execute() {
        for name in [
            // Windows programs, scripts and shortcuts.
            "setup.exe",
            "run.BAT",
            "x.cmd",
            "x.com",
            "x.ps1",
            "x.js",
            "x.vbs",
            "x.lnk",
            "x.msi",
            "x.scr",
            "x.hta",
            "x.wsf",
            "x.jse",
            "x.vbe",
            "x.cpl",
            "x.msc",
            "x.reg",
            "x.url",
            "x.pif",
            "x.appref-ms",
            // macOS: a Terminal settings file runs its CommandString, a jar
            // runs, and the location files open any URL scheme.
            "Calculator.app",
            "go.command",
            "x.tool",
            "setup.terminal",
            "x.jar",
            "x.webloc",
            "x.inetloc",
            "x.fileloc",
            // Interpreted source some system would run on a double-click.
            "x.py",
            "x.rb",
            "x.pl",
            "x.sh",
            // Macro-enabled Office formats, and anything unknown.
            "x.docm",
            "x.xlsm",
            "x.whatever",
            // No extension at all.
            "Makefile",
        ] {
            assert!(
                system_open_would_run(Path::new(&format!("/nowhere/{name}"))),
                "{name}"
            );
        }
    }

    #[test]
    fn the_system_default_opens_documents_media_and_text() {
        for name in [
            "notes.md",
            "README.TXT",
            "data.csv",
            "photo.JPG",
            "shot.png",
            "report.pdf",
            "deck.pptx",
            "clip.mov",
            "main.rs",
            "page.html",
        ] {
            assert!(
                !system_open_would_run(Path::new(&format!("/nowhere/{name}"))),
                "{name}"
            );
        }
    }

    #[test]
    fn the_system_default_checks_the_execute_bit_and_bundle_folders() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("build.txt");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        assert!(!system_open_would_run(&script));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(system_open_would_run(&script));
        }
        // A plain folder opens in the file manager; its execute bit is search
        // permission, not "run me".
        assert!(!system_open_would_run(dir.path()));
        // A folder with an extension may be a bundle the system runs.
        let bundle = dir.path().join("Evil.app");
        std::fs::create_dir(&bundle).unwrap();
        assert!(system_open_would_run(&bundle));
        let pane = dir.path().join("Evil.prefPane");
        std::fs::create_dir(&pane).unwrap();
        assert!(system_open_would_run(&pane));
    }

    #[cfg(unix)]
    fn sh(script: &str) -> LaunchCommand {
        LaunchCommand {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_that_fails_fast_reports_its_stderr() {
        let err = spawn_checked(&sh("echo '  no such app  ' >&2; exit 3"), LAUNCH_WATCH)
            .expect_err("a non-zero exit is a failure");
        assert_eq!(err, "no such app");
        let silent = spawn_checked(&sh("exit 4"), LAUNCH_WATCH).expect_err("still a failure");
        assert!(silent.contains("exited with"), "{silent}");
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_that_succeeds_or_stays_in_the_foreground_is_fine() {
        assert_eq!(spawn_checked(&sh("exit 0"), LAUNCH_WATCH), Ok(()));
        let started = std::time::Instant::now();
        let watch = std::time::Duration::from_millis(200);
        assert_eq!(spawn_checked(&sh("sleep 5"), watch), Ok(()));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "not waited out"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_launch_environment_reaches_the_launcher() {
        let mut command =
            sh("[ \"$DEVELOPER_DIR\" = /x/Developer ] || { echo wrong >&2; exit 1; }");
        command.env = vec![("DEVELOPER_DIR".into(), "/x/Developer".into())];
        assert_eq!(spawn_checked(&command, LAUNCH_WATCH), Ok(()));
    }
}
