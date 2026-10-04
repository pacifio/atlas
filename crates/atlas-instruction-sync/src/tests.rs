use super::*;
use std::fs;
use tempfile::TempDir;

fn rule(rel: &str, body: &str) -> Rule {
    Rule {
        rel_path: rel.to_string(),
        paths: Vec::new(),
        body: body.to_string(),
        imported_by: None,
    }
}

fn block_of(text: &str) -> &str {
    let start = text.find(BLOCK_START).expect("a block");
    let end = text.find(BLOCK_END).expect("an end marker") + BLOCK_END.len();
    &text[start..end]
}

fn upsert(existing: &str, inner: &str) -> String {
    upsert_block(existing, inner).expect("a clean upsert")
}

fn project() -> TempDir {
    tempfile::tempdir().unwrap()
}

fn read(root: &Path, name: &str) -> String {
    fs::read_to_string(root.join(name)).unwrap()
}

fn read_bytes(root: &Path, name: &str) -> Vec<u8> {
    fs::read(root.join(name)).unwrap()
}

/// Every file name in `root`, sorted: catches temp files left behind.
fn entries(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// ── parsing and rendering ───────────────────────────────────────────────────

#[test]
fn parse_rule_reads_block_and_inline_paths_and_drops_the_frontmatter() {
    let block = parse_rule(
        ".claude/rules/kanal.md",
        "---\npaths:\n  - \"sites/**\"\n  - 'actors/**'\nother: x\n---\n# Kanal\n\nbody\n",
    );
    assert_eq!(block.paths, vec!["sites/**", "actors/**"]);
    assert_eq!(block.body, "# Kanal\n\nbody");

    let inline = parse_rule("r.md", "---\npaths: [\"a/**\", b.md]\n---\ntext");
    assert_eq!(inline.paths, vec!["a/**", "b.md"]);
    assert_eq!(inline.body, "text");
}

#[test]
fn parse_rule_without_frontmatter_keeps_the_whole_file() {
    let r = parse_rule("r.md", "\u{feff}# Title\r\n\r\n- one\r\n");
    assert!(r.paths.is_empty());
    assert_eq!(r.body, "# Title\n\n- one");
}

#[test]
fn parse_rule_handles_frontmatter_at_end_of_file_and_an_empty_one() {
    assert_eq!(parse_rule("r.md", "---\npaths: [x]\n---").body, "");
    assert_eq!(parse_rule("r.md", "---\npaths: [x]\n---").paths, vec!["x"]);
    assert_eq!(parse_rule("r.md", "---\n---\nbody").body, "body");
}

#[test]
fn render_is_none_when_there_is_nothing_to_mirror() {
    assert_eq!(render(None, &[]), None);
    assert_eq!(render(Some("  \n\n"), &[rule("r.md", "  ")]), None);
}

#[test]
fn render_puts_claude_md_first_then_rules_with_their_scope() {
    let mut scoped = rule(".claude/rules/b.md", "B rule");
    scoped.paths = vec!["sites/**".into(), "tests/**".into()];
    let inner = render(
        Some("# Project\r\nrules\r\n"),
        &[rule(".claude/rules/a.md", "A rule"), scoped],
    )
    .unwrap();

    assert!(inner.starts_with("<!-- Mirrored by Atlas"));
    let claude = inner.find("## Mirrored from `CLAUDE.md`").unwrap();
    let a = inner.find("## Mirrored from `.claude/rules/a.md`").unwrap();
    let b = inner.find("## Mirrored from `.claude/rules/b.md`").unwrap();
    assert!(claude < a && a < b);
    assert!(inner.contains("# Project\nrules\n"));
    assert!(inner.contains("_Applies when working on: `sites/**`, `tests/**`_\n\nB rule"));
    assert!(!inner.contains('\r'));
    assert!(!has_marker_line(&inner), "the notice is not a marker line");
}

#[test]
fn the_markers_are_agent_neutral() {
    for marker in [BLOCK_START, BLOCK_END] {
        assert!(marker.contains("atlas:mirrored-instructions"));
        assert!(!marker.to_ascii_lowercase().contains("claude"));
        assert!(!marker.to_ascii_lowercase().contains("codex"));
    }
}

// ── splicing ────────────────────────────────────────────────────────────────

#[test]
fn upsert_appends_after_user_content_and_replaces_in_place_after() {
    let user = "# Mine\n\nKeep this.\n";
    let once = upsert(user, "first");
    assert_eq!(
        once,
        format!("# Mine\n\nKeep this.\n\n{BLOCK_START}\nfirst\n{BLOCK_END}\n")
    );

    let with_tail = format!("{once}\n## After\n");
    let twice = upsert(&with_tail, "second");
    assert!(twice.starts_with("# Mine\n\nKeep this.\n\n"));
    assert!(twice.ends_with("\n## After\n"));
    assert_eq!(
        block_of(&twice),
        format!("{BLOCK_START}\nsecond\n{BLOCK_END}")
    );
    assert_eq!(twice.matches(BLOCK_START).count(), 1);

    assert_eq!(upsert(&twice, "second"), twice, "idempotent");
}

#[test]
fn upsert_into_an_empty_file_is_just_the_block() {
    assert_eq!(upsert("", "x"), format!("{BLOCK_START}\nx\n{BLOCK_END}\n"));
}

#[test]
fn upsert_and_remove_keep_crlf_files_crlf() {
    let user = "# Mine\r\nline\r\n";
    let with = upsert(user, "a\nb");
    assert!(
        !with.replace("\r\n", "").contains('\n'),
        "every newline is CRLF"
    );
    assert!(with.contains("a\r\nb"));
    assert_eq!(remove_block(&with), user);
}

#[test]
fn remove_restores_the_users_text() {
    for user in [
        "# Mine\n\nKeep this.\n",
        "no trailing blank\n",
        "two trailing blanks\n\n\n",
        "\n",
        "",
    ] {
        assert_eq!(remove_block(&upsert(user, "x")), user, "{user:?}");
    }
    let user = "# Mine\n\nKeep this.\n";
    assert_eq!(remove_block(user), user, "no block, no change");

    let around = format!("top\n\n{BLOCK_START}\nx\n{BLOCK_END}\n\nbottom\n");
    assert_eq!(remove_block(&around), "top\n\nbottom\n");
}

#[test]
fn a_marker_quoted_in_the_users_text_is_not_the_block() {
    // A user's own AGENTS.md lost the rest of a paragraph that quoted the
    // start marker inline: the first sync after it took that quote for the
    // block and replaced everything from there on.
    let user = format!(
        "# Notes

Atlas keeps a block between `{BLOCK_START}` and `{BLOCK_END}` at the end.
Keep this line.
"
    );
    let once = upsert(&user, "first");
    assert!(once.starts_with(&user), "the user's text is kept whole");
    let twice = upsert(&once, "second");
    assert!(twice.starts_with(&user), "and survives the next sync");
    assert!(twice.contains("second") && !twice.contains("first"));
    assert_eq!(remove_block(&twice), user);
    assert_eq!(
        remove_block(&user),
        user,
        "a quoted marker alone is not a block"
    );
}

// ── 1. a broken marker pair never costs the user text ──────────────────────

#[test]
fn anything_but_one_clean_marker_pair_is_refused() {
    let broken = [
        // END deleted.
        format!("mine\n\n{BLOCK_START}\nold\n"),
        // START deleted.
        format!("mine\n\nold\n{BLOCK_END}\n"),
        // END with a trailing space, or indented.
        format!("{BLOCK_START}\nold\n{BLOCK_END} \nmine\n"),
        format!("{BLOCK_START}\nold\n  {BLOCK_END}\nmine\n"),
        // START indented, END clean.
        format!("\t{BLOCK_START}\nold\n{BLOCK_END}\nmine\n"),
        // END before START.
        format!("{BLOCK_END}\nmine\n{BLOCK_START}\n"),
        // Two blocks.
        format!("{BLOCK_START}\na\n{BLOCK_END}\nmine\n{BLOCK_START}\nb\n{BLOCK_END}\n"),
        // A re-spaced marker comment elsewhere.
        format!("{BLOCK_START}\na\n{BLOCK_END}\n<!--atlas:mirrored-instructions END-->\n"),
    ];
    for text in &broken {
        assert_eq!(
            upsert_block(text, "new"),
            Err(SkipReason::Markers),
            "{text:?}"
        );
        assert_eq!(&remove_block(text), text, "{text:?}");
    }
}

#[test]
fn a_deleted_end_marker_leaves_agents_md_alone_on_every_sync() {
    // The reviewed bug: with END gone a second block was appended, and the
    // next sync replaced everything between the stale START and the new END.
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "rule v1\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Created);

    let damaged = read(root, "AGENTS.md").replace(BLOCK_END, "") + "\nmy own paragraph\n";
    fs::write(root.join("AGENTS.md"), &damaged).unwrap();
    fs::write(root.join("CLAUDE.md"), "rule v2\n").unwrap();
    for _ in 0..3 {
        assert_eq!(sync(root).unwrap(), Outcome::Skipped(SkipReason::Markers));
        assert_eq!(read(root, "AGENTS.md"), damaged);
    }
    assert_eq!(
        remove(root, false).unwrap(),
        Outcome::Skipped(SkipReason::Markers)
    );
    assert_eq!(read(root, "AGENTS.md"), damaged);
}

#[test]
fn a_marker_with_trailing_whitespace_is_a_near_miss_not_a_marker() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    let text = format!("mine\n\n{BLOCK_START}\nold\n{BLOCK_END}  \n\nafter\n");
    fs::write(root.join("AGENTS.md"), &text).unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Skipped(SkipReason::Markers));
    assert_eq!(read(root, "AGENTS.md"), text);
}

