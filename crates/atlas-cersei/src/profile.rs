//! M2 — `ModelProfile`: the per-model adaptation keystone.
//!
//! One struct, resolved per turn from `(provider, model)`, that every
//! adaptation decision hangs off: context window (so small models compact
//! instead of dying by overflow), tool tier (ShellFirst becomes selectable
//! for the first time), thinking style (budget vs effort vs none), prompt
//! variant, parallel-call appetite, and edit mode.
//!
//! Sources, in order:
//! 1. the vendored provider registry (exact model id → real context
//!    window), then
//! 2. a small ordered family table (prefix/substring on the model id), then
//! 3. a conservative unknown-model profile: small window, no parallel
//!    calls, shell-first tools, terse prompt.
//!
//! Static + explicit only — no runtime probing. Observed adjustment
//! (demoting a tier mid-session off edit-failure counters) waits for eval
//! data.

use crate::tools::ToolTier;

/// How the model expresses extended thinking, which decides how a user's
/// effort level reaches the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingSupport {
    /// No usable thinking control — the effort setting is ignored.
    None,
    /// Token budget (`thinking_budget`): Anthropic's `thinking.budget_tokens`
    /// and Gemini's `thinkingConfig.thinkingBudget` both read it.
    Budget,
    /// Effort level string (`reasoning_effort`): OpenAI o-series / gpt-5.
    Effort,
}

/// Which editing surface the toolset exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditMode {
    /// The 10-strategy replace ladder behind the structured Edit tool.
    Replace,
    /// The shell-first tier's single patch tool.
    ApplyPatch,
    /// Line-addressed edits with a whole-file tag (M6) — the weak-model
    /// play: the model points at lines instead of reproducing bytes.
    Hashline,
}

/// Which system prompt the session gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptVariant {
    /// The full 13-section prompt (`ATLAS_PROMPT`).
    Full,
    /// The short prose variant for small profiles, where a long prompt
    /// actively hurts.
    Terse,
}

/// The resolved profile. See the module doc for sources and precedence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelProfile {
    pub accepts_images: bool,
    pub context_window: u64,
    /// The compaction trigger fraction — smaller profiles compact earlier
    /// (the strictness ladder's "earlier compaction" rung).
    pub compact_threshold: f64,
    pub parallel_tools: bool,
    pub thinking: ThinkingSupport,
    pub tool_tier: ToolTier,
    pub edit_mode: EditMode,
    pub prompt_variant: PromptVariant,
}

/// One family row: first matching needle wins, in table order.
struct Family {
    needles: &'static [&'static str],
    context_window: u64,
    parallel_tools: bool,
    thinking: ThinkingSupport,
    vision: bool,
}

/// Ordered family table. Windows are the family floor — an exact registry
/// hit overrides them. Needles match on the lowercased model id with any
/// `provider/` prefix stripped.
const FAMILIES: &[Family] = &[
    Family {
        needles: &["claude-", "claude "],
        context_window: 200_000,
        parallel_tools: true,
        thinking: ThinkingSupport::Budget,
        vision: true,
    },
    Family {
        needles: &["gpt-5"],
        context_window: 400_000,
        parallel_tools: true,
        thinking: ThinkingSupport::Effort,
        vision: true,
    },
    // The o-series: reasoning like gpt-5, but a 200k window, not gpt-5's
    // 400k. It borrowed the gpt-5 row for its thinking style and silently
    // took the window with it, which made long sessions compact far too late
    // and die at the provider instead. Segment-anchored in `family_for` (an
    // `o3` substring would swallow ids like "llama-o3-tuned").
    Family {
        needles: &["__o-series__"],
        context_window: 200_000,
        parallel_tools: true,
        thinking: ThinkingSupport::Effort,
        vision: true,
    },
    Family {
        needles: &["gpt-4o", "gpt-4.1", "gpt-4-turbo"],
        context_window: 128_000,
        parallel_tools: true,
        thinking: ThinkingSupport::None,
        vision: true,
    },
    Family {
        needles: &["gemini-", "gemini "],
        context_window: 1_000_000,
        parallel_tools: true,
        thinking: ThinkingSupport::Budget,
        vision: true,
    },
    Family {
        needles: &["grok"],
        context_window: 256_000,
        parallel_tools: true,
        thinking: ThinkingSupport::None,
        vision: false,
    },
    Family {
        needles: &["qwen"],
        context_window: 131_072,
        parallel_tools: true,
        thinking: ThinkingSupport::None,
        vision: false,
    },
    Family {
        needles: &["deepseek"],
        context_window: 65_536,
        parallel_tools: true,
        thinking: ThinkingSupport::None,
        vision: false,
    },
    Family {
        needles: &["kimi", "moonshot"],
        context_window: 131_072,
        parallel_tools: true,
        thinking: ThinkingSupport::None,
        vision: false,
    },
    Family {
        needles: &["mistral", "mixtral", "codestral", "devstral"],
        context_window: 131_072,
        parallel_tools: true,
        thinking: ThinkingSupport::None,
        vision: false,
    },
    Family {
        needles: &["command"],
        context_window: 256_000,
        parallel_tools: true,
        thinking: ThinkingSupport::None,
        vision: false,
    },
    Family {
        needles: &["sonar"],
        context_window: 127_000,
        parallel_tools: false,
        thinking: ThinkingSupport::None,
        vision: false,
    },
    Family {
        needles: &["llama"],
        context_window: 131_072,
        parallel_tools: false,
        thinking: ThinkingSupport::None,
        vision: false,
    },
];

