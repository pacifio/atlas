//! Projects attached to a session: the commands the composer drives, the
//! path rules every attach goes through, and the bridge that lets an agent
//! ask for one (`request_project_access` on the code tool server).
//!
//! An attached project is a folder the session may use besides its own, at
//! an access level: read-only (the default) or read and write. It is a
//! property of the session — remembered across turns and across a resume,
//! and carried on the session row — not of one message. The store keeps it
//! (`atlas_thread_metadata::AttachedProject`); the host turns it into roots
//! for the agent ([`AgentHost::attach_session_project`] and friends).
//!
//! Keyed by the live session id, like `threads_mark_viewed`: that is what a
//! tab, and an agent's tool call, know. The host finds the row through the
//! live binding, so a draft (no message sent yet) can have projects attached
//! too.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use atlas_agent_wire::ErrorClass;
use atlas_thread_metadata::{AttachSource, AttachedProject, ProjectAccess};
use futures::future::BoxFuture;
use tauri::State;

use super::agent_host::{
    display_path, AccessRequestOutcome, AgentHost, AttachedProjectWire, ProjectAccessRequest,
    SessionProjectsChange,
};
use super::agents::CmdError;

/// How long an agent's access request keeps its tool call open waiting for
/// the user (ADR-0008: every hop is bounded). Under a minute, because that is
/// the shortest tool-call timeout an MCP client commonly applies; past it the
/// agent is told the request is still on screen, and a later approval still
/// attaches the project.
pub const ACCESS_REQUEST_WAIT: Duration = Duration::from_secs(45);