// ── 2. links and self-reference ─────────────────────────────────────────────

/// Make `link` a symlink to `target`, or `false` where the OS refuses (Windows
/// without developer mode or the privilege).
fn try_symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, link);
    match made {
        Ok(()) => true,
        Err(e) => {
            eprintln!("skipping: cannot create a symlink here ({e})");
            false
        }
    }
}

#[test]
fn a_symlinked_agents_md_is_not_replaced() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    if !try_symlink(&root.join("CLAUDE.md"), &root.join("AGENTS.md")) {
        return;
    }
    assert_eq!(sync(root).unwrap(), Outcome::Skipped(SkipReason::Linked));
    assert!(fs::symlink_metadata(root.join("AGENTS.md"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(read(root, "CLAUDE.md"), "rule\n");
    assert_eq!(
        remove(root, false).unwrap(),
        Outcome::Skipped(SkipReason::Linked)
    );
}

#[test]
fn a_symlinked_claude_md_never_feeds_the_block_back_into_itself() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "shared rules\n").unwrap();
    if !try_symlink(&root.join("AGENTS.md"), &root.join("CLAUDE.md")) {
        return;
    }
    for _ in 0..3 {
        assert_eq!(sync(root).unwrap(), Outcome::Skipped(SkipReason::Linked));
    }
    assert_eq!(read(root, "AGENTS.md"), "shared rules\n");
}

