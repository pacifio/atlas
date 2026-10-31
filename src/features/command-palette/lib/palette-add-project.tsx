// The palette's "Add project" flow: a list of sources, each a step of its own.
//
//   - New project: the field is the name; it goes in `~/.atlas/projects`,
//     with a Git repository, optionally published as a private GitHub one.
//   - Local folder: the field is a path (`~/…`) and the list is its folders.
//     Enter steps into one, ⌘Enter adds the folder typed; "Open in Finder"
//     is the native picker.
//   - Git URL / GitHub repository: the field is the URL or `owner/repo`;
//     Enter clones it into `~/.atlas/projects` and adds it.
//   - GitHub setup: when the GitHub CLI is missing or signed out, the GitHub
//     rows say so and lead here, to install it and sign in, in a terminal tab
//     (where `gh auth login` can ask its questions), then "Check again".
//
// Each step's rows are built live from the field and what Rust answered, so
// they are computed here on every render rather than frozen into the view
// stack when pushed (`command-palette.tsx` asks `useAddProjectFlow` for the
// step on screen).

import { isValidElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowLeftToLine,
  Check,
  CornerLeftUp,
  Download,
  Folder,
  FolderGit2,
  FolderPlus,
  Link,
  LogIn,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "@/ui/icon";
import { GithubIcon } from "@/components/github-icon";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { pickAndAddProject } from "@/features/projects/lib/pick-project";
import {
  projectSources,
  type BrowseListing,
  type ProjectSourcesInfo,
} from "@/features/projects/lib/project-sources-api";
import { openCommandTerminal } from "@/features/terminal/lib/open-command-terminal";
import type {
  CommandPaletteActionItem,
  CommandPaletteGroup,
  CommandPaletteView,
} from "./command-palette-logic";

export const ADD_PROJECT_VIEW = "add-project";
export const NEW_PROJECT_VIEW = "add-project:new";
const BROWSE_VIEW = "add-project:browse";
const GIT_URL_VIEW = "add-project:git-url";
const GITHUB_VIEW = "add-project:github";
const GH_SETUP_VIEW = "add-project:gh-setup";

/** Whether `value` is one of this flow's steps. */
export function isAddProjectView(value: string | undefined): boolean {
  return value === ADD_PROJECT_VIEW || (value?.startsWith(`${ADD_PROJECT_VIEW}:`) ?? false);
}

/** What the palette shows for a step of the flow. */
export interface AddProjectStep {
  groups: CommandPaletteGroup[];
  placeholder: string;
  emptyMessage: string;
  footerActionLabel: string;
  endAddon?: ReactNode;
  footerTrailing?: ReactNode;
  onSubmit?: (opts: { mod: boolean }) => void;
  disabled?: boolean;
}

const icon = (glyph: LucideIcon) => <Icon icon={glyph} size="lg" />;

const MOD = isMac ? "⌘" : "Ctrl";

const GITHUB = <GithubIcon size={16} className="shrink-0" />;

/** The field's right-end action: "Create ⌘ Enter". */
function StepAction(props: { label: string; keys: string; onRun: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onRun}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-element-hover disabled:cursor-default disabled:opacity-50"
    >
      {props.label}
      <span className="text-muted-foreground">{props.keys}</span>
    </button>
  );
}

function SetupRequired() {
  return (
    <span className="ms-auto shrink-0 rounded-md border border-warning/40 bg-warning-muted px-1.5 py-0.5 text-xs font-medium text-warning">
      Setup required
    </span>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ms-auto grid size-4 shrink-0 place-items-center rounded-sm border",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
      )}
    >
      {checked && <Icon icon={Check} size="sm" />}
    </span>
  );
}

/** `~/a/b/` → its folder part (`~/a/b/`) and the name being typed after it. */
function splitBrowseQuery(query: string): { dir: string; filter: string } {
  const slash = query.lastIndexOf("/");
  if (slash === -1) return { dir: "~/", filter: query };
  return { dir: query.slice(0, slash + 1), filter: query.slice(slash + 1) };
}