/// The projects attached to the session the tab `sessionId` runs, in the
/// order they were attached.
#[tauri::command(async)]
pub fn session_projects_list(
    session_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<AttachedProjectWire>, CmdError> {
    Ok(host
        .session_projects(&session_id)?
        .iter()
        .map(AttachedProjectWire::from)
        .collect())
}

/// Attach the folder at `path` to the session. `access` defaults to
/// read-only and `source` to a mention. The folder must exist and pass
/// [`validate_project_path`]. Attaching a folder that is already attached
/// changes nothing (and never lowers its access).
#[tauri::command]
pub async fn session_projects_attach(
    session_id: String,
    path: String,
    display_name: Option<String>,
    access: Option<String>,
    source: Option<String>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionProjectsChange, CmdError> {
    let access = parse_access(access.as_deref().unwrap_or("read_only"))?;
    let source = match source.as_deref() {
        None => AttachSource::Mention,
        Some(raw) => AttachSource::parse(raw)
            .ok_or_else(|| CmdError::new(format!("not a source: {raw}"), ErrorClass::Fatal))?,
    };
    // Canonicalising and the git check touch the disk.
    let valid = tokio::task::spawn_blocking(move || validate_project_path(&path))
        .await
        .map_err(|e| CmdError::new(e.to_string(), ErrorClass::Fatal))?
        .map_err(|e| CmdError::new(e, ErrorClass::Fatal))?;
    let name = display_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(valid.display_name);
    let project = AttachedProject::new(valid.path, name, access, source);
    Ok(host.attach_session_project(&session_id, project).await?)
}

/// Detach the project at `path` (as the list gave it) from the session.
#[tauri::command]
pub async fn session_projects_detach(
    session_id: String,
    path: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionProjectsChange, CmdError> {
    Ok(host
        .detach_session_project(&session_id, Path::new(&path))
        .await?)
}

/// Change what the agent may do in the project at `path`: `read_only` or
/// `read_write`.
#[tauri::command]
pub async fn session_projects_set_access(
    session_id: String,
    path: String,
    access: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionProjectsChange, CmdError> {
    let access = parse_access(&access)?;
    Ok(host
        .set_session_project_access(&session_id, Path::new(&path), access)
        .await?)
}

fn parse_access(raw: &str) -> Result<ProjectAccess, CmdError> {
    ProjectAccess::parse(raw)
        .ok_or_else(|| CmdError::new(format!("not an access level: {raw}"), ErrorClass::Fatal))
}

// ------------------------------------------------------------ path rules

/// A folder that may be attached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidProjectPath {
    /// Canonical and absolute.
    pub path: PathBuf,
    /// The folder's own name.
    pub display_name: String,
    /// The folder is a git repository, or inside one.
    pub in_git_repository: bool,
}

/// Whether `raw` names a folder a session may have attached, and if so its
/// canonical form. Blocking (it reads the disk); call it off the runtime.
///
/// Refused: anything that is not an existing directory; the filesystem root;
/// the home folder and every folder above it (attaching them would hand an
/// agent everything the user owns); system folders and everything under
/// them; and, under the home folder, `Library` and the dot-folders (`.ssh`,
/// `.aws`, `.config` …), which hold keys and settings rather than projects.
/// On Windows the same, in its terms: every drive root, the system and
/// program folders, `C:\Users`, and `AppData` under home ([`PathRules`]).
/// A leading `~` is the home folder.
pub fn validate_project_path(raw: &str) -> Result<ValidProjectPath, String> {
    validate_project_path_in(raw, dirs::home_dir().as_deref())
}

/// How a platform spells paths, for [`PathRules`]. Both are parsed by hand,
/// over strings, so the Windows rules run (and are tested) on every
/// platform: `std::path::Path` only knows the platform it was built for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathStyle {
    /// `/`-separated, compared as spelled.
    Posix,
    /// `\` or `/`-separated, case-insensitive, led by a drive or a UNC
    /// share, and possibly in the verbatim `\\?\` form `canonicalize`
    /// returns.
    Windows,
}

/// Why a canonical folder may not be attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The home folder, or a folder above it (a filesystem or drive root).
    HomeOrAbove,
    /// A settings tree under home: a dot-folder, `Library`, `AppData`.
    Settings,
    /// A system folder, a drive root, or a folder of everyone's homes.
    System,
}

/// The attach rules for one platform. Plain data, so [`PathRules::refusal`]
/// is a pure function of the path's components.
pub(crate) struct PathRules {
    style: PathStyle,
    /// Refused along with everything under them. Normalised components.
    trees: Vec<Vec<String>>,
    /// Refused themselves, though a project may live under them.
    containers: Vec<Vec<String>>,
    /// The folder directly under home that holds settings rather than
    /// projects (`Library`, `AppData`), normalised. Dot-folders under home
    /// are refused on every platform.
    settings_folder: &'static str,
}

/// Top-level folders that are the system's on macOS and Linux, refused
/// along with everything under them.
const POSIX_SYSTEM_TREES: &[&str] = &[
    "/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/var", "/private", "/dev", "/proc",
    "/sys", "/boot", "/root", "/cores", "/run", "/snap",
];

/// Folders refused themselves on macOS and Linux, though a project may live
/// under them.
const POSIX_CONTAINER_ROOTS: &[&str] = &[
    "/",
    "/Users",
    "/home",
    "/Volumes",
    "/opt",
    "/Applications",
    "/tmp",
    "/mnt",
    "/media",
    "/srv",
];

impl PathRules {
    pub(crate) fn posix() -> Self {
        let parse = |path: &&str| components(path, PathStyle::Posix);
        Self {
            style: PathStyle::Posix,
            trees: POSIX_SYSTEM_TREES.iter().map(parse).collect(),
            containers: POSIX_CONTAINER_ROOTS.iter().map(parse).collect(),
            settings_folder: "Library",
        }
    }

    /// Windows' rules, its system folders read through `env` (the variables
    /// Windows sets for them) and falling back to the stock locations. Every
    /// drive root is refused by [`PathRules::refusal`] itself, whatever the
    /// environment says.
    // Built only on Windows outside the tests, which run it everywhere.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn windows(env: impl Fn(&str) -> Option<String>) -> Self {
        let var = |key: &str, default: String| {
            env(key)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(default)
        };
        let drive = var("SystemDrive", "C:".to_owned());
        let trees = [
            var("SystemRoot", format!(r"{drive}\Windows")),
            var("ProgramFiles", format!(r"{drive}\Program Files")),
            var("ProgramFiles(x86)", format!(r"{drive}\Program Files (x86)")),
            var("ProgramData", format!(r"{drive}\ProgramData")),
        ];
        Self {
            style: PathStyle::Windows,
            trees: trees
                .iter()
                .map(|path| components(path, PathStyle::Windows))
                .collect(),
            containers: vec![components(&format!(r"{drive}\Users"), PathStyle::Windows)],
            settings_folder: "appdata",
        }
    }

    /// The rules for the platform Atlas is running on.
    pub(crate) fn native() -> Self {
        #[cfg(windows)]
        {
            Self::windows(|key| std::env::var(key).ok())
        }
        #[cfg(not(windows))]
        {
            Self::posix()
        }
    }

    /// Why the canonical `path` may not be attached, given the canonical
    /// `home`; `None` when it may.
    pub(crate) fn refusal(&self, path: &str, home: Option<&str>) -> Option<Refusal> {
        let path = components(path, self.style);
        if let Some(home) = home.map(|home| components(home, self.style)) {
            if home.starts_with(&path) {
                return Some(Refusal::HomeOrAbove);
            }
            // Inside the home folder only its settings trees are refused;
            // the system lists are for everything else (a home that itself
            // lives under `/private` or `/var` must not refuse every project
            // in it).
            if let Some(rest) = path.strip_prefix(home.as_slice()) {
                let first = rest.first().map(String::as_str).unwrap_or_default();
                return (first.starts_with('.') || first == self.settings_folder)
                    .then_some(Refusal::Settings);
            }
        }
        // A drive root (`C:\`) or a UNC share (`\\server\share`) is a single
        // component on Windows. The POSIX root is no components, and listed.
        let drive_root = self.style == PathStyle::Windows && path.len() <= 1;
        (drive_root
            || self.containers.contains(&path)
            || self.trees.iter().any(|tree| path.starts_with(tree)))
        .then_some(Refusal::System)
    }
}