#[test]
fn same_file_sees_through_a_differently_spelled_path() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "x").unwrap();
    fs::write(root.join("CLAUDE.md"), "x").unwrap();
    fs::create_dir(root.join("sub")).unwrap();
    let detour = root.join("sub").join("..").join("AGENTS.md");
    assert!(same_file(&root.join("AGENTS.md"), &detour));
    assert!(!same_file(&root.join("AGENTS.md"), &root.join("CLAUDE.md")));
    assert!(!same_file(
        &root.join("AGENTS.md"),
        &root.join("missing.md")
    ));
}

#[test]
fn a_hard_linked_pair_is_left_alone() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "shared rules\n").unwrap();
    fs::hard_link(root.join("AGENTS.md"), root.join("CLAUDE.md")).unwrap();
    let outcome = sync(root).unwrap();
    assert!(
        matches!(
            outcome,
            Outcome::Skipped(SkipReason::Linked | SkipReason::SameFile)
        ),
        "{outcome:?}"
    );
    assert_eq!(read(root, "AGENTS.md"), "shared rules\n");
    assert_eq!(read(root, "CLAUDE.md"), "shared rules\n");
}

#[test]
fn a_claude_md_that_only_imports_agents_md_is_left_alone() {
    for import in [
        "@AGENTS.md",
        "  @AGENTS.md  \r\n\r\n",
        "\u{feff}@./AGENTS.md\n",
    ] {
        let dir = project();
        let root = dir.path();
        fs::write(root.join("CLAUDE.md"), import).unwrap();
        fs::write(root.join("AGENTS.md"), "the rules\n").unwrap();
        assert_eq!(
            sync(root).unwrap(),
            Outcome::Skipped(SkipReason::ImportsAgentsMd),
            "{import:?}"
        );
        assert_eq!(read(root, "AGENTS.md"), "the rules\n");
    }
}

// ── 3. a source that holds the markers ──────────────────────────────────────

#[test]
fn a_source_documenting_the_markers_is_not_mirrored_and_nothing_grows() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "mine\n").unwrap();
    let claude = format!("Atlas writes:\n\n```\n{BLOCK_START}\n...\n{BLOCK_END}\n```\n");
    fs::write(root.join("CLAUDE.md"), &claude).unwrap();
    for _ in 0..3 {
        assert_eq!(
            sync(root).unwrap(),
            Outcome::Skipped(SkipReason::SourceHasMarker)
        );
        assert_eq!(read(root, "AGENTS.md"), "mine\n");
    }

    // The same from a rule file, quoted with an indent.
    fs::write(root.join("CLAUDE.md"), "fine\n").unwrap();
    fs::create_dir_all(root.join(".claude/rules")).unwrap();
    fs::write(
        root.join(".claude/rules/doc.md"),
        format!("    {BLOCK_END}\n"),
    )
    .unwrap();
    assert_eq!(
        sync(root).unwrap(),
        Outcome::Skipped(SkipReason::SourceHasMarker)
    );
    assert_eq!(read(root, "AGENTS.md"), "mine\n");

    // An inline mention is fine.
    fs::write(
        root.join(".claude/rules/doc.md"),
        format!("The block ends at `{BLOCK_END}`.\n"),
    )
    .unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    assert_eq!(sync(root).unwrap(), Outcome::Unchanged);
}