/// The unknown-model floor: assume little, degrade to the shell-first
/// surface, and compact early. The floor is the status quo for a model
/// nobody has profiled — never a crash, never an overflow.
const CONSERVATIVE: ModelProfile = ModelProfile {
    accepts_images: false,
    context_window: 32_768,
    compact_threshold: 0.85,
    parallel_tools: false,
    thinking: ThinkingSupport::None,
    tool_tier: ToolTier::ShellFirst,
    edit_mode: EditMode::ApplyPatch,
    prompt_variant: PromptVariant::Terse,
};

impl ModelProfile {
    /// Resolve the profile for a session's `(provider, model)`.
    pub fn resolve(provider: &str, model: &str) -> ModelProfile {
        let normalized = normalize(model);

        // Local daemons serve trimmed contexts and small weights whatever
        // the family name says — the whole small-local tier gets the
        // conservative shape, with the family's vision bit kept.
        if provider.eq_ignore_ascii_case("ollama") {
            return ModelProfile {
                accepts_images: family_for(&normalized).is_some_and(|f| f.vision),
                ..CONSERVATIVE
            };
        }

        let Some(family) = family_for(&normalized) else {
            return CONSERVATIVE;
        };

        let context_window = registry_window(provider, model).unwrap_or(family.context_window);
        let edit_mode = if hashline_trial(&normalized) {
            EditMode::Hashline
        } else {
            EditMode::Replace
        };
        ModelProfile {
            // The tiers.rs table knows model-specific vision ids (pixtral,
            // llava, qwen-vl, llama-3.2 vision sizes) the family rows don't.
            accepts_images: family.vision
                || crate::tools::ModelCapabilities::for_model(model).accepts_images,
            context_window,
            compact_threshold: 0.90,
            parallel_tools: family.parallel_tools,
            thinking: family.thinking,
            tool_tier: ToolTier::Structured,
            edit_mode,
            prompt_variant: PromptVariant::Full,
        }
    }
}

/// The hashline trial set (M6): the model classes oh-my-pi measured wins
/// on — Grok Code Fast and the Gemini Flash tier. Its own exclusion table
/// demotes kimi/deepseek-class back to replace, respected by omission.
/// Finer than the family table on purpose (gemini-pro keeps the ladder
/// while gemini-flash trials hashline); the eventual sweep re-reads this.
fn hashline_trial(normalized: &str) -> bool {
    normalized.contains("grok")
        || (normalized.contains("gemini") && normalized.contains("flash"))
}

fn normalize(model: &str) -> String {
    let m = model.to_ascii_lowercase();
    // Ids can be namespaced ("Qwen/Qwen3-Coder-480B", "openrouter/..."):
    // match the last path segment.
    m.rsplit('/').next().unwrap_or(&m).to_string()
}

fn family_for(normalized: &str) -> Option<&'static Family> {
    // o3/o4: segment-anchored so "llama-o3-tuned" doesn't match.
    if normalized == "o3"
        || normalized == "o4"
        || normalized.starts_with("o3-")
        || normalized.starts_with("o4-")
    {
        return FAMILIES.iter().find(|f| f.needles.contains(&"__o-series__"));
    }
    FAMILIES
        .iter()
        .find(|f| f.needles.iter().any(|n| normalized.contains(n)))
}

