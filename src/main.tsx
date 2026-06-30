import { StrictMode, useCallback, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, useNavigate } from 'react-router-dom'
import { Auth0Provider, type AppState } from '@auth0/auth0-react'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/app.css'

const domain = import.meta.env.VITE_AUTH0_DOMAIN
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID
const audience = import.meta.env.VITE_AUTH0_AUDIENCE

interface ProviderProps {
  children: ReactNode
}

/**
 * Auth0Provider with a router-aware redirect callback: after login the SDK
 * calls onRedirectCallback, which uses React Router's navigate() to render
 * `appState.returnTo`. (The default callback only does history.replaceState,
 * which updates the URL but doesn't make React Router render the route.)
 */
function Auth0ProviderWithNavigate({ children }: ProviderProps) {
  const navigate = useNavigate()
  const onRedirectCallback = useCallback(
    (appState?: AppState) => {
      navigate(appState?.returnTo ?? window.location.pathname)
    },
    [navigate]
  )
  return (
    <Auth0Provider
      domain={domain!}
      clientId={clientId!}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
      }}
      cacheLocation="localstorage"
      onRedirectCallback={onRedirectCallback}
    >
      {children}
    </Auth0Provider>
  )
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
const root = createRoot(rootEl)

const missingConfig: ReactElement = (
  <div style={{ padding: 24, fontFamily: 'system-ui' }}>
    <h2>Missing Auth0 config</h2>
    <p>
      Copy <code>.env.example</code> to <code>.env</code> and fill in your Auth0 values.
    </p>
  </div>
)

if (!domain || !clientId) {
  root.render(missingConfig)
} else {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <Auth0ProviderWithNavigate>
            <App />
          </Auth0ProviderWithNavigate>
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>
  )
}