/** The folder above `dir` (`~/a/b/` → `~/a/`), in the form the user typed. */
function parentQuery(dir: string, listing: BrowseListing | null): string | null {
  const trimmed = dir.replace(/\/+$/, "");
  if (trimmed === "~" || trimmed === "") {
    return listing?.parent ? `${listing.parent.replace(/\/+$/, "")}/` : null;
  }
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? null : trimmed.slice(0, cut + 1) || "/";
}

export function useAddProjectFlow(input: {
  /** The view on screen (its `value`). */
  view: string | undefined;
  query: string;
  /** Projects Atlas has seen before, offered under the sources. */
  recentItems: CommandPaletteActionItem[];
  setQuery: (query: string) => void;
  pushView: (view: CommandPaletteView) => void;
  popView: () => void;
  onClose: () => void;
}) {
  const { view, query, setQuery, pushView, popView, onClose, recentItems } = input;
  const inFlow = isAddProjectView(view);
  const [info, setInfo] = useState<ProjectSourcesInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [githubPrivate, setGithubPrivate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [listing, setListing] = useState<BrowseListing | null>(null);

  const refreshInfo = () => {
    setChecking(true);
    void projectSources
      .info()
      .then((next) => setInfo(next))
      .catch(() => setInfo(null))
      .finally(() => setChecking(false));
  };

  // Asked each time the flow opens: where projects go, and whether `gh` is
  // ready (it may have been installed since).
  useEffect(() => {
    if (!inFlow) return;
    let live = true;
    void projectSources
      .info()
      .then((next) => live && setInfo(next))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [inFlow]);

  // The folder browser lists the folder the field names.
  const browseDir = view === BROWSE_VIEW ? splitBrowseQuery(query).dir : null;
  useEffect(() => {
    if (browseDir === null) return;
    let live = true;
    projectSources
      .browse(browseDir)
      .then((next) => live && setListing(next))
      .catch(() => live && setListing(null));
    return () => {
      live = false;
    };
  }, [browseDir]);

  const ghReady = info?.gh === "ready";

  /** Run a step that ends in a folder, then add it as a project. A warning
   *  (the folder stands, a later step failed) is shown, not thrown. */
  const finish = (
    label: string,
    work: () => Promise<string | { path: string; warning: string | null }>,
  ) => {
    setBusy(label);
    void work()
      .then(async (result) => {
        const { path, warning } =
          typeof result === "string" ? { path: result, warning: null } : result;
        await useProjectStore.getState().actions.addProject(path);
        if (warning) toast.warning(warning);
        onClose();
      })
      .catch((error: unknown) => {
        toast.error(String(error));
      })
      .finally(() => setBusy(null));
  };

  const createProject = () => {
    const name = query.trim();
    if (!name) return;
    finish(`Creating ${name}…`, () => projectSources.create(name, githubPrivate && ghReady));
  };
  const clone = (github: boolean) => {
    const url = query.trim();
    if (!url) return;
    finish(`Cloning ${url}…`, () => projectSources.clone(url, github));
  };

  const goGhSetup = () => pushView({ value: GH_SETUP_VIEW, groups: [] });

  const action = (
    value: string,
    title: string,
    glyph: LucideIcon | ReactElement,
    run: () => void,
    extra: Partial<CommandPaletteActionItem> = {},
  ): CommandPaletteActionItem => ({
    kind: "action",
    value,
    title,
    icon: isValidElement(glyph) ? glyph : icon(glyph),
    run,
    ...extra,
    searchTerms: [title, ...(extra.searchTerms ?? [])],
  });

  const sources = (): AddProjectStep => {
    const githubRow = ghReady
      ? action(
          "source:github",
          "GitHub repository",
          GITHUB,
          () => pushView({ value: GITHUB_VIEW, groups: [] }),
          { description: "Clone GitHub owner/repo", keepOpen: true },
        )
      : action("source:github", "GitHub repository", GITHUB, goGhSetup, {
          description: "Clone GitHub owner/repo",
          titleTrailingContent: info ? <SetupRequired /> : undefined,
          keepOpen: true,
        });
    return {
      groups: [
        {
          value: "sources",
          label: "Sources",
          items: [
            action(
              "source:new",
              "New project",
              FolderGit2,
              () => pushView({ value: NEW_PROJECT_VIEW, groups: [] }),
              { description: "Start a new Git repository from a name", keepOpen: true },
            ),
            action(
              "source:local",
              "Local folder",
              FolderPlus,
              () => pushView({ value: BROWSE_VIEW, groups: [], initialQuery: "~/" }),
              { description: "Browse a folder on disk", keepOpen: true },
            ),
            action(
              "source:git-url",
              "Git URL",
              Link,
              () => pushView({ value: GIT_URL_VIEW, groups: [] }),
              { description: "Clone from a remote URL", keepOpen: true },
            ),
            githubRow,
          ],
        },
        ...(recentItems.length > 0
          ? [{ value: "recent-projects", label: "Recent", items: recentItems }]
          : []),
      ],
      placeholder: "Search sources…",
      emptyMessage: "No matching source.",
      footerActionLabel: "Select",
    };
  };

  const newProject = (): AddProjectStep => {
    const name = query.trim();
    const where = info ? (name ? `${info.path}/${name}` : info.path) : "~/.atlas/projects";
    const githubOption = ghReady
      ? action(
          "option:github-private",
          "Create private repository on GitHub",
          GITHUB,
          () => setGithubPrivate((on) => !on),
          {
            description: info?.githubLogin ?? undefined,
            titleTrailingContent: <Checkbox checked={githubPrivate} />,
            keepOpen: true,
          },
        )
      : action("option:github-private", "Create private repository on GitHub", GITHUB, goGhSetup, {
          description: "Install and sign in to the GitHub CLI first",
          titleTrailingContent: info ? <SetupRequired /> : undefined,
          keepOpen: true,
        });
    return {
      groups: [
        {
          value: "new",
          label: "",
          items: [
            action("new:create", "New project", FolderGit2, createProject, {
              description: `Goes in ${where}`,
              disabled: !name,
              keepOpen: true,
            }),
          ],
        },
        {
          value: "options",
          label: "Options",
          items: [
            githubOption,
            action("new:existing", "Add existing project", FolderPlus, popView, {
              description: "Open a folder or clone a repository",
              keepOpen: true,
            }),
          ],
        },
      ],
      placeholder: "Project name",
      emptyMessage: "",
      footerActionLabel: "Select",
      endAddon: (
        <StepAction
          label="Create"
          keys={`${MOD} Enter`}
          onRun={createProject}
          disabled={!name || busy !== null}
        />
      ),
      onSubmit: ({ mod }) => {
        if (mod) createProject();
      },
    };
  };

  const browse = (): AddProjectStep => {
    const { dir, filter } = splitBrowseQuery(query);
    const parent = parentQuery(dir, listing);
    const needle = filter.toLowerCase();
    const folders = (listing?.directories ?? [])
      .filter((name) => (needle ? name.toLowerCase().includes(needle) : !name.startsWith(".")))
      .sort((a, b) => {
        // Names that start with what was typed come first.
        const ap = a.toLowerCase().startsWith(needle) ? 0 : 1;
        const bp = b.toLowerCase().startsWith(needle) ? 0 : 1;
        return ap - bp;
      });
    // ⌘Enter adds the folder the field names: a typed name that is one of
    // the listed folders, else the folder being listed.
    const exact = folders.find((name) => name === filter);
    const target = exact ? `${dir}${exact}` : dir;
    const add = () => finishAdd(target);
    const items: CommandPaletteActionItem[] = [];
    if (parent !== null && !filter) {
      items.push(
        action("browse:..", "..", CornerLeftUp, () => setQuery(parent), { keepOpen: true }),
      );
    }
    for (const name of folders) {
      items.push(
        action(`browse:${name}`, name, Folder, () => setQuery(`${dir}${name}/`), {
          keepOpen: true,
        }),
      );
    }
    return {
      groups: [{ value: "directories", label: "Directories", items }],
      placeholder: "~/",
      emptyMessage: listing ? "No folders here." : "That folder cannot be read.",
      footerActionLabel: "Open",
      endAddon: <StepAction label="Add" keys={`${MOD} Enter`} onRun={add} />,
      footerTrailing: (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            void pickAndAddProject();
          }}
          className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {isMac ? "Open in Finder" : "Open folder…"}
        </button>
      ),
      onSubmit: ({ mod }) => {
        if (mod) add();
      },
    };
  };

  const finishAdd = (path: string) => {
    finish(`Adding ${path}…`, async () => {
      const resolved = await projectSources.browse(path);
      return resolved.path;
    });
  };

  const cloneStep = (github: boolean): AddProjectStep => {
    const url = query.trim();
    return {
      groups: [],
      placeholder: github ? "owner/repo" : "Enter Git clone URL",
      emptyMessage: github
        ? "Enter a GitHub repository as owner/repo and press Enter to continue."
        : "Enter a Git clone URL and press Enter to continue.",
      footerActionLabel: "Continue",
      endAddon: (
        <StepAction
          label="Continue"
          keys="Enter"
          onRun={() => clone(github)}
          disabled={!url || busy !== null}
        />
      ),
      onSubmit: () => clone(github),
    };
  };

  const ghSetup = (): AddProjectStep => {
    const items: CommandPaletteActionItem[] = [];
    if (info?.gh === "missing") {
      const install =
        info.installer === "brew"
          ? "brew install gh"
          : info.installer === "winget"
            ? "winget install --id GitHub.cli -e"
            : null;
      items.push(
        install
          ? action(
              "gh:install",
              "Install the GitHub CLI",
              Download,
              () => void openCommandTerminal(install, "Install GitHub CLI"),
              { description: `Runs ${install} in a terminal` },
            )
          : action(
              "gh:install",
              "Install the GitHub CLI",
              Download,
              () =>
                void import("@tauri-apps/plugin-opener")
                  .then((m) => m.openUrl("https://cli.github.com"))
                  .catch(() => {}),
              { description: "Opens cli.github.com" },
            ),
      );
    }
    if (info?.gh !== "ready") {
      items.push(
        action(
          "gh:login",
          "Sign in to GitHub",
          LogIn,
          () =>
            void openCommandTerminal("gh auth login --web --git-protocol https", "GitHub sign in"),
          {
            description: "Runs gh auth login in a terminal",
            disabled: info?.gh === "missing",
          },
        ),
      );
    }
    items.push(
      action("gh:check", checking ? "Checking…" : "Check again", RefreshCw, refreshInfo, {
        description: ghReady
          ? `Signed in as ${info?.githubLogin ?? "your account"}`
          : "Once the CLI is installed and signed in",
        keepOpen: true,
        disabled: checking,
      }),
    );
    if (ghReady) {
      items.unshift(
        action("gh:done", "Back to sources", ArrowLeftToLine, popView, {
          description: "The GitHub CLI is ready",
          keepOpen: true,
        }),
      );
    }
    return {
      groups: [{ value: "gh", label: "GitHub CLI", items }],
      placeholder: "Set up the GitHub CLI",
      emptyMessage: "",
      footerActionLabel: "Select",
    };
  };

  const step = ((): AddProjectStep | null => {
    switch (view) {
      case ADD_PROJECT_VIEW:
        return sources();
      case NEW_PROJECT_VIEW:
        return newProject();
      case BROWSE_VIEW:
        return browse();
      case GIT_URL_VIEW:
        return cloneStep(false);
      case GITHUB_VIEW:
        return cloneStep(true);
      case GH_SETUP_VIEW:
        return ghSetup();
      default:
        return null;
    }
  })();
  if (step && busy) {
    return { ...step, groups: [], emptyMessage: busy, disabled: true, onSubmit: undefined };
  }
  return step;
}

/** The "Add project" submenu row's target. */
export const ADD_PROJECT_ENTRY: CommandPaletteView = {
  value: ADD_PROJECT_VIEW,
  groups: [],
  placeholder: "Search sources…",
};
