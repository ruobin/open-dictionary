# Open Dictionary — docs index

Categorized index of everything under `docs/`. The root [`README.md`](../README.md)
is the entry point for the whole project; this file indexes the long-form
documents only.

> **Browser extension docs live separately** — see
> [`extension/README.md`](../extension/README.md) → *"Documentation index"*
> (extension has its own `RELEASE.md`, `STORE_LISTING.md`, design doc, phase
> tracker, and Firefox-port notes).

---

## Design docs (architecture rationale)

Read these for the *"why"* behind a subsystem.

| Doc | What it covers |
|---|---|
| [`design-translation-cache.md`](./design-translation-cache.md) | Full design rationale for the translation cache + LLM provider tier (the core lookup pipeline). |
| [`design-admin-portal.md`](./design-admin-portal.md) | Admin portal design — runtime provider CRUD, latency lab, playground, audit log. See **§18** for as-built delta. |
| [`design-admin-cache-entries.md`](./design-admin-cache-entries.md) | Admin **Entries / Reports** pages — browse/search/delete cached translations + triage user reports. See **§17** for as-built delta. |
| [`design-user-activity-log.md`](./design-user-activity-log.md) | Admin **Activity** page — per-lookup activity log (word, IP, device) + aggregated summary for user-behavior/growth analytics. |
| [`design-geo-load-balancing.md`](./design-geo-load-balancing.md) | Multi-region (SG / US / EU) deployment design — route each user to the nearest VPS. **Draft · not yet implemented.** |
| [`ui-i18n-and-themes.md`](./ui-i18n-and-themes.md) | Dark/light theming + UI i18n design. |

---

## Security

| Doc | What it covers |
|---|---|
| [`security.md`](./security.md) | Threat model, findings & mitigations, and operational hardening recommendations. |

---

## Operations & planning

| Doc | What it covers |
|---|---|
| [`to-do-geo-load-balancing.md`](./to-do-geo-load-balancing.md) | Phase-by-phase implementation checklist for `design-geo-load-balancing.md` (provisioning, mesh, routing, cutover). |

---

## Assets & how-to

| Doc | What it covers |
|---|---|
| [`favicon.md`](./favicon.md) | Regenerating the favicon/icon raster assets (PNG + JPEG) from `public/favicon.svg` via `rsvg-convert` — plus the `sips` gotcha and the extension store-icon recipe. |