/// Exact-id context window from the vendored provider registry, when the
/// provider and model are both known there.
fn registry_window(provider: &str, model: &str) -> Option<u64> {
    cersei::provider::registry::lookup(provider)
        .and_then(|p| p.models.iter().find(|m| m.id == model))
        .map(|m| m.context_window)
}

/// The terse system prompt for small profiles. Same voice and rules as
/// `ATLAS_PROMPT`, cut to what a small model can hold: who it is, how to
/// use tools one at a time, how to change code carefully, and when to stop.
/// Kept under its own byte budget by a test.
pub const ATLAS_PROMPT_TERSE: &str = r#"You are Atlas Agent, a coding agent working inside the Atlas IDE. You act on a real workspace: read files, run commands, and make changes when the user asks for them.

<using_tools>
Use one tool call at a time and read its result before the next. Prefer reading a file before editing it, and prefer small precise changes over rewrites. If a command or edit fails, read the error and adjust; do not repeat the same call unchanged.
</using_tools>

<changing_code>
Make the smallest change that does the job, matching the style of the surrounding code. After changing code, run the project's tests or build if one is available and report what happened. Never claim a change works without checking.
</changing_code>

<care>
Be careful with destructive commands: do not delete, overwrite, or force-push unless the user asked for exactly that. Never send secrets, keys, or private code anywhere outside the workspace.
</care>

