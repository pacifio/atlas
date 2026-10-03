// Answers every scenario gets: the commands Atlas calls just to start up.
// A scenario overrides any of these by naming the same command.
//
// Each answer is typed with the same type the frontend's API wrapper uses, so
// `bun run typecheck` flags a fake that no longer matches what Rust returns.

import type { UpdaterSnapshot } from "@/features/updater/lib/updater-api";
import type { FileEntry } from "@/features/explorer/stores/explorer-store";
import type { Theme, ThemeCatalogSummary } from "@/features/theme/lib/theme-api";
import type { MockHandlers } from "../types";
import builtinThemesJson from "../fixtures/builtin-themes.json";
import { agentHandlers } from "../fake-agent";
import { artifactsHandlers } from "../fixtures/artifacts";
import { captureHandlers } from "../fixtures/capture";
import { commsHandlers } from "../fixtures/comms";
import { fsHandlers, listDir } from "../fixtures/files";
import { gitHandlers } from "../fixtures/git";
import { iconThemeHandlers } from "../fixtures/icon-themes";
import { integrationsHandlers } from "../fixtures/integrations";
import { knowledgeHandlers } from "../fixtures/knowledge";
import { logHandlers } from "../fixtures/log";
import { memoryHandlers } from "../fixtures/memory";
import { miscHandlers } from "../fixtures/misc";
import { settingsHandlers } from "../fixtures/settings";
import { skillsHandlers } from "../fixtures/skills";
import { spacesHandlers } from "../fixtures/spaces";
import { terminalHandlers } from "../fixtures/terminal";
import { importedUserThemes, themeImportHandlers } from "../fixtures/theme-import";
import { appState, MOCK_PROJECT } from "../project";

const nothing = () => null;

// Generated from the TOML themes by the atlas-theme crate; `cargo test -p
// atlas-theme` fails when this snapshot is stale.
const builtinThemes = builtinThemesJson as Theme[];

/**
 * Every fixture map spread into `baseHandlers`, by name. Exported so
 * `tests/mock-backend-contract.test.ts` can check that no two of them (or one
 * of them and an inline entry below) answer the same command: with object
 * spread the LAST definition silently wins, so an overlap is a fake that
 * looks live and is never reached.
 */
export const baseFixtureMaps: Readonly<Record<string, MockHandlers>> = {
  "fixtures/misc": miscHandlers,
  "fixtures/theme-import": themeImportHandlers,
  "fixtures/icon-themes": iconThemeHandlers,
  "fixtures/knowledge": knowledgeHandlers,
  "fixtures/git": gitHandlers,
  "fake-agent": agentHandlers,
  "fixtures/files": fsHandlers,
  "fixtures/settings": settingsHandlers,
  "fixtures/log": logHandlers,
  "fixtures/artifacts": artifactsHandlers,
  "fixtures/capture": captureHandlers,
  "fixtures/comms": commsHandlers,
  "fixtures/integrations": integrationsHandlers,
  "fixtures/memory": memoryHandlers,
  "fixtures/skills": skillsHandlers,
  "fixtures/spaces": spacesHandlers,
  "fixtures/terminal": terminalHandlers,
};

