import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { auth } from 'express-oauth2-jwt-bearer'
import { ManagementClient } from 'auth0'

const {
  AUTH0_DOMAIN,
  AUTH0_AUDIENCE,
  AUTH0_MGMT_CLIENT_ID,
  AUTH0_MGMT_CLIENT_SECRET,
  ALLOWED_ORIGINS = 'http://localhost:5173',
  TRUST_PROXY = '0',
  NODE_ENV = 'development',
  PORT = 3001,
} = process.env

const isProd = NODE_ENV === 'production'

if (!AUTH0_DOMAIN || !AUTH0_AUDIENCE || !AUTH0_MGMT_CLIENT_ID || !AUTH0_MGMT_CLIENT_SECRET) {
  console.error('Missing required env vars in server/.env')
  console.error('Need: AUTH0_DOMAIN, AUTH0_AUDIENCE, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET')
  process.exit(1)
}

const app = express()

// Behind a load balancer / reverse proxy (Heroku, Fly, Render, nginx) the
// real client IP arrives in X-Forwarded-For. Rate limiting needs that to be
// trusted to avoid being keyed off the proxy IP.
if (TRUST_PROXY !== '0') {
  app.set('trust proxy', Number(TRUST_PROXY) || TRUST_PROXY)
}

app.use(helmet())

const originAllowlist = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true) // same-origin / curl
      if (originAllowlist.includes(origin)) return cb(null, true)
      // Silently deny — browser will block the request without a CORS header.
      // We don't throw to avoid logging legitimate cross-origin probes as 5xx.
      return cb(null, false)
    },
    methods: ['GET', 'PUT', 'OPTIONS'],
    credentials: false,
    maxAge: 86400,
  })
)

app.use(express.json({ limit: '64kb' }))

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

const checkJwt = auth({
  audience: AUTH0_AUDIENCE,
  issuerBaseURL: `https://${AUTH0_DOMAIN}/`,
  tokenSigningAlg: 'RS256',
})

const mgmt = new ManagementClient({
  domain: AUTH0_DOMAIN,
  clientId: AUTH0_MGMT_CLIENT_ID,
  clientSecret: AUTH0_MGMT_CLIENT_SECRET,
})

function userIdFromReq(req) {
  return req.auth?.payload?.sub
}

const MAX_HISTORY = 30
const MAX_FAVORITES = 200

function sanitizeWordList(list, max) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const w of list) {
    if (typeof w !== 'string') continue
    const trimmed = w.trim().toLowerCase()
    if (!trimmed || trimmed.length > 64) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/user-data', apiLimiter, checkJwt, async (req, res, next) => {
  try {
    const userId = userIdFromReq(req)
    const user = await mgmt.users.get({ id: userId })
    const meta = user?.data?.user_metadata || {}
    res.json({
      history: Array.isArray(meta.history) ? meta.history : [],
      favorites: Array.isArray(meta.favorites) ? meta.favorites : [],
    })
  } catch (err) {
    next(err)
  }
})

app.put('/api/user-data', apiLimiter, checkJwt, async (req, res, next) => {
  try {
    const userId = userIdFromReq(req)
    const history = sanitizeWordList(req.body?.history, MAX_HISTORY)
    const favorites = sanitizeWordList(req.body?.favorites, MAX_FAVORITES)
    await mgmt.users.update(
      { id: userId },
      { user_metadata: { history, favorites } }
    )
    res.json({ history, favorites })
  } catch (err) {
    next(err)
  }
})

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' })
})

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500) {
    console.error('[api] %s %s ->', req.method, req.path, err)
  }
  const body = { error: status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'internal' }
  if (!isProd && status >= 500) body.detail = err.message
  res.status(status).json(body)
})

const server = app.listen(PORT, () => {
  console.log(`open-dictionary API listening on http://localhost:${PORT} (${NODE_ENV})`)
})

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`)
  server.close((err) => {
    if (err) {
      console.error('Error during shutdown', err)
      process.exit(1)
    }
    process.exit(0)
  })
  setTimeout(() => {
    console.error('Forcing shutdown after timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