#[test]
fn upsert_refuses_an_inner_text_with_a_marker_line() {
    assert_eq!(
        upsert_block("mine\n", &format!("a\n{BLOCK_END}\nb")),
        Err(SkipReason::SourceHasMarker)
    );
}

// ── 4. line endings outside the block are kept byte for byte ────────────────

#[test]
fn a_mixed_line_ending_file_keeps_every_byte_outside_the_block() {
    let head = "crlf line\r\nlf line\ncrlf again\r\n";
    let tail = "\r\nafter lf\nafter crlf\r\nno newline at end";
    let once = upsert(head, "a\nb");
    assert!(once.as_bytes().starts_with(head.as_bytes()));
    // The line before the block ends in CRLF, so the block does too.
    assert_eq!(
        block_of(&once),
        format!("{BLOCK_START}\r\na\r\nb\r\n{BLOCK_END}")
    );
    assert_eq!(remove_block(&once).as_bytes(), head.as_bytes());

    // In place, with mixed endings on both sides.
    let text = format!("{}{tail}", once.trim_end_matches("\r\n"));
    let start = text.find(BLOCK_START).unwrap();
    let end = text.find(BLOCK_END).unwrap() + BLOCK_END.len();
    let replaced = upsert(&text, "c");
    assert_eq!(&replaced.as_bytes()[..start], &text.as_bytes()[..start]);
    assert!(replaced.as_bytes().ends_with(&text.as_bytes()[end..]));
    assert_eq!(
        block_of(&replaced),
        format!("{BLOCK_START}\r\nc\r\n{BLOCK_END}")
    );

    // An LF line just before the block wins over a CRLF-dominant file.
    let lf_before = "a\r\nb\r\nc\r\nlast\n";
    assert_eq!(
        block_of(&upsert(lf_before, "x")),
        format!("{BLOCK_START}\nx\n{BLOCK_END}")
    );
}

#[test]
fn sync_on_a_mixed_file_changes_only_the_block_bytes() {
    let dir = project();
    let root = dir.path();
    let user = b"# Mine\r\nunix line\nwindows line\r\n";
    fs::write(root.join("AGENTS.md"), user).unwrap();
    fs::write(root.join("CLAUDE.md"), "v1\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    assert!(read_bytes(root, "AGENTS.md").starts_with(user));

    fs::write(root.join("CLAUDE.md"), "v2\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    let bytes = read_bytes(root, "AGENTS.md");
    assert!(bytes.starts_with(user));

    fs::remove_file(root.join("CLAUDE.md")).unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Removed);
    assert_eq!(read_bytes(root, "AGENTS.md"), user);
}

#[test]
fn a_block_at_byte_zero_after_a_bom_is_found_and_the_bom_kept() {
    let text = format!("\u{feff}{BLOCK_START}\r\nold\r\n{BLOCK_END}\r\n\r\nmine\r\n");
    let next = upsert(&text, "new");
    assert_eq!(
        next,
        format!("\u{feff}{BLOCK_START}\r\nnew\r\n{BLOCK_END}\r\n\r\nmine\r\n")
    );
    assert_eq!(remove_block(&next), "\u{feff}mine\r\n");

    // Appending to a BOM-only file keeps the BOM and adds no blank line.
    assert_eq!(
        upsert("\u{feff}", "x"),
        format!("\u{feff}{BLOCK_START}\nx\n{BLOCK_END}\n")
    );
}

// ── 5. read-only files and permissions ──────────────────────────────────────

#[allow(clippy::permissions_set_readonly_false)]
fn set_readonly(path: &Path, readonly: bool) {
    let mut perms = fs::metadata(path).unwrap().permissions();
    perms.set_readonly(readonly);
    fs::set_permissions(path, perms).unwrap();
}

#[test]
fn a_read_only_agents_md_is_not_written() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "mine\n").unwrap();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    set_readonly(&root.join("AGENTS.md"), true);

    assert_eq!(sync(root).unwrap(), Outcome::Skipped(SkipReason::ReadOnly));
    assert_eq!(read(root, "AGENTS.md"), "mine\n");
    assert!(fs::metadata(root.join("AGENTS.md"))
        .unwrap()
        .permissions()
        .readonly());
    assert_eq!(
        entries(root),
        ["AGENTS.md", "CLAUDE.md"],
        "no temp file left"
    );

    set_readonly(&root.join("AGENTS.md"), false);
}

