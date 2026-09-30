import { Component, type ReactNode } from 'react'

/**
 * Catches render errors in a part of the page (e.g. the detail panel) so the
 * rest of the app keeps working. Remount it with a new `key` to reset.
 */
export class ErrorBoundary extends Component<
  { fallback: (error: Error) => ReactNode; children: ReactNode },
  { error?: Error }
> {
  override state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children
  }
}
