//! `atlas-evals` — the M0 CLI. Subcommands: `list`, `run`, `report`,
//! `harvest`. See `evals/README.md` for the workflow.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use atlas_evals::capture::HarnessCapture;
use atlas_evals::{harvest, report, results, runner, task};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const USAGE: &str = "\
atlas-evals — the M0 eval harness

USAGE:
  atlas-evals list    [--tasks DIR]
  atlas-evals run     --models a/b[,c/d…] [--suite NAME] [--runs N]
                      [--tasks DIR] [--repo DIR] [--out DIR]
                      [--max-cost-per-run $] [--max-cost-sweep $]
  atlas-evals report  --sweep ID [--baseline ID] [--runs-dir DIR]
  atlas-evals harvest [--claude DIR] [--cersei DIR] [--out DIR]

Models are provider-qualified (e.g. anthropic/claude-sonnet-4-5). Keys come
from the app's byok-keys.json, overridden by *_API_KEY env vars.
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (positional, flags) = match parse_args(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    let command = positional.first().map(String::as_str).unwrap_or("");
    let result = match command {
        "list" => cmd_list(&flags),
        "run" => cmd_run(&flags),
        "report" => cmd_report(&flags),
        "harvest" => cmd_harvest(&flags),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// `--flag value` pairs plus positional words. A flag without a value is an
/// error — there are no boolean flags in this CLI.
fn parse_args(args: &[String]) -> Result<(Vec<String>, BTreeMap<String, String>), String> {
    let mut positional = Vec::new();
    let mut flags = BTreeMap::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some(name) = a.strip_prefix("--") {
            let value = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
            flags.insert(name.to_string(), value.clone());
        } else {
            positional.push(a.clone());
        }
    }
    Ok((positional, flags))
}

fn repo_root(flags: &BTreeMap<String, String>) -> Result<PathBuf, String> {
    if let Some(r) = flags.get("repo") {
        return Ok(PathBuf::from(r));
    }
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("git rev-parse: {e}"))?;
    if !out.status.success() {
        return Err("not inside a git repository — pass --repo".into());
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}

fn cmd_list(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let repo = repo_root(flags)?;
    let tasks_dir = flags
        .get("tasks")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("evals/tasks"));
    let tasks = task::load_tasks(&tasks_dir)?;
    for t in &tasks {
        println!("{:<10} {:<40} timeout {:>5}s  turns {:?}", t.bucket, t.id, t.timeout_secs, t.max_turns);
    }
    println!("{} tasks", tasks.len());
    Ok(())
}

/// Env var → provider id, matching `atlas-cersei/src/provider.rs`.
const ENV_KEYS: &[(&str, &str)] = &[
    ("ANTHROPIC_API_KEY", "anthropic"),
    ("OPENAI_API_KEY", "openai"),
    ("GEMINI_API_KEY", "google"),
    ("GOOGLE_API_KEY", "google"),
    ("XAI_API_KEY", "xai"),
    ("DEEPSEEK_API_KEY", "deepseek"),
    ("MISTRAL_API_KEY", "mistral"),
    ("GROQ_API_KEY", "groq"),
    ("TOGETHER_API_KEY", "together"),
    ("FIREWORKS_API_KEY", "fireworks"),
    ("DEEPINFRA_API_KEY", "deepinfra"),
    ("CEREBRAS_API_KEY", "cerebras"),
    ("OPENROUTER_API_KEY", "openrouter"),
    ("PERPLEXITY_API_KEY", "perplexity"),
    ("COHERE_API_KEY", "cohere"),
];

