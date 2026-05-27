import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Auth0Provider } from '@auth0/auth0-react'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import './styles/app.css'

const domain = import.meta.env.VITE_AUTH0_DOMAIN
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID
const audience = import.meta.env.VITE_AUTH0_AUDIENCE

const root = ReactDOM.createRoot(document.getElementById('root'))

if (!domain || !clientId) {
  root.render(
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h2>Missing Auth0 config</h2>
      <p>Copy <code>.env.example</code> to <code>.env</code> and fill in your Auth0 values.</p>
    </div>
  )
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <Auth0Provider
          domain={domain}
          clientId={clientId}
          authorizationParams={{
            redirect_uri: window.location.origin,
            audience,
          }}
          cacheLocation="localstorage"
        >
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </Auth0Provider>
      </ErrorBoundary>
    </React.StrictMode>
  )
}
