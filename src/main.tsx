import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { TelemetryErrorBoundary } from "./features/telemetry/error-boundary";
import { installGlobalErrorHandlers } from "./features/telemetry/error-handlers";
import { initTelemetry } from "./features/telemetry/posthog-client";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TelemetryErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </TelemetryErrorBoundary>
  </React.StrictMode>,
);