/// A path's components, normalised for comparison under `style`. On
/// Windows the verbatim prefix is stripped (`\\?\C:\x` reads as `C:\x`,
/// `\\?\UNC\server\share` as `\\server\share`), either slash separates, the
/// drive or the UNC server-and-share is one component, and everything is
/// case-folded.
fn components(path: &str, style: PathStyle) -> Vec<String> {
    let keep = |c: &&str| !c.is_empty() && *c != ".";
    match style {
        PathStyle::Posix => path.split('/').filter(keep).map(str::to_owned).collect(),
        PathStyle::Windows => {
            let path = path.replace('/', r"\");
            let (unc, rest) = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
                (true, rest)
            } else if let Some(rest) = path
                .strip_prefix(r"\\?\")
                .or_else(|| path.strip_prefix(r"\\.\"))
            {
                (false, rest)
            } else if let Some(rest) = path.strip_prefix(r"\\") {
                (true, rest)
            } else {
                (false, path.as_str())
            };
            let mut parts = rest.split('\\').filter(keep).map(str::to_lowercase);
            let mut out = Vec::new();
            if unc {
                let server = parts.next().unwrap_or_default();
                let share = parts.next().unwrap_or_default();
                out.push(format!(r"\\{server}\{share}"));
            }
            out.extend(parts);
            out
        }
    }
}

pub(crate) fn validate_project_path_in(
    raw: &str,
    home: Option<&Path>,
) -> Result<ValidProjectPath, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("No folder given.".into());
    }
    let expanded = match (raw.strip_prefix('~'), home) {
        (Some(rest), Some(home))
            if rest.is_empty() || rest.starts_with(['/', std::path::MAIN_SEPARATOR]) =>
        {
            home.join(rest.trim_start_matches(['/', std::path::MAIN_SEPARATOR]))
        }
        _ => PathBuf::from(raw),
    };
    if !expanded.is_absolute() {
        return Err(format!("{raw} is not an absolute path."));
    }
    let path = std::fs::canonicalize(&expanded)
        .map_err(|e| format!("{} cannot be opened: {e}", expanded.display()))?;
    if !path.is_dir() {
        return Err(format!("{} is not a folder.", path.display()));
    }
    let shown = display_path(&path);
    let home = home.map(|h| std::fs::canonicalize(h).unwrap_or_else(|_| h.to_path_buf()));
    let home = home.as_deref().map(Path::to_string_lossy);
    match PathRules::native().refusal(&path.to_string_lossy(), home.as_deref()) {
        Some(Refusal::HomeOrAbove) => {
            return Err(format!(
                "{shown} is your home folder or above it; attach a project inside it instead."
            ));
        }
        Some(Refusal::Settings) => {
            return Err(format!(
                "{shown} holds settings or keys, not a project, and cannot be attached."
            ));
        }
        Some(Refusal::System) => {
            return Err(format!("{shown} is a system folder, not a project."));
        }
        None => {}
    }
    let display_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| shown.clone());
    let in_git_repository = path.ancestors().any(|dir| dir.join(".git").exists());
    Ok(ValidProjectPath {
        path,
        display_name,
        in_git_repository,
    })
}

