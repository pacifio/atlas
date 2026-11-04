import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AgentMetaProvider } from "./features/agents/components/agent-meta-provider";
import { CrashPreviewTrigger } from "./features/telemetry/crash-screen";
import { TelemetryErrorBoundary } from "./features/telemetry/error-boundary";
import { installGlobalErrorHandlers } from "./features/telemetry/error-handlers";
import { initTelemetry } from "./features/telemetry/posthog-client";
import { markPlatform } from "./lib/platform";
import "./styles/globals.css";

// Opt-in crash reporting. Handlers are installed unconditionally (cheap); they
// only transmit once the user has opted in and a PostHog key resolved in Rust.
installGlobalErrorHandlers();
void initTelemetry();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 min before refetch
      gcTime: 30 * 60 * 1000, // 30 min cache lifetime
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

markPlatform();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TelemetryErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AgentMetaProvider>
          <CrashPreviewTrigger />
          <App />
        </AgentMetaProvider>
      </QueryClientProvider>
    </TelemetryErrorBoundary>
  </React.StrictMode>,
);
