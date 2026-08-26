// Public URLs for this app, used when we hand a link to someone outside it.

/**
 * The web preview's origin. Kept in sync with `.github/workflows/deploy.yml`
 * (which publishes the export to the `runningapp/` directory Porkbun maps to
 * this subdomain) and with `deploy/DEPLOY.md`.
 */
export const WEB_BASE_URL = 'https://runningapp.pmarroquin.com';

/**
 * Shareable link to a race.
 *
 * Sharing used to send the race's `sourceUrl` — a third-party calendar page.
 * That handed every share to someone else's site and gave the recipient no
 * route back to the app, which is the one moment race discovery is naturally
 * social ("I'm doing this one, come with me").
 *
 * Depends on the SPA fallback added in the same change: the web export is a
 * single-page build, so a direct hit on /race/<id> only resolves because the
 * host serves 404.html — see deploy/DEPLOY.md. Race ids are already
 * URL-safe slugs (lowercase, digits, hyphens), so no encoding is needed, but
 * it costs nothing to be explicit.
 */
export function raceWebUrl(id: string): string {
  return `${WEB_BASE_URL}/race/${encodeURIComponent(id)}`;
}
