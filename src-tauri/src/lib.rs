mod auth;
mod commands;
mod logging;
mod menu;
mod state;
mod telemetry;

use std::sync::Arc;

use atlas_acp::AgentRegistry;
use commands::claude::ClaudeSessionIndex;
use commands::cli::CliLaunchState;
use commands::fileindex::FileIndexState;
use commands::git_watcher::GitWatcherState;
use commands::knowledge_links::KnowledgeLinksState;
use commands::knowledge_meta::KnowledgeMetaState;
use commands::mention_search::MentionCacheState;
use commands::recent_files::RecentFilesState;
use commands::papers::SavedPapersIndex;
use commands::sessions_watch::SessionsWatchState;
use commands::terminal::TerminalState;
use parking_lot::Mutex;
use state::{AppState, AppStateHandle};
use tauri::Manager;

// Compile-time guard: cersei-provider MUST resolve to the vendored, patched
// crate ([patch.crates-io] → vendor/cersei-provider). The crates.io release
// has no `utf8` module — if the patch stops applying, `cargo check` fails
// here instead of shipping decoders that corrupt multi-byte streaming.
const _CERSEI_UTF8_PATCH_GUARD: &str = cersei_provider::utf8::ATLAS_UTF8_PATCH;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install a tracing subscriber that prints `tracing::info!` etc. to
    // stderr. Verbosity is controlled by `RUST_LOG`; see `logging.rs`.
    logging::init();

    // Load a `.env` from the current dir (if any) so source / fork builds can
    // point telemetry at their own PostHog OSS project via POSTHOG_KEY /
    // POSTHOG_HOST without a rebuild. No-op when absent. Must run before the
    // telemetry client resolves its key in `setup()`.
    let _ = dotenvy::dotenv();

    // Strip CLAUDECODE so child ACP agents (canonical claude-code-acp) don't
    // refuse to start when Atlas was launched from a parent Claude Code shell.
    atlas_acp::sanitize_host_env();

    // Parse argv for an initial project path BEFORE tauri::Builder starts
    // so the webview boot path can read it via `cli_take_initial_project_path`.
    // Triggered by the `atlas <path>` shell helper at ~/.local/bin/atlas.
    let initial_project = commands::cli::parse_initial_project();

    let builder = tauri::Builder::default();

    // Single-instance — RELEASE ONLY. When the user runs `atlas <path>` while
    // Atlas is already open, the shell helper's `open -n` spawns a fresh
    // process; this plugin forwards that process's argv to the running
    // instance (firing this callback) and the duplicate exits.
    //
    // It is intentionally NOT registered in debug builds: otherwise
    // `tauri dev` is killed the instant it starts whenever the installed
    // /Applications/Atlas.app is running — the dev process is treated as the
    // "second instance", forwards its (empty) argv, and exits. Skipping it in
    // debug lets dev and the installed app coexist.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        use tauri::Emitter;
        tracing::info!(target: "atlas::cli", "second-instance argv: {argv:?}");
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        // argv[0] is the executable path — strip it before parsing.
        let positional = argv.get(1..).unwrap_or(&[]);
        if let Some(path) = commands::cli::parse_project_path(positional) {
            let _ = app.emit("atlas:cli-open-project", path);
        }
    }));

    builder
        // Custom menu: replaces the default Window ▸ Close (Cmd+W) with a
        // "Close Tab" item so Cmd+W in a focused embedded browser webview closes
        // the tab instead of tearing down the window. See `menu.rs`.
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| {
            if event.id() == menu::CLOSE_TAB_ID {
                use tauri::Emitter;
                let _ = app.emit("atlas:close-active-tab", ());
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Opaque dark window background. Fills the brief gap between
                // window-shown and first React paint with the app's base
                // black instead of the WebKit default white.
                //
                // This was previously a transparent NSWindow + HudWindow
                // NSVisualEffectView blur (window_vibrancy). Removed: the live
                // backdrop blur forced the macOS WindowServer to recomposite
                // the whole window against everything behind it every frame,
                // which made Mission Control / Spaces transitions lag
                // system-wide whenever Atlas was the focused window. An opaque
                // window can be snapshotted as a flat texture, so the OS
                // animation stays smooth.
                let _ = window
                    .set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
            }
            // Pre-load the Rust-owned `AppState` (currentProject + recents)
            // before the webview starts loading — paid in parallel with the
            // WebView framework init, ~1ms on warm cache.
            let mut loaded = AppState::load(&app.handle());
            // Device-stable telemetry identity, owned by Rust in its own file.
            // It used to live in `state.json` as `telemetry_anon_id`, where every
            // settings save wiped it (the frontend payload omitted the field and
            // the command replaced the whole struct) — so one machine became a
            // new PostHog person on every save. An install upgrading from that
            // era ADOPTS its existing id here rather than forking a new person.
            let (device, is_new_device) =
                telemetry::device::load_or_create(&app.handle(), loaded.telemetry_anon_id.as_deref());
            let device_id = device.device_id.clone();
            let device_id_source = device.source.clone();
            // Mirror it back into `state.json` so the two agree and a downgrade
            // still finds an id. `AppStatePatch` now stops the frontend wiping it.
            if loaded.telemetry_anon_id.as_deref() != Some(device_id.as_str()) {
                loaded.telemetry_anon_id = Some(device_id.clone());
                let _ = AppState::save(&app.handle(), &loaded);
            }
            let telemetry_enabled = loaded.settings.share_telemetry;
            let app_state: AppStateHandle = Arc::new(Mutex::new(loaded));
            app.manage(app_state);

            // Opt-in product telemetry. Inert unless the user has enabled it AND
            // a PostHog key resolves (env / telemetry.json / build-time default).
            let (telemetry, flush_rx) =
                telemetry::TelemetryClient::new(&app.handle(), device_id, telemetry_enabled);
            app.manage(telemetry.clone());
            if let Some(rx) = flush_rx {
                let tclient = telemetry.clone();
                tauri::async_runtime::spawn(async move {
                    telemetry::run_flush_loop(tclient, rx).await;
                });
            }
            // Crash capture: best-effort synchronous POST from the panic hook
            // (the build is `panic = "abort"`, so the async flush task can't be
            // relied on). Chains to the previously-installed hook. `location` is
            // Atlas's own `file:line`; `message` is redacted of path/URL tokens.
            {
                let tclient = telemetry.clone();
                let prev = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    let location = info
                        .location()
                        .map(|l| format!("{}:{}", l.file(), l.line()))
                        .unwrap_or_default();
                    let msg = info
                        .payload()
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
                        .unwrap_or("panic");
                    tclient.capture_panic_blocking(serde_json::json!({
                        "location": location,
                        "message": telemetry::redact_message(msg, 160),
                    }));
                    prev(info);
                }));
            }
            // Launch / active-user signal. `is_first_launch` is only honest now
            // that the device id survives a settings save.
            telemetry.capture(
                "app_started",
                serde_json::json!({
                    "is_first_launch": is_new_device,
                    "device_id_source": device_id_source,
                }),
            );

            commands::agents::install_manager(&app.handle());
            // Silent background refresh of model pricing from models.dev — first
            // launch populates the cache; later launches update only on change.
            commands::models_pricing::refresh_in_background(&app.handle());
            // Auto-update: clean up any staged update that already took effect,
            // then run a non-blocking background check + a periodic re-check. The
            // download/verify/stage happens silently; the user is only prompted
            // once it's ready to restart. See `commands::updater`.
            // Account auth (ATL-35). The config dir only resolves from the
            // app handle, so this is managed here rather than in the builder
            // chain. Restore runs off-thread: a signed-out launch touches the
            // network not at all, and a signed-in one must never block boot.
            {
                let config_dir = app
                    .path()
                    .app_config_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                app.manage(commands::auth::AuthState::new(config_dir));
                commands::auth::restore_on_launch(&app.handle());

                // Seed the Organisation every event is attributed to, from the
                // state we just loaded. The app has an active org from its first
                // frame; waiting for the renderer to announce it would leave
                // every launch-time event ungrouped, which is exactly the
                // window where launch/update/crash events land. Runs after
                // `AuthState` is managed because a synced org's role is read
                // from the auth snapshot.
                {
                    let handle = app.handle();
                    let active = handle
                        .state::<AppStateHandle>()
                        .lock()
                        .active_organisation_id
                        .clone();
                    handle
                        .state::<Arc<telemetry::TelemetryClient>>()
                        .set_active_org(commands::telemetry::resolve_org(handle, active.as_deref()));
                }

                // Session capture's drain needs a credential, and the auth core
                // only exists from here on. Installed rather than passed in at
                // construction because `CaptureState` is registered earlier in
                // the builder chain; until this runs the drain simply parks,
                // which is exactly Local-mode behaviour.
                // The worker announces its writes through this handle — without
                // it the Timeline board only ever sees them on its 15 s poll.
                app.state::<commands::capture::CaptureState>()
                    .install_notifier(app.handle().clone());

                let core = app.state::<commands::auth::AuthState>().core();
                app.state::<commands::capture::CaptureState>()
                    .install_token_provider(Box::new(move || {
                        tauri::async_runtime::block_on(core.mint_access_token()).ok()
                    }));
            }

            commands::updater::init_on_startup(&app.handle());
            commands::updater::check_in_background(&app.handle());
            commands::updater::spawn_periodic(&app.handle());

            // Background memory indexer (Step 4): a single owned Tokio task drains
            // a bounded queue and indexes each open project's corpus into its
            // per-project `atlas_memory::MemoryEngine`, off the chat hot path. The
            // `MemoryRegistry` is the cwd-keyed owner of every engine, shared by
            // the indexer (write lock) and — later — the retrieve closure (read
            // lock). Wired here so the queue + registry outlive every window.
            let (job_tx, job_rx) = tokio::sync::mpsc::channel::<commands::memory_indexer::Job>(
                commands::memory_indexer::QUEUE_CAPACITY,
            );
            let registry =
                Arc::new(commands::memory_indexer::MemoryRegistry::new(job_tx));
            app.manage(registry.clone());
            let indexer_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::memory_indexer::MemoryIndexer::run(indexer_app, registry, job_rx).await;
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::browser::BrowserState::new())
        .manage(TerminalState::new())
        .manage(commands::modelchat::ModelChatState::new())
        .manage(commands::review::ReviewState::new())
        .manage(AgentRegistry::new())
        .manage(FileIndexState::new())
        .manage(GitWatcherState::new())
        .manage(RecentFilesState::new())
        .manage(MentionCacheState::new())
        .manage(Arc::new(KnowledgeMetaState::new()))
        .manage(Arc::new(KnowledgeLinksState::new()))
        .manage(CliLaunchState::new(initial_project))
        .manage(SessionsWatchState::new())
        .manage(ClaudeSessionIndex::new())
        .manage(SavedPapersIndex::new())
        .manage(commands::memory_chat::MemoryChatState::new())
        .manage(commands::memory_sharing::MemorySharingState::new())
        .manage(commands::shared_memory::SharedMemoryStore::new())
        // Owns the per-Workspace session stores and the capture worker
        // thread. Managed before `install_manager` runs its pipeline so a
        // delta arriving early finds it.
        .manage(commands::capture::CaptureState::new())
        .manage(commands::updater::UpdaterState::new())
        // Drop a window's per-window index + mention caches when it closes, so
        // its file watcher stops and memory is freed (these states are keyed by
        // webview label for multi-window project scoping).
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let label = window.label();
                window.state::<FileIndexState>().drop_window(label);
                window.state::<MentionCacheState>().drop_window(label);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth::auth_snapshot,
            commands::auth::auth_sign_in,
            commands::auth::auth_cancel_sign_in,
            commands::auth::auth_sign_out,
            commands::auth::auth_create_org,
            commands::auth::auth_check_org_slug,
            commands::auth::auth_list_members,
            commands::auth::auth_list_invitations,
            commands::auth::auth_invite_member,
            commands::auth::auth_cancel_invitation,
            commands::auth::auth_update_member_role,
            commands::auth::auth_remove_member,
            commands::auth::auth_refresh,
            commands::auth::auth_delete_org,
            commands::window::window_zoom,
            commands::clipboard::clipboard_file_paths,
            commands::clipboard::clipboard_write_text,
            commands::window::set_window_title,
            commands::browser::browser_open_window,
            commands::browser::browser_embed_create,
            commands::browser::browser_embed_navigate,
            commands::browser::browser_embed_back,
            commands::browser::browser_embed_forward,
            commands::browser::browser_embed_reload,
            commands::browser::browser_embed_set_bounds,
            commands::browser::browser_embed_set_visible,
            commands::browser::browser_embed_destroy,
            commands::terminal::terminal_create,
            commands::terminal::terminal_zsh_dir,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill_foreground,
            commands::terminal::terminal_close,
            commands::terminal::terminal_ack,
            commands::terminal::terminal_resolve_path,
            commands::terminal::resolve_path,
            commands::terminal::terminal_path_complete,
            commands::terminal::terminal_list_commands,
            commands::fs::read_directory,
            commands::fs::read_file_content,
            commands::fs::read_file_base64,
            commands::fs::capture_screenshot,
            commands::fs::is_text_file,
            commands::fs::file_mtime_ms,
            commands::fs::asset_allow_dir,
            commands::fs::write_file_content,
            commands::fs::write_file_base64,
            commands::fs::ensure_atlas_gitignore,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_copy,
            commands::fs::fs_duplicate,
            commands::fs::fs_open_in_terminal,
            commands::fs::fs_add_to_gitignore,
            commands::git::git_status,
            commands::git::git_status_fresh,
            commands::git::git_log,
            commands::git::git_diff_all,
            commands::git::git_workspace_summary,
            commands::mission_control::mission_control_usage,
            commands::mission_control::mission_control_export_markdown,
            commands::mission_control::mission_control_write_file,
            commands::git::git_diff_file,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_list_branches,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_blame_file,
            commands::git::git_refs,
            commands::git::git_graph_signature,
            commands::git_graph::git_graph_build,
            // Extended source-control manager operations.
            commands::git_ops::git_branches_full,
            commands::git_ops::git_rename_branch,
            commands::git_ops::git_branch_delete,
            commands::git_ops::git_merge_branch,
            commands::git_ops::git_merge_preview,
            commands::git_ops::git_fetch,
            commands::git_ops::git_pull,
            commands::git_ops::git_push,
            commands::git_ops::git_publish_branch,
            commands::git_ops::git_remotes,
            commands::git_ops::git_remote_add,
            commands::git_ops::git_remote_remove,
            commands::git_ops::git_stash_list,
            commands::git_ops::git_stash_push,
            commands::git_ops::git_stash_paths,
            commands::git_ops::git_stash_apply,
            commands::git_ops::git_stash_pop,
            commands::git_ops::git_stash_drop,
            commands::git_ops::git_discard,
            commands::git_ops::git_delete_added,
            commands::git_ops::git_reset,
            commands::git_ops::git_revert,
            commands::git_ops::git_cherry_pick,
            commands::git_ops::git_commit_ex,
            commands::git_ops::git_diff_staged,
            commands::git_ops::git_diff_unstaged,
            commands::git_ops::git_tags,
            commands::git_ops::git_create_tag,
            commands::git_ops::git_delete_tag,
            commands::git_ops::git_show,
            commands::git_ops::git_inprogress,
            commands::git_ops::git_op_control,
            commands::git_ops::git_commit_v2,
            commands::git_snapshot::git_snapshot,
            commands::git_stage_ops::git_stage_hunk,
            commands::git_stage_ops::git_unstage_hunk,
            commands::git_stage_ops::git_discard_hunk,
            commands::git_conflicts::git_conflict_state,
            commands::git_conflicts::git_resolve_file,
            commands::git_ops::git_clone,
            commands::git_ops::git_rebase,
            commands::git_ops::git_undo_commit,
            commands::git_ops::git_squash_last,
            commands::git_watcher::git_watch_start,
            commands::git_watcher::git_watch_stop,
            commands::git_watcher::git_watch_stop_all,
            commands::capture::capture_detect,
            commands::capture::capture_binding,
            commands::capture::capture_enable,
            commands::capture::capture_refresh,
            commands::capture::capture_disable,
            commands::capture::capture_git_init,
            commands::capture::capture_health,
            commands::capture::capture_import_preview,
            commands::capture::capture_import_confirm,
            commands::capture::capture_slug_available,
            commands::capture::capture_register_cloud,
            commands::capture::capture_promotion_preview,
            commands::capture::capture_promote,
            commands::capture::capture_connect_options,
            commands::capture::capture_connect,
            commands::capture::capture_activate,
            commands::capture::capture_retry_failed,
            commands::capture::capture_retry_watcher,
            commands::capture::artifacts_sessions,
            commands::capture::capture_agent_session_counts,
            commands::capture::artifacts_session,
            commands::capture::artifacts_payload,
            commands::capture::capture_commit_sessions,
            commands::capture::artifacts_board,
            commands::capture::artifacts_checkpoints,
            commands::git_watcher::git_watch_status,
            commands::mention_search::mention_search,
            commands::mention_search::mention_cache_set_knowledge,
            commands::mention_search::mention_cache_clear,
            commands::recent_files::recent_files_open_project,
            commands::recent_files::recent_files_close_project,
            commands::recent_files::recent_files_push,
            commands::recent_files::recent_files_rename,
            commands::recent_files::recent_files_list,
            commands::recent_files::recent_files_clear,
            commands::github::search_github,
            commands::github::clone_github_repo,
            commands::github::list_cloned_repos,
            commands::github::read_repo_readme,
            commands::github::delete_cloned_repo,
            // Legacy Claude-CLI subprocess commands (claude_run/stream/stop/check/version)
            // were replaced by ACP. Session-history readers below are still in use.
            commands::claude::list_claude_sessions,
            commands::gitdiff::git_diff_structured,
            commands::gitdiff::diff_structured_text,
            commands::gitdiff::git_commit_changed_files,
            commands::gitdiff::git_diff_line_status,
            commands::claude::delete_claude_session,
            commands::claude::read_claude_session,
            commands::claude::claude_session_stats,
            commands::claude::project_usage_stats,
            commands::search::search_in_files,
            commands::research::search_arxiv,
            commands::research::search_semantic_scholar,
            commands::research::download_paper,
            commands::research::save_paper_to_knowledge,
            commands::research::fetch_trending_papers,
            commands::research::save_project_session,
            commands::research::load_project_session,
            commands::knowledge::list_knowledge,
            commands::knowledge::save_knowledge_note,
            commands::knowledge::import_into_knowledge,
            commands::knowledge::delete_knowledge_note,
            commands::knowledge::create_knowledge_dir,
            commands::knowledge::log_interaction,
            commands::knowledge::get_recent_interactions,
            commands::knowledge::save_editor_state,
            commands::knowledge::load_editor_state,
            commands::knowledge::fetch_readable,
            commands::knowledge::knowledge_cover_upload,
            commands::knowledge::knowledge_cover_resolve,
            commands::knowledge::knowledge_cover_data_url,
            commands::knowledge_meta::knowledge_meta_load,
            commands::knowledge_meta::knowledge_meta_patch,
            commands::knowledge_meta::knowledge_meta_delete,
            commands::knowledge_meta::knowledge_meta_drop_project,
            commands::knowledge_links::knowledge_backlinks,
            commands::knowledge_links::knowledge_forwardlinks,
            commands::knowledge_links::knowledge_link_counts,
            commands::knowledge_links::knowledge_links_invalidate,
            commands::knowledge_links::knowledge_links_drop_project,
            commands::knowledge_links::knowledge_links_graph,
            commands::knowledge_export::knowledge_export_note_md,
            commands::knowledge_export::knowledge_export_note_html,
            commands::knowledge_export::knowledge_export_workspace_md,
            commands::knowledge_export::knowledge_export_workspace_html,
            commands::knowledge_export::knowledge_export_server,
            commands::knowledge_graph_layout::knowledge_graph_layout_load,
            commands::knowledge_graph_layout::knowledge_graph_layout_save,
            commands::canvas::load_canvas,
            commands::canvas::save_canvas,
            commands::canvas::canvas_media_upload,
            commands::canvas::canvas_media_data_url,
            commands::canvas::canvas_codebase_context,
            commands::log::load_pinned_log,
            commands::log::append_pinned_log,
            commands::log::clear_pinned_log,
            commands::log::rewrite_pinned_log,
            commands::log::load_project_log,
            commands::log::append_project_log,
            commands::log::clear_project_log,
            commands::app_state::bootstrap_app_state,
            commands::app_state::save_app_state,
            commands::telemetry::telemetry_config,
            commands::telemetry::telemetry_set_enabled,
            commands::telemetry::telemetry_capture,
            commands::telemetry::telemetry_set_org,
            commands::feedback::feedback_submit,
            commands::updater::update_check_now,
            commands::updater::update_apply,
            commands::updater::update_state,
            commands::updater::update_ignore,
            commands::compose_prompt::compose_prompt,
            commands::cli::cli_status,
            commands::cli::cli_install_helper,
            commands::cli::cli_take_initial_project_path,
            commands::claude_setup::claude_status,
            commands::claude_setup::claude_install,
            commands::node_setup::node_check,
            commands::node_setup::node_install,
            commands::registry::acp_registry_list,
            commands::registry::acp_registry_refresh,
            commands::registry::acp_registry_install,
            commands::registry::acp_registry_uninstall,
            commands::registry::acp_registry_metadata,
            commands::agents::agents_list_plugins,
            commands::agents::agents_list_running,
            commands::agents::agents_spawn,
            commands::agents::agents_kill,
            commands::agents::agents_new_session,
            commands::agents::agents_load_session,
            commands::agents::agents_replay_transcript,
            commands::agents::agents_snapshot,
            commands::agents::agents_snapshot_meta,
            commands::agents::agents_send,
            commands::agents::agents_cancel,
            commands::agents::agents_set_mode,
            commands::agents::agents_set_model,
            commands::agents::agents_set_effort,
            commands::agents::agents_set_compress,
            commands::mcp::mcp_list,
            commands::mcp::mcp_save,
            commands::models_pricing::models_pricing_get,
            commands::models_pricing::models_pricing_refresh,
            commands::agents::agents_respond_permission,
            commands::agents::agents_list_auth_methods,
            commands::agents::agents_run_auth_method,
            commands::agents::agents_authenticate,
            commands::agents::agents_drop_session,
            commands::agents::codex_status,
            commands::cersei::cersei_list_sessions,
            commands::cersei::cersei_session_transcript,
            commands::cersei::cersei_delete_session,
            commands::byok::byok_list,
            commands::byok::byok_set,
            commands::byok::byok_delete,
            commands::byok::byok_get,
            commands::byok::byok_env_list,
            commands::modelchat::modelchat_models,
            commands::modelchat::modelchat_stream,
            commands::modelchat::modelchat_cancel,
            commands::review::review_providers,
            commands::review::review_base_branches,
            commands::review::review_start,
            commands::review::review_cancel,
            commands::review::review_list,
            commands::review::review_get,
            commands::modelchat_sessions::modelchat_sessions_list,
            commands::modelchat_sessions::modelchat_session_get,
            commands::modelchat_sessions::modelchat_session_save,
            commands::modelchat_sessions::modelchat_session_delete,
            commands::fileindex::fileindex_open_project,
            commands::fileindex::fileindex_close_project,
            commands::fileindex::fileindex_search,
            commands::fileindex::fileindex_search_dirs,
            commands::fileindex::fileindex_status,
            commands::sessions_watch::sessions_watch_open,
            commands::sessions_watch::sessions_watch_close,
            commands::sessions_watch::sessions_watch_status,
            commands::papers::list_saved_papers,
            commands::pomodoro::pomodoro_load,
            commands::pomodoro::pomodoro_save,
            commands::plans::plans_load,
            commands::plans::plans_append,
            commands::agent_memory::agent_memory_read,
            commands::agent_memory::list_codex_sessions,
            commands::agent_memory::codex_delete_session,
            commands::kilo::list_kilo_sessions,
            commands::kilo::kilo_delete_session,
            commands::memory_graph::memory_embed_status,
            commands::memory_graph::memory_embed_download,
            commands::memory_graph::memory_index_build,
            commands::memory_graph::memory_index_query,
            commands::memory_graph::memory_graph_layout_load,
            commands::memory_graph::memory_graph_layout_save,
            commands::memory_policy::memory_policies,
            commands::memory_policy::memory_policy_update,
            commands::memory_sharing::memory_sharing_get,
            commands::memory_sharing::memory_sharing_set,
            commands::memory_sharing::memory_summarizer_get,
            commands::memory_sharing::memory_summarizer_set,
            commands::shared_memory::memory_get_state,
            commands::shared_memory::memory_query,
            commands::shared_memory::memory_list_events,
            commands::shared_memory::memory_clear_project,
            commands::shared_memory::memory_append_event,
            commands::memory_timeline::memory_timeline,
            commands::memory_timeline::memory_timeline_cached,
            commands::memory_chat::memory_chat_model_status,
            commands::memory_chat::memory_chat_model_download,
            commands::memory_chat::memory_chat_model_load,
            commands::memory_chat::memory_chat_backend,
            commands::memory_chat::memory_chat_send,
            commands::memory_chat::memory_chat_cancel,
            commands::memory_chat::memory_chat_retrieve,
            commands::memory_indexer::force_reindex,
            commands::memory_indexer::memory_indexer_close_project,
            commands::models::models_list,
            commands::models::model_download,
            commands::models::model_remove,
            commands::models::model_select,
            commands::codebase_index::codebase_index_status,
            commands::codebase_index::codebase_index_build,
            commands::memory_chat_sessions::memory_chat_sessions_list,
            commands::memory_chat_sessions::memory_chat_session_get,
            commands::memory_chat_sessions::memory_chat_session_save,
            commands::memory_chat_sessions::memory_chat_session_delete,
            commands::session_chat::session_chat_retrieve,
            commands::session_chat_sessions::session_chat_threads_list,
            commands::session_chat_sessions::session_chat_thread_get,
            commands::session_chat_sessions::session_chat_thread_save,
            commands::session_chat_sessions::session_chat_thread_delete,
            commands::pdf_annotations::pdf_annotations_load,
            commands::pdf_annotations::pdf_annotations_save,
            commands::skills::skills_list,
            commands::skills::skills_read,
            commands::skills::skills_set_enabled,
            commands::skills::skills_delete,
            commands::skills::skills_path,
            commands::skills::skills_adopt,
            commands::skills::agents_list_skill_targets,
            commands::skills::skills_list_plugins,
            commands::skills::tools_list,
            commands::skills::skills_reconcile,
            commands::skills::skills_project,
            commands::skills::skills_unproject,
            commands::skills::skills_promote,
            commands::skills::skills_freeze,
            commands::skills::pack_inspect,
            commands::skills::pack_search,
            commands::skills::pack_remote_preview,
            commands::skills::pack_install_remote,
            commands::skills::pack_install_skill,
            commands::skills::pack_list,
            commands::skills::pack_check_update,
            commands::skills::pack_project,
            commands::skills::pack_unproject,
            commands::skills::pack_uninstall,
            commands::skills::pack_projections,
            commands::skills::pack_components_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Atlas")
        .run(|app_handle, event| {
            // Apply-on-quit: if the user chose "Later" for a staged update, swap
            // it in on the way out so the next launch is the new version.
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    // Quit sweep (M7): stop native turns (cancel tokens kill
                    // tool process groups) and tear down every ACP subprocess
                    // (dropping each driver's shutdown channel closes the
                    // child's stdin; the SDK reaps it). `process::exit` skips
                    // Drop impls, so this must happen before the exit — with a
                    // short bounded grace for the async teardown to run.
                    if let Some(manager) =
                        app_handle.try_state::<atlas_agents::AgentManager>()
                    {
                        manager.shutdown();
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
                tauri::RunEvent::Exit => {
                    commands::updater::apply_on_exit(app_handle);
                }
                _ => {}
            }
        });
}
