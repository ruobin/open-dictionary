# To-Do: Geo / IP Load Balancing Implementation

Derived from `docs/design-geo-load-balancing.md` (incl. §14 review notes).
Phases match §10; each phase is independently reversible.

## Phase 0 — Provision & mesh

- [ ] Provision EU and US VPS (same OS/spec class as SG)
- [ ] Install Docker + Docker Compose on both new VPS
- [ ] Set up Tailscale (or WireGuard) mesh across all 3 VPS; verify
      `sg ↔ eu ↔ us` connectivity by MagicDNS hostname
- [ ] Deploy the existing stack (`docker compose up -d`) on EU and US,
      each with its own standalone Mongo for now
- [ ] Add `INSTANCE_REGION=sg|eu|us` to each region's `server/.env`
- [ ] Code: read `INSTANCE_REGION` in `server/config.ts` (~3 lines)
- [ ] Code: add `region` field to request logs in `server/app.ts` (~3 lines)
- [ ] Code: deepen `/health` to verify Mongo connectivity (not just liveness) — §14.7
- [ ] Exit check: `https://<region>.dict…/health` green on all three

## Phase 1 — MongoDB replica set

- [ ] Decide self-hosted RS vs. Atlas global cluster (open question §12.3) —
      price out Atlas before committing
- [ ] Enable Mongo auth (`--auth`), create replication + app users; generate
      keyFile/TLS certs for intra-RS auth (`preferTLS`)
- [ ] Expose each `mongod` on the Tailscale interface only
      (host mongod or compose `ports:` bound to tailscale IP — pick one, §8)
- [ ] Ensure every `api` container can **resolve and reach all three**
      Tailscale member hostnames (§14.3 — biggest trap; no `directConnection=true`)
- [ ] Maintenance window on SG: restart `mongod` with `--replSet rs0`,
      `rs.initiate()` using Tailscale MagicDNS hostnames, SG `priority: 2`
- [ ] Join EU and US as secondaries (`priority: 1`); let initial sync complete
      (seed from `mongodump` if data is large)
- [ ] Tune `settings.electionTimeoutMillis` (~10 s) and verify oplog size is
      generous enough for multi-hour member outages (§14.6)
- [ ] Switch `MONGODB_URI` to the replica-set URI on all three regions
- [ ] Code: `readPreference`/`writeConcern` per §6.3:
  - [ ] `server/favorites.ts` — reads `primary`, writes `{ w: 'majority' }`
  - [ ] `server/cache/translationCache.ts` — reads `nearest`, inserts `{ w: 1 }`
        (+ comment explaining why `w:1` is intentional, §14.7)
  - [ ] `server/admin/*Repo.ts` — reads `primary`, writes `{ w: 'majority' }`
  - [ ] Make cache-miss insert fire-and-forget if it isn't already (§14.4)
- [ ] Update `scripts/mongodb-backup.sh` + cron: dump from a secondary,
      run backups from ≥2 regions (§14.7)
- [ ] Document rollback: restart without `--replSet` → standalone
- [ ] Exit check: favorite added in EU visible from SG within seconds;
      cache miss in one region fills the others

## Phase 2 — Geo DNS + health checks + TLS

- [ ] Pick DNS provider — note §14.2: Cloudflare geo steering is **paid**
      (Load Balancing add-on); Route 53 geolocation is likely cheapest
- [ ] Resolve §14.1: single-hostname geo DNS (recommended start) vs.
      CDN-proxy vs. split hostnames — amend §3 decision accordingly
- [ ] Switch Let's Encrypt to **DNS-01** challenges; distribute cert (with
      SANs / wildcard) to all three VPS; automate renewal + distribution (§14.5)
- [ ] Create per-region debug subdomains (`sg./eu./us.dict…`) and add them to
      `ALLOWED_ORIGINS` if kept (open question §12.2)
- [ ] Configure geo-steering records: AS→SG, EU→EU, NA→US, default→SG
- [ ] Configure health checks against each region's `/health`
      (3 consecutive failures @ 10 s → pull from rotation)
- [ ] Enable DNSSEC at the provider (§9)
- [ ] Cut `dict.ai-dictionary.org` over to the geo record set (low TTL first)
- [ ] Exit check: `dig` from APAC/EU/NA probes returns the right VPS;
      simulated region-down removes it from rotation

## Phase 3 — SPA on CDN (optional, revisit per §14.1)

- [ ] Only if first-visit TTFB is a measured problem: choose CDN model
      (Cloudflare proxied w/ LB, or split `api.` hostname) and account for
      CORS/CSP/Auth0 callback changes
- [ ] Otherwise: confirm each region serves `dist/` locally with immutable
      asset caching (already true today) and close this phase

## Phase 4 — Verify & tune

- [ ] Run for 1 week; grep logs by `region=` to confirm EU traffic ≈ EU users
- [ ] Confirm p50 lookup latency in EU < 100 ms
- [ ] Add replication-lag monitoring + alert at lag > 10 s (§14.6)
- [ ] Add per-region status view (admin portal Overview polling all 3 `/health`)
- [ ] Failover drill: stop SG, verify EU/US election + DNS failover + majority
      writes resume; document observed degraded mode
- [ ] Backup restore drill from a secondary dump
- [ ] Note known trade-offs in docs: 3× effective rate limits (§14.7),
      writes always cross to primary (§14.4)
