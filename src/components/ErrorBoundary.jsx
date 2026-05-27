import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('Unhandled UI error', error, info)
  }

  handleReload = () => {
    this.setState({ hasError: false })
    window.location.assign('/')
  }

  render() {
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
