/**
 * Top-level React error boundary. Wraps `<App/>` in `main.tsx` so a render
 * crash reports to telemetry (gated on consent) and shows a minimal recover
 * screen instead of a blank window. There was no error boundary before this.
 */
import React from "react";

import { captureClientError } from "./posthog-client";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export class TelemetryErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    captureClientError(error, {
      type: "react_error_boundary",
      component_stack: info.componentStack?.slice(0, 2000),
    });
  }

  private handleReload = (): void => {
    this.setState({ hasError: false });
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          color: "#fff",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          WebkitUserSelect: "none",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 8px" }}>
            Atlas hit an unexpected error
          </h1>
          <p
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              opacity: 0.55,
              margin: "0 0 16px",
            }}
          >
            The interface crashed. Reloading usually fixes it — your work in progress is preserved
            on disk.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              height: 30,
              padding: "0 14px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload Atlas
          </button>
        </div>
      </div>
    );
  }
}