#[cfg(unix)]
#[test]
fn a_write_keeps_the_files_mode() {
    use std::os::unix::fs::PermissionsExt;
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "mine\n").unwrap();
    fs::set_permissions(root.join("AGENTS.md"), fs::Permissions::from_mode(0o640)).unwrap();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    let mode = fs::metadata(root.join("AGENTS.md"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o640);
}

// ── 6. concurrent writers ───────────────────────────────────────────────────

#[test]
fn a_save_between_read_and_rename_is_kept() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "mine\n").unwrap();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();

    let agents = root.join("AGENTS.md");
    let outcome = run(root, Mode::Mirror, &mut || {
        fs::write(&agents, "mine, edited in an editor\n").unwrap();
    })
    .unwrap();
    assert_eq!(outcome, Outcome::Skipped(SkipReason::ChangedDuringSync));
    assert_eq!(read(root, "AGENTS.md"), "mine, edited in an editor\n");
    assert_eq!(
        entries(root),
        ["AGENTS.md", "CLAUDE.md"],
        "no temp file left"
    );

    // The next sync starts from the editor's text.
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    assert!(read(root, "AGENTS.md").starts_with("mine, edited in an editor\n\n"));
}

#[test]
fn a_file_created_mid_sync_is_kept() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    let agents = root.join("AGENTS.md");
    let outcome = run(root, Mode::Mirror, &mut || {
        fs::write(&agents, "created meanwhile\n").unwrap();
    })
    .unwrap();
    assert_eq!(outcome, Outcome::Skipped(SkipReason::ChangedDuringSync));
    assert_eq!(read(root, "AGENTS.md"), "created meanwhile\n");
}

#[test]
fn temp_files_are_unique_per_call() {
    let path = Path::new("/p/AGENTS.md");
    let a = temp_path(path);
    let b = temp_path(path);
    assert_ne!(a, b);
    assert!(!is_source_path(Path::new("/p"), &a));
}

#[test]
fn concurrent_syncs_of_one_root_leave_one_clean_block() {
    let dir = project();
    let root = dir.path().to_path_buf();
    fs::write(root.join("AGENTS.md"), "mine\n").unwrap();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    // Every thread is started before any is joined, hence the collect.
    #[allow(clippy::needless_collect)]
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let root = root.clone();
            std::thread::spawn(move || sync(&root).unwrap())
        })
        .collect();
    let outcomes: Vec<Outcome> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    // Serialised by the per-root lock: one writes, the rest find it done.
    assert_eq!(
        outcomes.iter().filter(|o| **o == Outcome::Written).count(),
        1
    );
    assert!(outcomes
        .iter()
        .all(|o| matches!(o, Outcome::Written | Outcome::Unchanged)));
    let agents = read(&root, "AGENTS.md");
    assert!(agents.starts_with("mine\n\n"));
    assert_eq!(agents.matches(BLOCK_START).count(), 1);
    assert_eq!(entries(&root), ["AGENTS.md", "CLAUDE.md"]);
}

// ── sync and remove ─────────────────────────────────────────────────────────

#[test]
fn sync_creates_agents_md_and_then_leaves_it_alone() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "# Rules\nask first\n").unwrap();
    fs::create_dir_all(root.join(".claude/rules/sub")).unwrap();
    fs::write(root.join(".claude/rules/db.md"), "db rule\n").unwrap();
    fs::write(root.join(".claude/rules/sub/deep.md"), "deep rule\n").unwrap();
    fs::write(root.join(".claude/rules/notes.txt"), "not a rule").unwrap();

    assert_eq!(sync(root).unwrap(), Outcome::Created);
    let agents = read(root, "AGENTS.md");
    assert!(agents.contains("ask first"));
    assert!(agents.contains("## Mirrored from `.claude/rules/db.md`"));
    assert!(agents.contains("## Mirrored from `.claude/rules/sub/deep.md`"));
    assert!(!agents.contains("not a rule"));

    assert_eq!(sync(root).unwrap(), Outcome::Unchanged);
}

#[test]
fn sync_follows_source_edits_and_keeps_user_content() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("AGENTS.md"), "# Agent notes\n\nmine\n").unwrap();
    fs::write(root.join("CLAUDE.md"), "v1\n").unwrap();
    sync(root).unwrap();

    fs::write(root.join("CLAUDE.md"), "v2\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    let agents = read(root, "AGENTS.md");
    assert!(agents.starts_with("# Agent notes\n\nmine\n\n"));
    assert!(agents.contains("v2") && !agents.contains("v1"));
}

