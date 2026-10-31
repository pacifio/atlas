//! `security-eval`: measure the scanner's layers on labelled cases.
//!
//! A developer tool, never shipped in the app (it needs the `eval` feature).
//!
//! ```text
//! cargo run -p atlas-security --features eval --bin security-eval -- <command>
//!
//!   local                       the local layers on every case
//!   real   [--repo DIR] [--clef] the local layers (or, with --clef, Clef) on
//!                               every file of the merges in
//!                               eval/real-merges.txt (presumed safe)
//!   clef   [--provenance] [--strip-comments] [--adversarial] [--concurrency N]
//!                               Clef on every hunk of every case; needs
//!                               CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
//!   export --project DIR --out FILE
//!                               every stored scan of a Project, as JSON, for
//!                               labelling shadow-mode results
//! ```
//!
//! Results are written under `target/security-eval/`. The Clef arm calls
//! Workers AI directly with the developer's own token; the app only ever
//! reaches Clef through Atlas's gateway. The token is never printed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_security::clef::{
    build_state, parse_answers, request_body, ESCALATE_AT, MAX_STATE_CHARS, WORTH_A_LOOK_AT,
};
use atlas_security::diff::parse_unified;
use atlas_security::eval::{adversarial, auc, load_cases, Case};
use atlas_security::map::{build, Limits};
use atlas_security::provenance::Provenance;
use atlas_security::repo::{GitCli, Repo, RepoError};
use atlas_security::scan::{scan_checkpoint, ScanInput};

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn out_dir() -> PathBuf {
    let dir = crate_dir().join("../../target/security-eval");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

/// Seconds since the epoch: enough to keep result files apart.
fn stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("local") => local(),
        Some("real") => real(&args),
        Some("clef") => clef(&args),
        Some("export") => export(&args),
        _ => {
            eprintln!("usage: security-eval <local|real|clef|export> (see the module docs)");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("security-eval: {e}");
            ExitCode::from(if e.starts_with("missing ") { 2 } else { 1 })
        }
    }
}

fn cases() -> Result<Vec<Case>, String> {
    load_cases(&crate_dir().join("eval/cases"))
}

fn by_class(rows: &[(String, bool)]) -> BTreeMap<String, (usize, usize)> {
    let mut out: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (class, hit) in rows {
        let e = out.entry(class.clone()).or_default();
        e.1 += 1;
        if *hit {
            e.0 += 1;
        }
    }
    out
}

// ── local ───────────────────────────────────────────────────────────────────

fn local() -> Result<(), String> {
    let cases = cases()?;
    let mut rows = Vec::new();
    let mut per_case = Vec::new();
    let (mut safe_flagged, mut safe_blocked, mut safe_total) = (0, 0, 0);
    for c in &cases {
        let res = c.scan_local();
        let flagged = !res.findings.is_empty();
        if c.vulnerable {
            rows.push((format!("{}/{}", c.kind, c.class), flagged));
        } else {
            safe_total += 1;
            safe_flagged += usize::from(flagged);
            safe_blocked += usize::from(res.blocking);
        }
        per_case.push(serde_json::json!({
            "id": c.id, "vulnerable": c.vulnerable, "class": c.class,
            "flagged": flagged, "blocking": res.blocking, "level": res.level,
            "rules": res.findings.iter().map(|f| f.rule_id.clone()).collect::<Vec<_>>(),
        }));
    }
    let caught = rows.iter().filter(|(_, h)| *h).count();
    println!("local layers on {} cases", cases.len());
    println!("  vulnerable caught (any finding): {caught}/{}", rows.len());
    println!("  safe with a finding: {safe_flagged}/{safe_total}   safe blocked: {safe_blocked}/{safe_total}");
    for (class, (hit, n)) in by_class(&rows) {
        println!("    {class:<28} {hit}/{n}");
    }
    let path = out_dir().join(format!("local-{}.json", stamp()));
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&per_case).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    println!("  per case: {}", path.display());
    Ok(())
}

// ── real ────────────────────────────────────────────────────────────────────

/// A merge commit read as "what the merge brought in": `merge^1..merge`.
struct MergeRepo {
    git: GitCli,
}

