//! Tool tiers and model capabilities (tool spec D13).
//!
//! One registry, selected by tier. A long visible tool list degrades tool
//! selection, and that harms weaker models most — so a frontier model gets the
//! short shell-first set and a mid-tier model gets explicit file tools rather
//! than being required to compose shell pipelines correctly.
//!
//! **Which model gets which tier is a measurement, not an assumption**, and
//! that measurement is the BYOK evaluation matrix in the harness spec, which
//! does not exist yet. Until it does the default is
//! [`ToolTier::Structured`]: over-provisioning tools degrades gracefully and
//! under-provisioning does not.

/// How many tools the model is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolTier {
    /// Shell, terminal, patch-apply, and the non-file tools. The model composes
    /// its own file operations.
    ShellFirst,
    /// The above plus explicit Read / Edit / List / Grep / Glob / Write /
    /// MultiEdit. The default, and the safe choice for anything unmeasured.
    #[default]
    Structured,
}

impl ToolTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ShellFirst => "shell-first",
            Self::Structured => "structured",
        }
    }

    pub fn includes_file_tools(self) -> bool {
        matches!(self, Self::Structured)
    }
}

/// What the selected model can accept. Deliberately a handful of flags rather
/// than a per-model matrix: a large capability table is how the previous
/// attempt produced dead code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelCapabilities {
    /// The model accepts image input. Gates `ImageView` out of the registry
    /// entirely, so an incapable model fails at selection time rather than
    /// three turns into a debugging session.
    pub accepts_images: bool,
}

impl Default for ModelCapabilities {
    fn default() -> Self {
        // Conservative: a model wrongly given `ImageView` fails its whole turn
        // when the provider rejects the request, whereas a model wrongly denied
        // it simply asks the user to describe the picture.
        Self {
            accepts_images: false,
        }
    }
}

impl ModelCapabilities {
    /// Infer capabilities from a model identifier.
    ///
    /// Family prefixes rather than exact ids, so a point release does not need
    /// a code change. Anything unrecognised gets the conservative default.
    pub fn for_model(model: &str) -> Self {
        let m = model.to_ascii_lowercase();
        // Strip a `provider/` prefix, which OpenAI-compatible gateways add.
        let m = m.rsplit('/').next().unwrap_or(&m);
        let accepts_images = [
            "claude-",
            "gpt-4o",
            "gpt-4.1",
            "gpt-4-turbo",
            "gpt-5",
            "o3",
            "o4",
            "gemini-",
            "pixtral",
            "llava",
            "qwen2-vl",
            "qwen2.5-vl",
            "llama-3.2-11b",
            "llama-3.2-90b",
        ]
        .iter()
        .any(|family| m.starts_with(family) || m.contains(family));
        Self { accepts_images }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_tier_is_the_forgiving_one() {
        assert_eq!(ToolTier::default(), ToolTier::Structured);
        assert!(ToolTier::default().includes_file_tools());
    }

    #[test]
    fn known_multimodal_families_accept_images() {
        for model in [
            "claude-opus-4-20250514",
            "anthropic/claude-sonnet-4",
            "gpt-4o-mini",
            "gemini-2.5-pro",
            "pixtral-large-latest",
        ] {
            assert!(
                ModelCapabilities::for_model(model).accepts_images,
                "{model} should accept images"
            );
        }
    }

    #[test]
    fn an_unknown_model_does_not_get_the_image_tool() {
        // The conservative direction: asking the user to describe a screenshot
        // beats failing the turn at the provider.
        for model in ["some-new-local-model", "deepseek-coder-v2", ""] {
            assert!(!ModelCapabilities::for_model(model).accepts_images, "{model}");
        }
    }
}