#[test]
fn sync_removes_the_block_when_the_sources_go_and_creates_nothing_without_them() {
    let dir = project();
    let root = dir.path();
    assert_eq!(sync(root).unwrap(), Outcome::NothingToMirror);
    assert!(!root.join("AGENTS.md").exists());

    fs::write(root.join("AGENTS.md"), "mine\n").unwrap();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    sync(root).unwrap();
    fs::remove_file(root.join("CLAUDE.md")).unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Removed);
    assert_eq!(read(root, "AGENTS.md"), "mine\n");
    assert_eq!(sync(root).unwrap(), Outcome::NothingToMirror);
}

#[test]
fn remove_takes_the_block_out_and_restores_the_users_bytes() {
    let dir = project();
    let root = dir.path();
    let user = "# Mine\r\nkeep\n";
    fs::write(root.join("AGENTS.md"), user).unwrap();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    assert_eq!(remove(root, false).unwrap(), Outcome::Removed);
    assert_eq!(read(root, "AGENTS.md"), user);
    assert_eq!(remove(root, false).unwrap(), Outcome::NothingToMirror);
    assert_eq!(
        read(root, "AGENTS.md"),
        user,
        "the sources are not mirrored"
    );
}

#[test]
fn remove_deletes_an_agents_md_only_when_atlas_created_it_and_it_is_empty() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Created);
    assert_eq!(remove(root, true).unwrap(), Outcome::Removed);
    assert!(!root.join("AGENTS.md").exists());
    assert_eq!(remove(root, true).unwrap(), Outcome::NothingToMirror);
}

#[test]
fn remove_keeps_an_emptied_agents_md_unless_told_atlas_created_it() {
    let dir = project();
    let root = dir.path();
    // The user's own empty AGENTS.md: a sync writes into it, not creates it.
    fs::write(root.join("AGENTS.md"), "").unwrap();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    assert_eq!(remove(root, false).unwrap(), Outcome::Removed);
    assert_eq!(read(root, "AGENTS.md"), "");
}

#[test]
fn an_atlas_created_agents_md_the_user_wrote_into_is_kept() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Created);
    let with_block = read(root, "AGENTS.md");
    fs::write(root.join("AGENTS.md"), format!("# Mine\n\n{with_block}")).unwrap();
    assert_eq!(remove(root, true).unwrap(), Outcome::Removed);
    assert_eq!(read(root, "AGENTS.md"), "# Mine\n");
}

#[test]
fn a_sync_never_deletes_agents_md() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "rule\n").unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Created);
    fs::remove_file(root.join("CLAUDE.md")).unwrap();
    assert_eq!(sync(root).unwrap(), Outcome::Removed);
    assert_eq!(read(root, "AGENTS.md"), "");
}

// ── 8b. .claude/CLAUDE.md and imports ───────────────────────────────────────

#[test]
fn dot_claude_claude_md_is_mirrored_after_claude_md() {
    let dir = project();
    let root = dir.path();
    fs::create_dir_all(root.join(".claude/rules")).unwrap();
    fs::write(root.join("CLAUDE.md"), "root rule\n").unwrap();
    fs::write(root.join(".claude/CLAUDE.md"), "@AGENTS.md\ndot rule\n").unwrap();
    fs::write(root.join(".claude/rules/a.md"), "a rule\n").unwrap();
    sync(root).unwrap();
    let agents = read(root, "AGENTS.md");
    let at = |s: &str| agents.find(s).unwrap_or_else(|| panic!("{s} missing"));
    assert!(at("root rule") < at("## Mirrored from `.claude/CLAUDE.md`"));
    assert!(at("dot rule") < at("## Mirrored from `.claude/rules/a.md`"));
    assert!(!agents.contains("@AGENTS.md"));
}

#[test]
fn a_dot_claude_md_that_is_agents_md_is_left_alone() {
    let dir = project();
    let root = dir.path();
    fs::create_dir_all(root.join(".claude")).unwrap();
    fs::write(root.join("AGENTS.md"), "shared\n").unwrap();
    if fs::hard_link(root.join("AGENTS.md"), root.join(".claude/CLAUDE.md")).is_err() {
        return;
    }
    // The hard link itself already stops the write; either reason keeps it.
    assert!(matches!(
        sync(root).unwrap(),
        Outcome::Skipped(SkipReason::Linked | SkipReason::SameFile)
    ));
    assert_eq!(read(root, "AGENTS.md"), "shared\n");
}

#[test]
fn import_tokens_skip_code_and_mentions() {
    let text = "See @docs/a.md and `@not/this.md`.\nmail me@example.com\n\
                ```\n@fenced.md\n```\n~~~md\n@also/fenced.md\n~~~\n@b.md\n";
    assert_eq!(import_tokens(text), vec!["docs/a.md", "b.md"]);
}