/// The app's configured keys, overridden by env vars — a sweep works out of
/// the box on a machine where Atlas itself works.
fn collect_keys() -> BTreeMap<String, String> {
    let mut keys = BTreeMap::new();
    if let Some(config) = dirs::config_dir() {
        let path = config.join("dev.atlas.ide").join("byok-keys.json");
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(map) = doc.as_object() {
                    for (provider, v) in map {
                        if let Some(key) = v.get("key").and_then(|k| k.as_str()) {
                            keys.insert(provider.clone(), key.to_string());
                        }
                    }
                }
            }
        }
    }
    for (var, provider) in ENV_KEYS {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                keys.insert(provider.to_string(), v);
            }
        }
    }
    keys
}

#[derive(serde::Deserialize)]
struct SuiteFile {
    tasks: Vec<String>,
    #[serde(default)]
    runs: Option<u32>,
}

fn cmd_run(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let repo = repo_root(flags)?;
    let tasks_dir = flags
        .get("tasks")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("evals/tasks"));
    let out_dir = flags
        .get("out")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("evals/runs"));

    let models: Vec<String> = flags
        .get("models")
        .ok_or("--models is required")?
        .split(',')
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    if models.is_empty() {
        return Err("--models is empty".into());
    }

    let mut tasks = task::load_tasks(&tasks_dir)?;
    let mut runs_per_task: u32 = flags.get("runs").map(|r| r.parse().map_err(|e| format!("--runs: {e}"))).transpose()?.unwrap_or(1);
    let suite_name = flags.get("suite").cloned().unwrap_or_else(|| "all".into());
    if let Some(suite) = flags.get("suite") {
        let suite_path = repo.join("evals/suites").join(format!("{suite}.json"));
        let raw = std::fs::read_to_string(&suite_path)
            .map_err(|e| format!("read suite {}: {e}", suite_path.display()))?;
        let suite: SuiteFile = serde_json::from_str(&raw).map_err(|e| format!("parse suite: {e}"))?;
        if flags.get("runs").is_none() {
            if let Some(r) = suite.runs {
                runs_per_task = r;
            }
        }
        let mut missing = Vec::new();
        tasks.retain(|t| suite.tasks.contains(&t.id));
        for id in &suite.tasks {
            if !tasks.iter().any(|t| &t.id == id) {
                missing.push(id.clone());
            }
        }
        if !missing.is_empty() {
            return Err(format!("suite names unknown tasks: {}", missing.join(", ")));
        }
    }
    if tasks.is_empty() {
        return Err("no tasks selected".into());
    }

    let mut keys = collect_keys();
    // The local ollama daemon is keyless — give it a placeholder entry so
    // `ollama/<model>` works as the small-local canary with no setup.
    runner::ensure_keyless_entries(&mut keys);
    runner::check_model_keys(&models, &keys)?;

    let sweep_id = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S"),
        suite_name
    );
    let scratch = std::env::temp_dir().join("atlas-evals").join(&sweep_id);
    let cfg = runner::SweepConfig {
        sweep_id: sweep_id.clone(),
        tasks,
        models,
        runs_per_task,
        keys,
        repo_root: repo.clone(),
        out_dir: out_dir.clone(),
        scratch,
        max_cost_per_run: parse_cost(flags, "max-cost-per-run", 2.0)?,
        max_cost_sweep: parse_cost(flags, "max-cost-sweep", 25.0)?,
    };

    write_sweep_meta(&cfg, &repo)?;

    // The capture layer must be the process-global subscriber before any
    // turn runs; the fmt layer keeps provider errors visible on stderr.
    let capture = HarnessCapture::new();
    tracing_subscriber::registry()
        .with(capture.clone())
        .with({
            use tracing_subscriber::Layer;
            // Default: warnings only — a sweep's stderr is for run
            // outcomes, not per-event tracing. RUST_LOG opts into more.
            tracing_subscriber::fmt::layer().with_writer(std::io::stderr).with_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
            )
        })
        .init();

    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("tokio runtime: {e}"))?;
    let summary = rt.block_on(runner::run_sweep(&cfg, &capture))?;
    println!(
        "sweep {sweep_id}: {} runs, {} passed, {} ghosts, {} errors, ${:.2}{}",
        summary.runs,
        summary.passed,
        summary.ghosts,
        summary.errors,
        summary.total_cost,
        summary
            .stopped_early
            .as_deref()
            .map(|r| format!(" — stopped early: {r}"))
            .unwrap_or_default(),
    );
    println!("results: {}", out_dir.join(&sweep_id).join("results.jsonl").display());
    Ok(())
}