// ------------------------------------------------- the agent asks for one

/// What the code tool server's `request_project_access` asks the host. A
/// trait so the tool server stays testable without a host.
pub trait ProjectAccessBroker: Send + Sync {
    /// Ask the user, in session `session_id` (launched in `cwd`), to let its
    /// agent use `path` at `access`. Resolves to the text the agent is told:
    /// granted, denied, or still waiting. `Err` is a request that could not
    /// be made at all (a refused path, no such session).
    fn request(
        &self,
        session_id: String,
        cwd: String,
        path: String,
        access: ProjectAccess,
        reason: Option<String>,
    ) -> BoxFuture<'static, Result<String, String>>;
}

/// The host's broker. Weak: the host owns the tool servers' wiring, not the
/// other way round.
pub struct HostAccessBroker(pub Weak<AgentHost>);

impl ProjectAccessBroker for HostAccessBroker {
    fn request(
        &self,
        session_id: String,
        cwd: String,
        path: String,
        access: ProjectAccess,
        reason: Option<String>,
    ) -> BoxFuture<'static, Result<String, String>> {
        let host = self.0.clone();
        Box::pin(async move {
            let host = host.upgrade().ok_or("Atlas is shutting down.")?;
            let valid = tokio::task::spawn_blocking(move || validate_project_path(&path))
                .await
                .map_err(|e| e.to_string())??;
            let cwd = std::fs::canonicalize(&cwd).unwrap_or_else(|_| PathBuf::from(&cwd));
            if valid.path.starts_with(&cwd) {
                return Ok(format!(
                    "{} is inside your working directory already; no access needed.",
                    valid.path.display()
                ));
            }
            let request = ProjectAccessRequest {
                display_name: valid.display_name,
                path: valid.path.clone(),
                access,
                reason,
                in_git_repository: valid.in_git_repository,
            };
            let outcome = host
                .request_project_access(&session_id, request, ACCESS_REQUEST_WAIT)
                .await
                .map_err(|e| e.message)?;
            Ok(outcome_text(&valid.path, access, &outcome))
        })
    }
}