#[test]
fn imports_are_mirrored_after_their_source_relative_to_it() {
    let dir = project();
    let root = dir.path();
    fs::create_dir_all(root.join("docs/more")).unwrap();
    fs::create_dir_all(root.join(".claude/rules")).unwrap();
    fs::write(root.join("CLAUDE.md"), "Read @docs/style.md.\n").unwrap();
    // Relative to the importing file, not the root.
    fs::write(root.join("docs/style.md"), "style rule @more/deep.md\n").unwrap();
    fs::write(root.join("docs/more/deep.md"), "deep rule\n").unwrap();
    fs::write(
        root.join(".claude/rules/r.md"),
        "r rule @../../docs/style.md\n",
    )
    .unwrap();
    sync(root).unwrap();
    let agents = read(root, "AGENTS.md");
    let at = |s: &str| agents.find(s).unwrap_or_else(|| panic!("{s} missing"));
    assert!(
        agents.contains("Read @docs/style.md."),
        "the import line is kept"
    );
    assert!(at("## Mirrored from `docs/style.md` (imported by `CLAUDE.md`)") < at("style rule"));
    assert!(
        at("## Mirrored from `docs/more/deep.md` (imported by `docs/style.md`)")
            < at("## Mirrored from `.claude/rules/r.md`")
    );
    assert_eq!(agents.matches("style rule").count(), 1, "each file once");

    let canon = fs::canonicalize(root).unwrap();
    assert_eq!(
        imported_files(root),
        vec![canon.join("docs/style.md"), canon.join("docs/more/deep.md")]
    );
}

#[test]
fn imports_stop_at_the_depth_limit_and_survive_cycles() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "@f1.md\n").unwrap();
    for i in 1..=7 {
        fs::write(
            root.join(format!("f{i}.md")),
            format!("file {i} @f{}.md\n", i + 1),
        )
        .unwrap();
    }
    fs::write(root.join("f8.md"), "file 8 @f1.md @CLAUDE.md\n").unwrap();
    sync(root).unwrap();
    let agents = read(root, "AGENTS.md");
    for i in 1..=MAX_IMPORT_DEPTH {
        assert!(agents.contains(&format!("file {i} ")), "hop {i}");
    }
    assert!(!agents.contains(&format!("file {} ", MAX_IMPORT_DEPTH + 1)));
}

#[test]
fn files_outside_the_project_are_never_imported() {
    let outer = project();
    let root = outer.path().join("repo");
    fs::create_dir_all(&root).unwrap();
    fs::write(outer.path().join("secret.md"), "personal note\n").unwrap();
    fs::write(
        root.join("CLAUDE.md"),
        "@../secret.md @~/.claude/notes.md @AGENTS.md @./AGENTS.md\nrule\n",
    )
    .unwrap();
    fs::write(root.join("AGENTS.md"), "mine\n").unwrap();
    assert_eq!(sync(&root).unwrap(), Outcome::Written);
    let agents = read(&root, "AGENTS.md");
    assert!(!agents.contains("personal note"));
    assert!(
        agents.contains("@../secret.md"),
        "the import line is kept as written"
    );
    assert_eq!(agents.matches("## Mirrored from").count(), 1);
    assert!(imported_files(&root).is_empty());
}

#[test]
fn an_imported_file_with_a_marker_is_not_mirrored() {
    let dir = project();
    let root = dir.path();
    fs::write(root.join("CLAUDE.md"), "@doc.md\n").unwrap();
    fs::write(root.join("doc.md"), format!("{BLOCK_START}\n")).unwrap();
    assert_eq!(
        sync(root).unwrap(),
        Outcome::Skipped(SkipReason::SourceHasMarker)
    );
}

// ── 9. pack rules ───────────────────────────────────────────────────────────

fn pack_project(root: &Path, agents_md: &str) {
    fs::create_dir_all(root.join(".claude/rules")).unwrap();
    fs::write(root.join(".claude/rules/own.md"), "own rule").unwrap();
    fs::write(root.join(".claude/rules/Style Guide.md"), "pack rule").unwrap();
    fs::create_dir_all(root.join(".atlas/packs")).unwrap();
    // The ledger exactly as the pack installer writes it (camelCase).
    fs::write(
        root.join(".atlas/packs/.pack-projections.json"),
        r#"{"version":1,"projections":{"demo":{
            "claude-code":[{"kind":"rule","relPath":"rules/Style Guide.md","leaf":"Style Guide.md","mode":"copy","targetRel":".claude/rules/Style Guide.md"}],
            "codex":[{"kind":"rule","relPath":"rules/Style Guide.md","leaf":"style-guide","mode":"append","targetRel":"AGENTS.md"}]
        }}}"#,
    )
    .unwrap();
    fs::write(root.join("AGENTS.md"), agents_md).unwrap();
}

