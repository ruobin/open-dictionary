#!/usr/bin/env bash
#
# Deploy open-dictionary to production. One safe command that can't forget a step:
#
#   npm run deploy:prod          # everything: API container + SPA + SEO prerender + rsync
#   npm run deploy:api           # server-only change: rebuild + recreate the API container
#   npm run deploy:web           # frontend-only: build SPA → prerender → rsync
#
# Why a script and not an npm one-liner: the deploy has an ordering constraint
# and a real footgun. `vite build` EMPTIES dist/ before writing the bundle, and
# `rsync --delete` would then silently wipe the prerendered SEO pages
# (word/, browse/, sitemap.xml) off the live web root if the prerender step
# were ever skipped. Bundling build → prerender → rsync into this script makes
# that impossible — the SEO pages are regenerated into the same dist/ that gets
# published, atomically. See README "Production deployment".

set -euo pipefail

cd "$(dirname "$0")/.."

# The nginx web root this deployment ships to. Override with WEB_ROOT=... for a
# different host; the script fails fast if it doesn't exist.
WEB_ROOT="${WEB_ROOT:-/var/www/html/dict.ai-dictionary.org}"
# Canonical origin — baked into the prerendered pages' canonical tags + sitemap.
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://dict.ai-dictionary.org}"
target="${1:-all}"

deploy_api() {
  echo "==> API: rebuilding image + recreating container"
  docker compose build api
  docker compose up -d api
}

deploy_web() {
  echo "==> Web: building SPA (this empties dist/ first)"
  npm run build

  echo "==> Web: regenerating SEO prerender pages (reads the compose-network Mongo)"
  PUBLIC_BASE_URL="$PUBLIC_BASE_URL" npm run prerender:prod

  if [ ! -d "$WEB_ROOT" ]; then
    echo "ERROR: web root '$WEB_ROOT' does not exist." >&2
    echo "       Not on the prod host? Override with WEB_ROOT=<path>." >&2
    exit 1
  fi
  echo "==> Web: publishing dist/ -> $WEB_ROOT"
  rsync -a --delete dist/ "$WEB_ROOT/"
  echo "==> Done."
  echo "    Verify:  ${PUBLIC_BASE_URL}/word/hello   (prerendered HTML)"
  echo "             ${PUBLIC_BASE_URL}/sitemap.xml   (should be text/xml)"
}

case "$target" in
  all) deploy_api; deploy_web ;;
  api) deploy_api ;;
  web) deploy_web ;;
  *)
    echo "usage: npm run deploy:prod [-- all|api|web]" >&2
    exit 2
    ;;
esac
