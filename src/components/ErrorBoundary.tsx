import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info)
  }

  handleReload = (): void => {
    this.setState({ hasError: false })
    window.location.assign('/')
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="state-msg state-error" role="alert">
        <h2>Something went wrong</h2>
        <p>The page hit an unexpected error. Try going back to the home page.</p>
        <button className="btn btn-primary" type="button" onClick={this.handleReload}>
          Go home
        </button>
      </div>
    )
  }
}
