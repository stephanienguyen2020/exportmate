import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  // Shown instead of the crashed view; defaults to a reload panel.
  fallback?: ReactNode;
  // A new value (e.g. the route) clears the error, so navigating away recovers.
  resetKey?: string;
};

// Keeps one broken view from blanking the whole page.
export default class ErrorBoundary extends Component<
  Props,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("View crashed:", error, info.componentStack);
  }
  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <section className="panel crash-panel" role="alert">
        <h2>Something went wrong on this page.</h2>
        <p>Reload to try again. Your saved data is not affected.</p>
        <button className="btn" type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </section>
    );
  }
}