impl Repo for MergeRepo {
    fn commit_diff(&self, sha: &str) -> Result<Vec<u8>, RepoError> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.git.root)
            .args(["diff", "-M", "-U3", "--no-color", "--no-ext-diff"])
            .arg(format!("{sha}^1"))
            .arg(sha)
            .output()
            .map_err(|e| RepoError::Git(e.to_string()))?;
        if !out.status.success() {
            return Err(RepoError::MissingCommit(sha.to_string()));
        }
        Ok(out.stdout)
    }
    fn file_at(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>, RepoError> {
        self.git.file_at(rev, path)
    }
    fn parent(&self, sha: &str) -> Result<Option<String>, RepoError> {
        self.git.parent(sha)
    }
}

fn real(args: &[String]) -> Result<(), String> {
    let root = PathBuf::from(value(args, "--repo").unwrap_or("."));
    let merges_file = value(args, "--merges")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_dir().join("eval/real-merges.txt"));
    let merges = std::fs::read_to_string(&merges_file)
        .map_err(|e| format!("{}: {e}", merges_file.display()))?;
    let repo = MergeRepo {
        git: GitCli { root },
    };
    if flag(args, "--clef") {
        return real_clef(&repo, &merges, args);
    }
    let (mut files, mut findings, mut blocking) = (0usize, 0usize, Vec::new());
    let mut by_rule: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    for sha in merges.lines().filter_map(|l| l.split_whitespace().next()) {
        let res = scan_checkpoint(ScanInput {
            sha,
            repo: &repo,
            provenance: &Provenance::default(),
            advisories: None,
            limits: Limits::default(),
            deadline: Instant::now() + Duration::from_secs(120),
        });
        files += res.order.len();
        findings += res.findings.len();
        for f in &res.findings {
            let e = by_rule.entry(f.rule_id.clone()).or_default();
            e.0 += 1;
            if e.1.len() < 5 {
                e.1.push(format!("{sha:.8} {}", f.refs[0]));
            }
            if f.blocking {
                blocking.push(format!("{sha:.8} {} {}", f.rule_id, f.refs[0]));
            }
        }
    }
    println!(
        "local layers on {} merges, {files} changed files",
        merges.lines().count()
    );
    println!("  findings: {findings}   blocking: {}", blocking.len());
    for (rule, (n, examples)) in &by_rule {
        println!("    {rule:<36} {n}");
        for e in examples {
            println!("        e.g. {e}");
        }
    }
    for b in &blocking {
        println!("  BLOCK {b}");
    }
    Ok(())
}

