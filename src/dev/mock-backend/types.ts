// Shapes shared by the dev-only mock backend. See `install.ts`.

import type { AgentResponses } from "./fake-agent";
import type { ArtifactsResponses } from "./fixtures/artifacts";
import type { CaptureResponses } from "./fixtures/capture";
import type { CommsResponses } from "./fixtures/comms";
import type { FsResponses } from "./fixtures/files";
import type { GitResponses } from "./fixtures/git";
import type { IconThemeResponses } from "./fixtures/icon-themes";
import type { IntegrationsResponses } from "./fixtures/integrations";
import type { KnowledgeResponses } from "./fixtures/knowledge";
import type { LogResponses } from "./fixtures/log";
import type { MemoryResponses } from "./fixtures/memory";
import type { SettingsResponses } from "./fixtures/settings";
import type { SkillsResponses } from "./fixtures/skills";
import type { SpacesResponses } from "./fixtures/spaces";
import type { TerminalResponses } from "./fixtures/terminal";
import type { ThemeImportResponses } from "./fixtures/theme-import";

/** Args exactly as the frontend passed them to `invoke(cmd, args)`. */
// oxlint-disable-next-line typescript/no-explicit-any -- a fake backend answers every command; args are per-command.
export type MockArgs = Record<string, any>;

/**
 * One fake command. Return the value Rust would return, typed `R` — what the
 * frontend's `invoke<R>` for this command reads; throw to make it fail.
 */
export type MockHandler<R = unknown> = (args: MockArgs) => R | Promise<R>;

/** Any handler map, whatever it answers. What `install.ts` dispatches through. */
export type MockHandlers = Record<string, MockHandler>;

/**
 * A fixture file's handler map, typed by its `<Domain>Responses` interface —
 * command name to the type the frontend's `invoke<T>` reads. Annotate the map
 * with it: a fake whose answer no longer matches `T` fails typecheck, and so
 * does a command added to the map without a declared response type (an
 * unknown key) or a declared response with no fake (a missing one). Unlike a
 * return annotation on each handler, nothing here can be left off.
 */
export type TypedHandlers<R> = { [K in keyof R]: MockHandler<R[K]> };

/** `invoke<void>`: Rust returns `()`, which arrives as `null`. */
export type Unit = null | void;

/**
 * A command the frontend awaits only for success or failure — `invoke()` with
 * no type argument, the answer never read — so any answer is right.
 */
export type Unread = unknown;

/**
 * Every command the domain fixture files answer, and its response type.
 * `interface … extends` also rejects one command declared with two different
 * response types in two files.
 */
export interface MockResponses
  extends
    AgentResponses,
    ArtifactsResponses,
    CaptureResponses,
    CommsResponses,
    FsResponses,
    GitResponses,
    IconThemeResponses,
    IntegrationsResponses,
    KnowledgeResponses,
    LogResponses,
    MemoryResponses,
    SettingsResponses,
    SkillsResponses,
    SpacesResponses,
    TerminalResponses,
    ThemeImportResponses {}

export interface Scenario {
  /** URL key: `?scenario=<name>`. */
  name: string;
  /** One line for the scenario index. */
  description: string;
  /**
   * Answers that override the base handlers for this scenario, typed like the
   * fixture they override — a scenario cannot answer a command no fixture
   * declares a response type for.
   */
  commands?: Partial<TypedHandlers<MockResponses>>;
  /**
   * Overrides for commands no fixture has a `<Domain>Responses` type for yet —
   * the boot commands written inline in `base.ts` and the catch-all
   * `fixtures/misc.ts`. Untyped, so prefer `commands`; a scenario that has to
   * restate the app's identity (its organisation, its projects, its version)
   * has no other way in. `commands` wins when both name a command.
   */
  rawCommands?: MockHandlers;
  /** Runs synchronously at install, before any app code. Seed fake state here. */
  init?: () => void;
  /**
   * Runs once the app has mounted (after `atlas:app-ready`). Use it to open the
   * right tab, or to fire events with `emit()` so the screen shows live changes.
   */
  setup?: () => void | Promise<void>;
  /** Named triggers, callable from the console as `__atlasMock.actions.<name>()`. */
  actions?: Record<string, () => void | Promise<void>>;
}