<response_style>
Answer in short plain prose. Lead with what happened or what you found, then any detail the user needs. When the task is done, stop; do not pad the answer or invent follow-up work.
</response_style>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontier_families_get_full_structured_profiles() {
        let p = ModelProfile::resolve("anthropic", "claude-sonnet-4-6");
        assert_eq!(p.tool_tier, ToolTier::Structured);
        assert_eq!(p.thinking, ThinkingSupport::Budget);
        assert_eq!(p.prompt_variant, PromptVariant::Full);
        assert_eq!(p.edit_mode, EditMode::Replace);
        assert!(p.accepts_images);
        assert!(p.parallel_tools);
        assert!(p.context_window >= 200_000);

        let p = ModelProfile::resolve("openai", "gpt-5.1");
        assert_eq!(p.thinking, ThinkingSupport::Effort);

        let p = ModelProfile::resolve("google", "gemini-3.1-pro-preview");
        assert_eq!(p.thinking, ThinkingSupport::Budget);
        assert!(p.context_window >= 1_000_000);
    }

    #[test]
    fn an_unknown_model_gets_the_conservative_floor() {
        let p = ModelProfile::resolve("together", "totally-novel-model-9000");
        assert_eq!(p, CONSERVATIVE);
        assert_eq!(p.tool_tier, ToolTier::ShellFirst);
        assert_eq!(p.prompt_variant, PromptVariant::Terse);
        assert!(!p.parallel_tools);
        assert_eq!(p.context_window, 32_768);
    }

    #[test]
    fn ollama_is_the_small_local_tier_regardless_of_family_name() {
        let p = ModelProfile::resolve("ollama", "qwen3-coder");
        assert_eq!(p.tool_tier, ToolTier::ShellFirst);
        assert_eq!(p.prompt_variant, PromptVariant::Terse);
        assert_eq!(p.context_window, 32_768);
        assert_eq!(p.thinking, ThinkingSupport::None);
    }

    #[test]
    fn namespaced_ids_match_on_the_last_segment() {
        let p = ModelProfile::resolve("together", "Qwen/Qwen3-Coder-480B-A35B-Instruct");
        assert_eq!(p.tool_tier, ToolTier::Structured);
        assert_eq!(p.context_window, 131_072);
    }

    #[test]
    fn the_o_series_window_is_not_the_gpt_5_window() {
        // o3/o4 were routed to the gpt-5 family row to borrow its Effort
        // thinking, and inherited its 400k context window with it. The
        // vendored registry says o3 is 200,000 — and the exact-id override
        // only fires for the three ids listed there under provider "openai",
        // so o3-mini, o4*, and anything reached through a gateway id kept the
        // 400k figure.
        //
        // `context_window` drives compaction. At 400k with a 0.90 threshold
        // the first compaction is attempted around 360k — long past where the
        // real window ends — so a long session dies on a provider
        // context-length 400 (which retry.rs classifies fatal) instead of
        // compacting. Which is the failure ModelProfile exists to remove.
        for model in ["o3-mini", "o4", "o4-mini", "o3-deep-research"] {
            let p = ModelProfile::resolve("openai", model);
            assert_eq!(
                p.context_window, 200_000,
                "{model} must not inherit the gpt-5 window"
            );
            assert_eq!(p.thinking, ThinkingSupport::Effort, "{model} still reasons");
        }
        // Through a gateway provider id, where the registry override cannot help.
        assert_eq!(
            ModelProfile::resolve("openrouter", "o4-mini").context_window,
            200_000
        );
        // gpt-5 itself keeps its own window.
        assert_eq!(ModelProfile::resolve("openai", "gpt-5").context_window, 400_000);
    }

    #[test]
    fn o_series_is_segment_anchored_like_tiers_rs() {
        assert_eq!(
            ModelProfile::resolve("openai", "o3-mini").thinking,
            ThinkingSupport::Effort
        );
        // A model that merely contains "o3" is not the o-series.
        assert_eq!(
            ModelProfile::resolve("x", "llama-o3-tuned").thinking,
            ThinkingSupport::None
        );
    }

    #[test]
    fn small_profiles_compact_earlier_than_families() {
        assert!(
            ModelProfile::resolve("together", "unknown-model").compact_threshold
                < ModelProfile::resolve("anthropic", "claude-sonnet-4-6").compact_threshold
        );
    }

    #[test]
    fn the_hashline_trial_set_matches_omp_evidence() {
        // Wins were measured on Grok-class and Gemini-Flash-class models;
        // the exclusion table demotes kimi/deepseek back to replace.
        assert_eq!(
            ModelProfile::resolve("xai", "grok-code-fast-1").edit_mode,
            EditMode::Hashline
        );
        assert_eq!(
            ModelProfile::resolve("google", "gemini-2.5-flash").edit_mode,
            EditMode::Hashline
        );
        assert_eq!(
            ModelProfile::resolve("google", "gemini-3.1-pro-preview").edit_mode,
            EditMode::Replace,
            "non-flash gemini keeps the ladder"
        );
        assert_eq!(
            ModelProfile::resolve("anthropic", "claude-sonnet-4-6").edit_mode,
            EditMode::Replace
        );
        assert_eq!(
            ModelProfile::resolve("groq", "kimi-k2-instruct").edit_mode,
            EditMode::Replace,
            "omp's exclusion table demotes kimi"
        );
    }

    #[test]
    fn a_registry_exact_hit_overrides_the_family_window() {
        // Pick a real registry row so the test tracks the vendored table.
        let entry = cersei::provider::registry::lookup("anthropic").expect("registry has anthropic");
        let model = &entry.models[0];
        let p = ModelProfile::resolve("anthropic", model.id);
        assert_eq!(p.context_window, model.context_window);
    }

    #[test]
    fn the_terse_prompt_stays_small_and_honest() {
        // Budget: the terse variant exists because long prompts hurt small
        // models — if it creeps toward the full prompt's 9.2k, it has
        // stopped being terse.
        assert!(
            ATLAS_PROMPT_TERSE.len() <= 2_600,
            "terse prompt is {} bytes",
            ATLAS_PROMPT_TERSE.len()
        );
        // Same honesty rules as the full prompt: never name tools that
        // don't exist, keep prose (no bullet scaffolding).
        for banned in ["LSP", "background mode", ".claude/commands"] {
            assert!(!ATLAS_PROMPT_TERSE.contains(banned), "claims {banned}");
        }
        let bullets = ATLAS_PROMPT_TERSE
            .lines()
            .filter(|l| l.trim_start().starts_with('-') || l.trim_start().starts_with('*'))
            .count();
        assert_eq!(bullets, 0, "terse prompt must be prose");
        // Sections open and close.
        for tag in ["using_tools", "changing_code", "care", "response_style"] {
            assert!(ATLAS_PROMPT_TERSE.contains(&format!("<{tag}>")));
            assert!(ATLAS_PROMPT_TERSE.contains(&format!("</{tag}>")));
        }
    }
}