/// Clef on every hunk of the merges (skipping `vendor/`, Markdown and
/// lockfiles, like the 2026-10-31 run), scored per file.
fn real_clef(repo: &MergeRepo, merges: &str, args: &[String]) -> Result<(), String> {
    let account = std::env::var("CLOUDFLARE_ACCOUNT_ID")
        .map_err(|_| "missing CLOUDFLARE_ACCOUNT_ID".to_string())?;
    let token = Arc::new(
        std::env::var("CLOUDFLARE_API_TOKEN")
            .map_err(|_| "missing CLOUDFLARE_API_TOKEN".to_string())?,
    );
    let concurrency: usize = value(args, "--concurrency")
        .and_then(|n| n.parse().ok())
        .unwrap_or(6);
    let url = Arc::new(format!(
        "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef"
    ));
    // (merge, path, state) for every sendable hunk.
    let mut jobs: Vec<(String, String, String)> = Vec::new();
    let mut unsent = 0usize;
    for sha in merges.lines().filter_map(|l| l.split_whitespace().next()) {
        let diff = repo.commit_diff(sha).map_err(|e| e.to_string())?;
        let map = build(parse_unified(&diff), &Limits::default());
        for file in &map.files {
            let path = &file.change.path;
            if file.skip.is_some()
                || path.starts_with("vendor/")
                || path.ends_with(".md")
                || atlas_security::tags::is_lockfile(path)
            {
                continue;
            }
            for i in 0..file.change.hunks.len() {
                let state = build_state(file, i, &Provenance::default(), &[], None, false);
                if state.len() > MAX_STATE_CHARS {
                    unsent += 1;
                    continue;
                }
                jobs.push((sha.to_string(), path.clone(), state));
            }
        }
    }
    println!(
        "clef on real merges: {} hunks to send ({unsent} too large, escalated)",
        jobs.len()
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    type Answer = Result<(BTreeMap<String, f64>, u64), String>;
    let results: Vec<(String, String, Answer)> = runtime.block_on(async {
        let client = reqwest::Client::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1)));
        let mut set = tokio::task::JoinSet::new();
        for (sha, path, state) in jobs {
            let (client, url, token, gate) =
                (client.clone(), url.clone(), token.clone(), gate.clone());
            set.spawn(async move {
                let _permit = gate.acquire_owned().await;
                let r = match ask(&client, &url, &token, &state).await {
                    Ok((v, t)) => parse_answers(&v).map(|a| (a.yes, t)),
                    Err(e) => Err(e),
                };
                (sha, path, r)
            });
        }
        let mut out = Vec::new();
        while let Some(Ok(r)) = set.join_next().await {
            out.push(r);
        }
        out
    });
    // Per file: the highest P(yes), and the question that gave it.
    let mut files: BTreeMap<(String, String), (f64, String)> = BTreeMap::new();
    let (mut tokens, mut errors) = (0u64, 0usize);
    for (sha, path, r) in results {
        match r {
            Ok((yes, t)) => {
                tokens += t;
                let e = files.entry((sha, path)).or_insert((0.0, String::new()));
                for (q, p) in yes {
                    if p > e.0 {
                        *e = (p, q);
                    }
                }
            }
            Err(_) => errors += 1,
        }
    }
    let n = files.len();
    let at = |th: f64| files.values().filter(|(p, _)| *p >= th).count();
    println!("  files scored: {n}   errors: {errors}");
    for th in [WORTH_A_LOOK_AT, ESCALATE_AT] {
        println!(
            "  at {th}: {} files ({:.1}%)",
            at(th),
            100.0 * at(th) as f64 / n.max(1) as f64
        );
    }
    let mut by_q: BTreeMap<&str, usize> = BTreeMap::new();
    for (p, q) in files.values() {
        if *p >= ESCALATE_AT {
            *by_q.entry(q.as_str()).or_default() += 1;
        }
    }
    for (q, c) in &by_q {
        println!("    escalated by {q:<26} {c}");
    }
    println!(
        "  {tokens} input tokens (~${:.3})",
        tokens as f64 * 0.24 / 1e6
    );
    let rows: Vec<_> = files
        .iter()
        .map(|((sha, path), (p, q))| serde_json::json!({"merge": sha, "path": path, "score": p, "question": q}))
        .collect();
    let path = out_dir().join(format!("real-clef-{}.json", stamp()));
    std::fs::write(&path, serde_json::to_vec_pretty(&rows).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    println!("  per file: {}", path.display());
    Ok(())
}

// ── clef ────────────────────────────────────────────────────────────────────

struct ClefRun {
    id: String,
    vulnerable: bool,
    class: String,
    score: f64,
    calls: usize,
    tokens: u64,
    millis: u128,
    escalated_unsent: bool,
}

