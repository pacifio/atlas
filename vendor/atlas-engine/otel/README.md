<!-- Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md. -->

# atlas-engine-otel

`atlas-engine-otel` is the OpenTelemetry integration crate for Atlas Agent. It provides:

- Provider wiring for log/trace/metric exporters (`atlas_engine_otel::OtelProvider`
  and `atlas_engine_otel::provider`).
- Session-scoped business event emission via `atlas_engine_otel::SessionTelemetry`.
- Low-level metrics APIs via `atlas_engine_otel::metrics`.
- Trace-context helpers via `atlas_engine_otel::trace_context` and crate-root re-exports.

## Tracing and logs

Create an OTEL provider from `OtelSettings`. The provider also configures
metrics (when enabled), then attach its layers to your `tracing_subscriber`
registry:

```rust
use atlas_engine_otel::config::OtelExporter;
use atlas_engine_otel::config::OtelHttpProtocol;
use atlas_engine_otel::config::OtelSettings;
use atlas_engine_otel::OtelProvider;
use tracing_subscriber::prelude::*;

let settings = OtelSettings {
    environment: "dev".to_string(),
    service_name: "atlas-engine-cli".to_string(),
    service_version: env!("CARGO_PKG_VERSION").to_string(),
    atlas_agent_home: std::path::PathBuf::from("/tmp"),
    exporter: OtelExporter::OtlpHttp {
        endpoint: "https://otlp.example.com".to_string(),
        headers: std::collections::HashMap::new(),
        protocol: OtelHttpProtocol::Binary,
        tls: None,
    },
    trace_exporter: OtelExporter::OtlpHttp {
        endpoint: "https://otlp.example.com".to_string(),
        headers: std::collections::HashMap::new(),
        protocol: OtelHttpProtocol::Binary,
        tls: None,
    },
    metrics_exporter: OtelExporter::None,
    span_attributes: std::collections::BTreeMap::new(),
    tracestate: std::collections::BTreeMap::new(),
};

if let Some(provider) = OtelProvider::from(&settings)? {
    let registry = tracing_subscriber::registry()
        .with(provider.logger_layer())
        .with(provider.tracing_layer());
    registry.init();
}
```

Configured span attributes and W3C tracestate member fields are applied to
exported trace spans and propagated trace context:

```toml
[otel.span_attributes]
"example.trace_attr" = "enabled"

[otel.tracestate.example]
alpha = "one"
beta = "two"
```

Configured tracestate members and encoded values must be valid W3C tracestate.
Each nested table is encoded as semicolon-separated `key:value` fields inside
that member. If propagated trace context already has the named member, Atlas Agent
upserts configured fields and preserves other fields in that member. This
config shape does not support setting opaque tracestate member values. Invalid
trace metadata entries are ignored during config load and reported as startup
warnings.

## SessionTelemetry (events)

`SessionTelemetry` adds consistent metadata to tracing events and helps record
Atlas Agent-specific session events. Rich session/business events should go through
`SessionTelemetry`; subsystem-owned audit events can stay with the owning subsystem.

```rust
use atlas_engine_otel::SessionTelemetry;

let manager = SessionTelemetry::new(
    conversation_id,
    model,
    slug,
    account_id,
    account_email,
    auth_mode,
    originator,
    log_user_prompts,
    terminal_type,
    session_source,
);

manager.user_prompt(&prompt_items);
```

## Metrics (OTLP or in-memory)

Modes:

- OTLP: exports metrics via the OpenTelemetry OTLP exporter (HTTP or gRPC).
- In-memory: records via `opentelemetry_sdk::metrics::InMemoryMetricExporter` for tests/assertions; call `shutdown()` to flush.

> **Modified from the original.** `OtelExporter::Statsig` — a shorthand exporting to a
> hardcoded ingestion endpoint with a hardcoded client key, and the default for
> metrics — was removed in this fork (#43, spec D2). Metrics export nowhere unless
> you configure an endpoint yourself.

OTLP/HTTP JSON example:

```rust
use atlas_engine_otel::config::{OtelExporter, OtelHttpProtocol};

let metrics = MetricsClient::new(MetricsConfig::otlp(
    "dev",
    "atlas-engine-cli",
    env!("CARGO_PKG_VERSION"),
    OtelExporter::OtlpHttp {
        endpoint: std::env::var("OTLP_ENDPOINT")?,
        headers: std::collections::HashMap::from([(
            "authorization".to_string(),
            std::env::var("OTLP_API_KEY")?,
        )]),
        protocol: OtelHttpProtocol::Json,
        tls: None,
    },
))?;

metrics.counter("atlas_agent.session_started", 1, &[("source", "tui")])?;
metrics.histogram("atlas_agent.request_latency", 83, &[("route", "chat")])?;
```

In-memory (tests):

```rust
let exporter = InMemoryMetricExporter::default();
let metrics = MetricsClient::new(MetricsConfig::in_memory(
    "test",
    "atlas-engine-cli",
    env!("CARGO_PKG_VERSION"),
    exporter.clone(),
))?;
metrics.counter("atlas_agent.turns", 1, &[("model", "gpt-5.1")])?;
metrics.shutdown()?; // flushes in-memory exporter
```

## Trace context

Trace propagation helpers remain separate from the session event emitter:

```rust
use atlas_engine_otel::current_span_w3c_trace_context;
use atlas_engine_otel::set_parent_from_w3c_trace_context;
```

## Shutdown

- `OtelProvider::shutdown()` stops the OTEL exporter.
- `SessionTelemetry::shutdown_metrics()` flushes and shuts down the metrics provider.

Both are optional because drop performs best-effort shutdown, but calling them
explicitly gives deterministic flushing (or a shutdown error if flushing does
not complete in time).