#[test]
fn a_pack_rule_already_in_agents_md_is_not_mirrored_again() {
    let dir = project();
    let root = dir.path();
    let agents = "<!-- atlas-pack:demo:style-guide START -->\npack rule\n<!-- atlas-pack:demo:style-guide END -->\n";
    pack_project(root, agents);

    assert_eq!(
        pack_rules_in_agents_md(root, agents),
        vec![".claude/rules/Style Guide.md"]
    );
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    let text = read(root, "AGENTS.md");
    assert!(text.starts_with(agents), "the pack's block is untouched");
    let block = block_of(&text);
    assert!(block.contains("own rule"));
    assert!(!block.contains("pack rule"));
}

#[test]
fn a_pack_rule_missing_from_agents_md_is_mirrored() {
    // A pack projected only into `.claude/rules`: an agent that reads
    // AGENTS.md would never see the rule unless it is mirrored.
    let dir = project();
    let root = dir.path();
    pack_project(root, "mine\n");
    assert!(pack_rules_in_agents_md(root, "mine\n").is_empty());
    assert_eq!(sync(root).unwrap(), Outcome::Written);
    let block = read(root, "AGENTS.md");
    let block = block_of(&block);
    assert!(block.contains("own rule") && block.contains("pack rule"));
}

#[test]
fn an_agents_md_import_in_claude_md_is_not_mirrored() {
    let inner = render(
        Some("@AGENTS.md\n\nClaude-only rule\n  @./AGENTS.md\n"),
        &[],
    )
    .unwrap();
    assert!(inner.contains("Claude-only rule"));
    assert!(!inner.contains("@AGENTS.md") && !inner.contains("@./AGENTS.md"));
    assert_eq!(render(Some("@AGENTS.md\n\n"), &[]), None);
}

#[test]
fn the_pack_rule_name_follows_the_installers_sanitizing() {
    assert_eq!(pack_rule_name("Style Guide"), "style-guide");
    assert_eq!(pack_rule_name("a__b..c"), "a__b..c");
    assert_eq!(pack_rule_name("-x!!y-"), "x-y");
}

// ── 7. what a watcher watches ───────────────────────────────────────────────

#[test]
fn source_paths_are_the_ones_sync_reads() {
    let root = Path::new("/p");
    assert!(is_source_path(root, Path::new("/p/CLAUDE.md")));
    assert!(is_source_path(root, Path::new("/p/claude.md")));
    assert!(is_source_path(root, Path::new("/p/.claude/CLAUDE.md")));
    assert!(is_source_path(root, Path::new("/p/.claude/rules/a.md")));
    assert!(is_source_path(root, Path::new("/p/.claude/rules/sub/B.MD")));
    assert!(is_source_path(
        root,
        Path::new("/p/.atlas/packs/.pack-projections.json")
    ));
    assert!(!is_source_path(root, Path::new("/p/AGENTS.md")));
    assert!(!is_source_path(
        root,
        Path::new("/p/.AGENTS.md.1.0.atlas-tmp")
    ));
    assert!(!is_source_path(root, Path::new("/p/.claude/settings.json")));
    assert!(!is_source_path(
        root,
        Path::new("/p/.claude/worktrees/x/CLAUDE.md")
    ));
    assert!(!is_source_path(root, Path::new("/elsewhere/CLAUDE.md")));
}

#[test]
fn only_the_rules_directory_is_watched_recursively() {
    let root = Path::new("/p");
    let targets = watch_targets(root);
    let recursive: Vec<&Path> = targets
        .iter()
        .filter(|t| t.recursive)
        .map(|t| t.path.as_path())
        .collect();
    assert_eq!(recursive, [Path::new("/p/.claude/rules")]);
    let claude = targets
        .iter()
        .find(|t| t.path == Path::new("/p/.claude"))
        .unwrap();
    assert!(
        !claude.recursive,
        ".claude may hold whole checkouts under worktrees/"
    );
    assert!(targets
        .iter()
        .all(|t| !t.path.starts_with("/p/.claude/worktrees")));
    // Parents come before the children they reveal.
    let pos = |p: &str| targets.iter().position(|t| t.path == Path::new(p));
    assert!(pos("/p/.claude") < pos("/p/.claude/rules"));
}

#[test]
fn a_watch_directory_appearing_is_noticed() {
    let root = Path::new("/p");
    for dir in [
        "/p/.claude",
        "/p/.claude/rules",
        "/p/.atlas",
        "/p/.atlas/packs",
    ] {
        assert!(is_watch_dir_path(root, Path::new(dir)), "{dir}");
    }
    assert!(!is_watch_dir_path(root, Path::new("/p/.claude/worktrees")));
    assert!(!is_watch_dir_path(root, Path::new("/p/src")));
}
