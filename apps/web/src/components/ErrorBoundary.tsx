import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  /**
   * When this changes, a caught error is cleared and the children render
   * again. A board passes its data timestamp, so a card that crashed on one
   * poll gets a fresh chance on the next.
   */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  failed: boolean;
  resetKey: unknown;
}

/**
 * §42 — a render failure stays inside the region that failed. Each team card
 * has its own boundary, so one malformed card cannot blank a board (plan §9).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Render failure contained by ErrorBoundary', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