async fn ask(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    state: &str,
) -> Result<(serde_json::Value, u64), String> {
    for attempt in 0..5u32 {
        let response = client
            .post(url)
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(request_body(state))
            .send()
            .await;
        match response {
            Ok(r) if r.status().is_success() => {
                let v: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
                let tokens = v["result"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
                return Ok((v, tokens));
            }
            Ok(r)
                if (r.status().as_u16() == 429 || r.status().is_server_error()) && attempt < 4 =>
            {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
            Ok(r) => return Err(format!("HTTP {}", r.status())),
            Err(_) if attempt < 4 => tokio::time::sleep(Duration::from_secs(1 << attempt)).await,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("gave up after retries".to_string())
}

async fn run_case(
    case: Case,
    with_provenance: bool,
    strip: bool,
    client: reqwest::Client,
    url: Arc<String>,
    token: Arc<String>,
) -> Result<ClefRun, String> {
    let started = Instant::now();
    let prov = if with_provenance {
        case.provenance()
    } else {
        Provenance::default()
    };
    let findings = case.scan_local().findings;
    let map = build(parse_unified(case.diff.as_bytes()), &Limits::default());
    let (mut score, mut calls, mut tokens, mut unsent) = (0.0f64, 0, 0u64, false);
    for file in map.files.iter().filter(|f| f.skip.is_none()) {
        for i in 0..file.change.hunks.len() {
            let state = build_state(file, i, &prov, &findings, Some(&case.title), strip);
            if state.len() > MAX_STATE_CHARS {
                // Too large to send whole: escalates, never truncates.
                score = 1.0;
                unsent = true;
                continue;
            }
            let (v, t) = ask(&client, &url, &token, &state).await?;
            let answers = parse_answers(&v)?;
            calls += 1;
            tokens += t;
            score = answers.yes.values().copied().fold(score, f64::max);
        }
    }
    Ok(ClefRun {
        id: case.id,
        vulnerable: case.vulnerable,
        class: case.class,
        score,
        calls,
        tokens,
        millis: started.elapsed().as_millis(),
        escalated_unsent: unsent,
    })
}

fn clef(args: &[String]) -> Result<(), String> {
    let account = std::env::var("CLOUDFLARE_ACCOUNT_ID")
        .map_err(|_| "missing CLOUDFLARE_ACCOUNT_ID".to_string())?;
    let token = std::env::var("CLOUDFLARE_API_TOKEN")
        .map_err(|_| "missing CLOUDFLARE_API_TOKEN".to_string())?;
    let with_provenance = flag(args, "--provenance");
    let strip = flag(args, "--strip-comments");
    let with_adversarial = flag(args, "--adversarial");
    let concurrency: usize = value(args, "--concurrency")
        .and_then(|n| n.parse().ok())
        .unwrap_or(4);

    let mut cases = cases()?;
    if with_adversarial {
        let variants: Vec<Case> = cases
            .iter()
            .filter(|c| c.vulnerable)
            .flat_map(adversarial)
            .collect();
        cases.extend(variants);
    }
    let url = Arc::new(format!(
        "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef"
    ));
    let token = Arc::new(token);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let runs: Vec<ClefRun> = runtime.block_on(async {
        let client = reqwest::Client::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1)));
        let mut set = tokio::task::JoinSet::new();
        for case in cases {
            let (client, url, token, gate) =
                (client.clone(), url.clone(), token.clone(), gate.clone());
            set.spawn(async move {
                let _permit = gate.acquire_owned().await.map_err(|e| e.to_string())?;
                run_case(case, with_provenance, strip, client, url, token).await
            });
        }
        let mut runs = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(Ok(run)) => runs.push(run),
                Ok(Err(e)) => eprintln!("  a case failed: {e}"),
                Err(e) => eprintln!("  a case panicked: {e}"),
            }
        }
        runs
    });
    report(&runs, with_provenance, strip, with_adversarial)
}