export const baseHandlers: MockHandlers = {
  // ── catch-all ───────────────────────────────────────────────────────────
  // FIRST, not last: with object spread the LAST definition of a key wins, so
  // spreading `misc` first is what lets every domain file (and every inline
  // entry below) outrank the catch-all. It used to be spread last, which made
  // it the winner — e.g. its `agents_list_running` (a phantom running agent)
  // shadowed `fake-agent`'s empty list. The contract test now rejects any
  // overlap that is not explicitly allowed, so the order is a backstop.
  ...miscHandlers,

  // ── theme ──────────────────────────────────────────────────────────────
  // Built-ins plus whatever this session has imported, which is how the real
  // catalog reads `~/.config/atlas/themes` on top of `include_str!`.
  list_themes: (): ThemeCatalogSummary => ({
    themes: [...builtinThemes, ...importedUserThemes].map((theme) => ({
      id: theme.id,
      name: theme.name,
      author: theme.author,
      license: theme.license,
      hasDark: Boolean(theme.dark),
      hasLight: Boolean(theme.light),
      builtIn: !importedUserThemes.includes(theme),
      warnings: theme.warnings ?? [],
    })),
    warnings: [],
  }),
  get_theme: (a): Theme => {
    const theme = [...importedUserThemes, ...builtinThemes].find(
      (candidate) => candidate.id === a.id,
    );
    if (!theme) throw new Error(`theme '${String(a.id)}' was not found`);
    return theme;
  },
  ...themeImportHandlers,

  // ── icon theme ──────────────────────────────────────────────────────────
  ...iconThemeHandlers,

  // ── boot ────────────────────────────────────────────────────────────────
  bootstrap_app_state: () => appState(),
  cli_take_initial_project_path: nothing,
  set_window_title: nothing,
  telemetry_config: () => ({
    enabled: false,
    host: "",
    anonId: "mock-device",
    accountId: null,
    usingDefaultKey: false,
    // null keeps posthog-js from ever loading in mock mode.
    key: null,
  }),
  update_state: (): UpdaterSnapshot => ({
    phase: "idle",
    version: null,
    currentVersion: "0.0.0-mock",
  }),

  // ── project open ──────────────────────────────────────────────────────
  save_app_state: nothing,
  asset_allow_dir: nothing,
  ensure_atlas_gitignore: nothing,
  load_editor_state: () => "{}",
  save_editor_state: nothing,
  load_project_session: () => "{}",
  read_directory: ({ path }): FileEntry[] => listDir(path),
  // The demo project reads as indexed, so the composer pill shows "N indexed";
  // the other projects keep the unbuilt "Index memory" label.
  codebase_index_status: ({ projectPath }) =>
    projectPath === MOCK_PROJECT.path
      ? { indexed: true, fileCount: 1284, summaryCount: 312, builtAtMs: Date.now() - 42 * 60_000 }
      : { indexed: false, fileCount: 0, summaryCount: 0, builtAtMs: 0 },
  log_interaction: nothing,

  // ── knowledge ───────────────────────────────────────────────────────────
  // A populated knowledge base (notes, meta, backlinks, graph) so Knowledge
  // and the knowledge-graph tab render for every scenario; see
  // `fixtures/knowledge.ts`. The `knowledge` scenario adds only its own
  // console actions on top of this. Cloned repos are a separate surface,
  // answered below by `integrationsHandlers`.
  ...knowledgeHandlers,

  // ── git ─────────────────────────────────────────────────────────────────
  // A dirty working tree with a branch list, a stash stack, a commit graph and
  // real per-file diffs. `git-conflict` overrides the status half of this.
  ...gitHandlers,

  // ── agents ──────────────────────────────────────────────────────────────
  ...agentHandlers,
  agents_set_effort: nothing,

  // ── everything else, one fixture file per surface ───────────────────────
  //
  // In one place, so a command answered by two fixtures is decided here
  // rather than by an import's position. (`misc`, the catch-all, is spread at
  // the very top so everything outranks it.)
  ...fsHandlers,
  ...settingsHandlers,
  ...logHandlers,
  ...artifactsHandlers,
  ...captureHandlers,
  ...commsHandlers,
  ...integrationsHandlers,
  ...memoryHandlers,
  ...skillsHandlers,
  ...spacesHandlers,
  ...terminalHandlers,

  // ── fire-and-forget housekeeping ────────────────────────────────────────
  comms_ready: nothing,
  fileindex_close_project: nothing,
  // Mirrored instructions: Rust writes AGENTS.md; nothing to fake in a browser.
  instruction_sync_start: nothing,
  instruction_sync_stop: nothing,
  recent_files_close_project: nothing,
  mention_cache_clear: nothing,
  mention_cache_set_knowledge: nothing,
  knowledge_export_note_md: nothing,
  knowledge_export_note_html: nothing,
  knowledge_export_workspace_md: nothing,
  knowledge_export_workspace_html: nothing,
  telemetry_set_org: nothing,

  // ── Tauri plugins ───────────────────────────────────────────────────────
  "plugin:app|version": () => "0.0.0-mock",
  "plugin:notification|is_permission_granted": () => false,
  "plugin:window|is_focused": () => true,
  "plugin:window|is_fullscreen": () => false,
  "plugin:webview|set_webview_zoom": nothing,
};