fn parse_cost(flags: &BTreeMap<String, String>, name: &str, default: f64) -> Result<f64, String> {
    flags
        .get(name)
        .map(|v| v.parse::<f64>().map_err(|e| format!("--{name}: {e}")))
        .transpose()
        .map(|v| v.unwrap_or(default))
}

fn write_sweep_meta(cfg: &runner::SweepConfig, repo: &Path) -> Result<(), String> {
    let rev = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let meta = serde_json::json!({
        "sweep_id": cfg.sweep_id,
        "repo_rev": rev,
        "models": cfg.models,
        "runs_per_task": cfg.runs_per_task,
        "tasks": cfg.tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
        "max_cost_per_run": cfg.max_cost_per_run,
        "max_cost_sweep": cfg.max_cost_sweep,
        // Env-gated tools change the agent's tool list between machines;
        // record the gate state so sweeps compare like with like.
        "env_tools": {
            "exa": std::env::var("EXA_API_KEY").is_ok(),
            "search": std::env::var("CERSEI_SEARCH_API_KEY").is_ok(),
        },
    });
    let dir = cfg.out_dir.join(&cfg.sweep_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write meta.json: {e}"))
}

fn cmd_report(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let repo = repo_root(flags)?;
    let runs_dir = flags
        .get("runs-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("evals/runs"));
    let sweep = flags.get("sweep").ok_or("--sweep is required")?;
    let (records, corrupt) = results::load(&runs_dir.join(sweep).join("results.jsonl"))?;
    if corrupt > 0 {
        eprintln!("warn: {corrupt} corrupt result lines skipped");
    }
    let baseline = flags
        .get("baseline")
        .map(|b| results::load(&runs_dir.join(b).join("results.jsonl")))
        .transpose()?;
    if let Some((_, c)) = &baseline {
        if *c > 0 {
            eprintln!("warn: {c} corrupt baseline lines skipped");
        }
    }
    print!("{}", report::render(&records, baseline.as_ref().map(|(r, _)| r.as_slice())));
    Ok(())
}

fn cmd_harvest(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let claude_root = flags.get("claude").map(PathBuf::from).unwrap_or_else(|| {
        dirs::home_dir().unwrap_or_default().join(".claude").join("projects")
    });
    let cersei_root = flags.get("cersei").map(PathBuf::from).unwrap_or_else(|| {
        dirs::config_dir().unwrap_or_default().join("dev.atlas.ide").join("cersei-sessions")
    });
    let out = flags.get("out").map(PathBuf::from).map(Ok).unwrap_or_else(|| {
        repo_root(flags).map(|r| r.join("evals/harvest"))
    })?;
    let summary = harvest::run(&claude_root, &cersei_root, &out)?;
    println!(
        "harvested {} sessions ({} failed), {} candidates",
        summary.sessions_parsed, summary.sessions_failed, summary.candidates
    );
    println!("  {}", summary.baseline_path.display());
    println!("  {}", summary.candidates_path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_parse_into_pairs_and_positionals() {
        let args: Vec<String> = ["run", "--models", "a/b,c/d", "--runs", "3"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (pos, flags) = parse_args(&args).unwrap();
        assert_eq!(pos, vec!["run"]);
        assert_eq!(flags["models"], "a/b,c/d");
        assert_eq!(flags["runs"], "3");
    }

    #[test]
    fn a_flag_without_a_value_is_an_error() {
        let args: Vec<String> = ["run", "--models"].iter().map(|s| s.to_string()).collect();
        assert!(parse_args(&args).is_err());
    }
}