/// What the agent is told about its request.
pub(crate) fn outcome_text(
    path: &Path,
    asked: ProjectAccess,
    outcome: &AccessRequestOutcome,
) -> String {
    let path = path.display();
    let level = |access: ProjectAccess| match access {
        ProjectAccess::ReadWrite => "read and write",
        ProjectAccess::ReadOnly => "read-only",
    };
    match outcome {
        AccessRequestOutcome::Granted {
            access,
            applied_live,
        } => {
            let narrowed = if *access != asked {
                " (the user chose read-only, not the write access you asked for)"
            } else {
                ""
            };
            let when = if *applied_live {
                "Your sandbox includes it from your next turn; this turn keeps the access it \
                 started with."
            } else {
                "Atlas's own file tools can use it now. Your own sandbox picks it up when this \
                 session is next opened."
            };
            format!(
                "Granted: {path} is attached to this session, {}{narrowed}. {when}",
                level(*access)
            )
        }
        AccessRequestOutcome::AlreadyGranted(access) => format!(
            "{path} is already attached to this session, {}. No request was needed.",
            level(*access)
        ),
        AccessRequestOutcome::Denied => format!(
            "Denied: the user did not grant access to {path}. Do not use it; carry on without it \
             or ask the user what to do instead."
        ),
        AccessRequestOutcome::Pending => format!(
            "The request for {path} is still waiting for the user. It stays on screen; carry on \
             with what you can, and call request_project_access again later to learn the answer."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap().join("home");
        std::fs::create_dir_all(home.join("work/server/.git")).unwrap();
        std::fs::create_dir_all(home.join("work/plain")).unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(home.join("Library/Keychains")).unwrap();
        (dir, home)
    }

    #[test]
    fn a_project_folder_under_home_is_accepted_and_canonicalised() {
        let (_dir, home) = fixture();
        let ok = validate_project_path_in("~/work/server/./", Some(&home)).unwrap();
        assert_eq!(ok.path, home.join("work/server"));
        assert_eq!(ok.display_name, "server");
        assert!(ok.in_git_repository);
        let plain =
            validate_project_path_in(home.join("work/plain").to_str().unwrap(), Some(&home))
                .unwrap();
        assert!(!plain.in_git_repository);
    }

    #[test]
    fn root_home_and_above_home_are_refused() {
        let (_dir, home) = fixture();
        assert!(validate_project_path_in("/", Some(&home)).is_err());
        assert!(validate_project_path_in("~", Some(&home)).is_err());
        let parent = home.parent().unwrap().to_str().unwrap().to_string();
        assert!(validate_project_path_in(&parent, Some(&home)).is_err());
    }

    #[test]
    fn system_folders_and_secret_folders_are_refused() {
        let (_dir, home) = fixture();
        for path in ["/usr", "/etc", "/System", "/private/etc"] {
            if Path::new(path).exists() {
                assert!(
                    validate_project_path_in(path, Some(&home)).is_err(),
                    "{path} must be refused"
                );
            }
        }
        assert!(validate_project_path_in("~/.ssh", Some(&home)).is_err());
        assert!(validate_project_path_in("~/Library/Keychains", Some(&home)).is_err());
    }

    /// The Windows rules, run on every platform: `canonicalize` hands them
    /// the verbatim form, in whatever case the user typed.
    #[test]
    fn windows_paths_are_judged_by_windows_rules() {
        let rules = PathRules::windows(|_| None);
        let home = Some(r"\\?\C:\Users\me");
        let cases: &[(&str, Option<Refusal>)] = &[
            // Drive roots and UNC shares.
            (r"\\?\C:\", Some(Refusal::HomeOrAbove)),
            (r"\\?\D:\", Some(Refusal::System)),
            (r"D:", Some(Refusal::System)),
            (r"\\?\UNC\server\share", Some(Refusal::System)),
            (r"\\server\share\", Some(Refusal::System)),
            // System and program folders, and what is under them.
            (r"\\?\C:\Windows", Some(Refusal::System)),
            (r"\\?\c:\WINDOWS\System32", Some(Refusal::System)),
            (r"\\?\C:\Program Files", Some(Refusal::System)),
            (r"\\?\C:\Program Files (x86)\Vendor", Some(Refusal::System)),
            (r"\\?\C:\ProgramData\keys", Some(Refusal::System)),
            (r"C:/ProgramData", Some(Refusal::System)),
            // Home, above it, and its settings trees.
            (r"\\?\C:\Users", Some(Refusal::HomeOrAbove)),
            (r"\\?\C:\Users\me", Some(Refusal::HomeOrAbove)),
            (r"\\?\c:\users\ME", Some(Refusal::HomeOrAbove)),
            (r"\\?\C:\Users\me\AppData\Roaming", Some(Refusal::Settings)),
            (r"\\?\C:\Users\me\appdata", Some(Refusal::Settings)),
            (r"\\?\C:\Users\me\.ssh", Some(Refusal::Settings)),
            // Projects.
            (r"\\?\C:\Users\me\work\server", None),
            (r"\\?\D:\src\atlas", None),
            (r"\\?\UNC\server\share\repo", None),
            (r"C:\Users\me\Documents\AppData", None),
        ];
        for (path, expected) in cases {
            assert_eq!(rules.refusal(path, home), *expected, "{path}");
        }
        // Another user's home is under the `Users` container, not refused by it.
        assert_eq!(rules.refusal(r"C:\Users\them\repo", home), None);
        // With no home known, the containers and trees still hold.
        assert_eq!(rules.refusal(r"\\?\C:\Users", None), Some(Refusal::System));
        assert_eq!(rules.refusal(r"\\?\C:\", None), Some(Refusal::System));
    }

    #[test]
    fn windows_system_folders_follow_the_environment() {
        let rules = PathRules::windows(|key| match key {
            "SystemRoot" => Some(r"E:\WinNT".to_owned()),
            "ProgramFiles" => Some(r"E:\Apps".to_owned()),
            _ => None,
        });
        assert_eq!(
            rules.refusal(r"\\?\E:\WinNT\Temp", None),
            Some(Refusal::System)
        );
        assert_eq!(rules.refusal(r"\\?\E:\Apps", None), Some(Refusal::System));
        assert_eq!(
            rules.refusal(r"\\?\C:\ProgramData", None),
            Some(Refusal::System)
        );
        assert_eq!(
            rules.refusal(r"\\?\C:\Windows\x", None),
            None,
            "not this machine's"
        );
    }

    /// The POSIX rules as a table, independent of what exists on disk.
    #[test]
    fn posix_paths_are_judged_by_posix_rules() {
        let rules = PathRules::posix();
        let home = Some("/Users/me");
        let cases: &[(&str, Option<Refusal>)] = &[
            ("/", Some(Refusal::HomeOrAbove)),
            ("/Users", Some(Refusal::HomeOrAbove)),
            ("/Users/me", Some(Refusal::HomeOrAbove)),
            ("/Users/me/Library/Keychains", Some(Refusal::Settings)),
            ("/Users/me/.aws", Some(Refusal::Settings)),
            ("/usr/local", Some(Refusal::System)),
            ("/private/etc", Some(Refusal::System)),
            ("/Volumes", Some(Refusal::System)),
            ("/Volumes/disk/repo", None),
            ("/Users/me/work/server", None),
            ("/opt/src", None),
        ];
        for (path, expected) in cases {
            assert_eq!(rules.refusal(path, home), *expected, "{path}");
        }
        // A home under `/private` keeps its own projects.
        assert_eq!(
            rules.refusal("/private/var/home/me/work", Some("/private/var/home/me")),
            None
        );
    }

    #[test]
    fn relative_missing_and_file_paths_are_refused() {
        let (_dir, home) = fixture();
        assert!(validate_project_path_in("work/server", Some(&home)).is_err());
        assert!(validate_project_path_in("~/nowhere", Some(&home)).is_err());
        let file = home.join("work/plain/readme.md");
        std::fs::write(&file, "x").unwrap();
        assert!(validate_project_path_in(file.to_str().unwrap(), Some(&home)).is_err());
        assert!(validate_project_path_in("  ", Some(&home)).is_err());
    }

    #[test]
    fn the_agent_is_told_plainly_how_its_request_ended() {
        let path = Path::new("/work/server");
        let granted = outcome_text(
            path,
            ProjectAccess::ReadWrite,
            &AccessRequestOutcome::Granted {
                access: ProjectAccess::ReadOnly,
                applied_live: true,
            },
        );
        assert!(granted.starts_with("Granted"));
        assert!(granted.contains("chose read-only"));
        assert!(granted.contains("next turn"));
        let denied = outcome_text(path, ProjectAccess::ReadOnly, &AccessRequestOutcome::Denied);
        assert!(denied.starts_with("Denied"));
        let pending = outcome_text(
            path,
            ProjectAccess::ReadOnly,
            &AccessRequestOutcome::Pending,
        );
        assert!(pending.contains("still waiting"));
    }
}
