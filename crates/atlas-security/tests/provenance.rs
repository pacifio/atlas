use atlas_checkpoint::model::ProjectMode;
use atlas_checkpoint::tools::{resolve_path, ToolName};
use atlas_checkpoint::{
    hash_written_content, Capture, FileWrite, SessionKey, Source, Store, ToolCallContent,
    ToolStatus,
};
use atlas_security::provenance::{from_store, is_sensitive_path};

fn key() -> SessionKey {
    SessionKey {
        workspace_id: "ws-atlas".to_string(),
        source: Source::Acp,
        native_session_id: "sess-1".to_string(),
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    session_id: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join(".atlas")).unwrap();
    let session_id = Capture::new(&mut store, ProjectMode::Local)
        .record_prompt(&key(), "do the thing", 1, Some("claude-code"), None, None)
        .unwrap();
    Fixture {
        dir,
        store,
        session_id,
    }
}

fn call(
    f: &mut Fixture,
    id: &str,
    tool: ToolName,
    locations: serde_json::Value,
    arguments: Option<&str>,
) -> String {
    let session_id = f.session_id.clone();
    Capture::new(&mut f.store, ProjectMode::Local)
        .record_tool_call(
            &session_id,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some(id),
                tool_name: tool,
                title: Some(id),
                kind: None,
                status: ToolStatus::Completed,
                locations: &locations,
                arguments,
                result: None,
            },
        )
        .unwrap()
}

#[test]
fn read_of_dotenv_is_sensitive_read() {
    let mut f = fixture();
    call(
        &mut f,
        "r1",
        ToolName::Read,
        serde_json::json!([{ "path": ".env" }]),
        None,
    );
    call(
        &mut f,
        "r2",
        ToolName::Read,
        serde_json::json!([{ "path": "src/lib.rs" }]),
        None,
    );
    let p = from_store(&f.store, &f.session_id).unwrap();
    assert_eq!(p.sensitive_reads, vec![".env".to_string()]);
}

#[test]
fn env_example_is_not_sensitive() {
    assert!(!is_sensitive_path(".env.example"));
    assert!(!is_sensitive_path("config/.env.sample"));
    assert!(!is_sensitive_path(".env.template"));
    assert!(is_sensitive_path(".env.local"));
    assert!(is_sensitive_path("deploy/server.pem"));
    assert!(is_sensitive_path("/Users/x/.ssh/config"));
    assert!(is_sensitive_path("/Users/x/.aws/credentials"));
    assert!(!is_sensitive_path("src/environment.ts"));
}

#[test]
fn bash_cat_of_key_file_is_sensitive_read() {
    let mut f = fixture();
    call(
        &mut f,
        "b1",
        ToolName::Bash,
        serde_json::json!([]),
        Some(r#"{"command":"cat ~/.ssh/id_ed25519 | head -1"}"#),
    );
    call(
        &mut f,
        "b2",
        ToolName::Bash,
        serde_json::json!([]),
        Some(r#"{"command":"cargo test"}"#),
    );
    let p = from_store(&f.store, &f.session_id).unwrap();
    assert_eq!(p.sensitive_reads, vec!["~/.ssh/id_ed25519".to_string()]);
    assert_eq!(p.commands.len(), 2);
}

#[test]
fn fetch_url_collected() {
    let mut f = fixture();
    call(
        &mut f,
        "f1",
        ToolName::Fetch,
        serde_json::json!([]),
        Some(r#"{"url":"https://example.com/install.sh"}"#),
    );
    let p = from_store(&f.store, &f.session_id).unwrap();
    assert_eq!(
        p.fetched_urls,
        vec!["https://example.com/install.sh".to_string()]
    );
}

#[test]
fn agent_written_paths_from_file_touches() {
    let mut f = fixture();
    let call_id = call(
        &mut f,
        "w1",
        ToolName::Write,
        serde_json::json!([{ "path": "src/new.rs" }]),
        None,
    );
    let root = f.dir.path().to_path_buf();
    let session_id = f.session_id.clone();
    let content = b"pub fn x() {}";
    Capture::new(&mut f.store, ProjectMode::Local)
        .record_file_write(
            &session_id,
            &call_id,
            1,
            FileWrite {
                path: &resolve_path("src/new.rs", &root),
                sha256_after: Some(hash_written_content(content)),
                sketch_after: None,
                existed_before: false,
                deleted: false,
            },
        )
        .unwrap();
    let p = from_store(&f.store, &f.session_id).unwrap();
    assert!(
        p.agent_written.contains("src/new.rs"),
        "{:?}",
        p.agent_written
    );
}
