/**
 * Top-level React error boundary. Wraps `<App/>` in `main.tsx` so a render
 * crash reports to telemetry (gated on consent) and shows a minimal recover
 * screen instead of a blank window. There was no error boundary before this.
 */
import React from "react";

import { CrashScreen } from "./crash-screen";
import { captureClientError } from "./posthog-client";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: unknown;
}

export class TelemetryErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    captureClientError(error, {
      type: "react_error_boundary",
      component_stack: info.componentStack?.slice(0, 2000),
    });
  }

  private handleReload = (): void => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return <CrashScreen error={this.state.error} onReload={this.handleReload} />;
  }
}