fn report(
    runs: &[ClefRun],
    provenance: bool,
    strip: bool,
    adversarial: bool,
) -> Result<(), String> {
    let arm = format!(
        "clef{}{}{}",
        if provenance { "+provenance" } else { "" },
        if strip { "+strip" } else { "" },
        if adversarial { "+adversarial" } else { "" }
    );
    let originals: Vec<&ClefRun> = runs.iter().filter(|r| !r.id.contains('~')).collect();
    let variants: Vec<&ClefRun> = runs.iter().filter(|r| r.id.contains('~')).collect();
    let pos: Vec<f64> = originals
        .iter()
        .filter(|r| r.vulnerable)
        .map(|r| r.score)
        .collect();
    let neg: Vec<f64> = originals
        .iter()
        .filter(|r| !r.vulnerable)
        .map(|r| r.score)
        .collect();
    let at = |scores: &[f64], th: f64| scores.iter().filter(|s| **s >= th).count();
    println!(
        "{arm}: {} cases ({} vulnerable, {} safe)",
        originals.len(),
        pos.len(),
        neg.len()
    );
    for th in [WORTH_A_LOOK_AT, ESCALATE_AT] {
        println!(
            "  at {th}: caught {}/{}   false alarms {}/{}",
            at(&pos, th),
            pos.len(),
            at(&neg, th),
            neg.len()
        );
    }
    println!("  AUC {:.3}", auc(&pos, &neg));
    let rows: Vec<(String, bool)> = originals
        .iter()
        .filter(|r| r.vulnerable)
        .map(|r| (r.class.clone(), r.score >= ESCALATE_AT))
        .collect();
    for (class, (hit, n)) in by_class(&rows) {
        println!("    {class:<20} {hit}/{n}");
    }
    if !variants.is_empty() {
        let vpos: Vec<f64> = variants.iter().map(|r| r.score).collect();
        println!(
            "  adversarial variants caught at {ESCALATE_AT}: {}/{} (originals {}/{})",
            at(&vpos, ESCALATE_AT),
            vpos.len(),
            at(&pos, ESCALATE_AT),
            pos.len()
        );
        let mut by_kind: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        for r in &variants {
            let kind = r.id.rsplit('~').next().unwrap_or("?");
            let e = by_kind.entry(kind).or_default();
            e.1 += 1;
            e.0 += usize::from(r.score >= ESCALATE_AT);
        }
        for (kind, (hit, n)) in by_kind {
            println!("    {kind:<20} {hit}/{n}");
        }
    }
    let calls: usize = runs.iter().map(|r| r.calls).sum();
    let tokens: u64 = runs.iter().map(|r| r.tokens).sum();
    let unsent = runs.iter().filter(|r| r.escalated_unsent).count();
    let avg_ms = runs.iter().map(|r| r.millis).sum::<u128>() / runs.len().max(1) as u128;
    println!(
        "  {calls} calls, {tokens} input tokens (~${:.4}), avg {avg_ms} ms per case, {unsent} cases had an unsendable hunk",
        tokens as f64 * 0.24 / 1e6
    );
    let mut misses: Vec<&&ClefRun> = originals
        .iter()
        .filter(|r| r.vulnerable && r.score < ESCALATE_AT)
        .collect();
    misses.sort_by(|a, b| a.id.cmp(&b.id));
    for m in misses {
        println!("  missed {:<40} {:.2}", m.id, m.score);
    }
    let mut alarms: Vec<&&ClefRun> = originals
        .iter()
        .filter(|r| !r.vulnerable && r.score >= WORTH_A_LOOK_AT)
        .collect();
    alarms.sort_by(|a, b| a.id.cmp(&b.id));
    for a in alarms {
        println!("  alarm  {:<40} {:.2}", a.id, a.score);
    }
    let per_case: Vec<_> = runs
        .iter()
        .map(|r| serde_json::json!({"id": r.id, "vulnerable": r.vulnerable, "class": r.class, "score": r.score, "calls": r.calls, "tokens": r.tokens}))
        .collect();
    let path = out_dir().join(format!("{arm}-{}.json", stamp()));
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&per_case).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    println!("  per case: {}", path.display());
    Ok(())
}

// ── export ──────────────────────────────────────────────────────────────────

fn export(args: &[String]) -> Result<(), String> {
    let project = value(args, "--project").ok_or("missing --project")?;
    let out = value(args, "--out").ok_or("missing --out")?;
    let atlas_dir = Path::new(project).join(atlas_profile::dir_name());
    let store = atlas_checkpoint::Store::open_reader(&atlas_dir).map_err(|e| e.to_string())?;
    let workspace = store
        .binding()
        .map_err(|e| e.to_string())?
        .map(|b| b.workspace_id)
        .ok_or("the project has no capture binding")?;
    let rows: Vec<_> = store
        .scans_for_project(&workspace)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(checkpoint, scan)| {
            serde_json::json!({
                "checkpoint": checkpoint.id,
                "commit": checkpoint.commit_sha,
                "branch": checkpoint.branch,
                "scanner_version": scan.scanner_version,
                "status": scan.status,
                "level": scan.level,
                "blocking": scan.blocking,
                "result": serde_json::from_str::<serde_json::Value>(&scan.result_json).unwrap_or_default(),
                "label": serde_json::Value::Null,
            })
        })
        .collect();
    std::fs::write(out, serde_json::to_vec_pretty(&rows).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    println!("wrote {} scans to {out}", rows.len());
    Ok(())
}
