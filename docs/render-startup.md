# Opening the platform without the Render waiting page

The public service currently uses Render's **Free** instance (`render.yaml`). Render can put it to sleep after 15 minutes of inactivity and serve its own waiting page before any application code executes. GitHub's scheduled health checks are best effort; scheduled jobs can be delayed and do not guarantee uptime.

## Branded static entry

## Independent frontend (current deployment)

Public frontend: **https://emtidad-alelm.taqialhrainy.chatgpt.site**

The frontend assets and application shell are now served from the existing free
Sites/Cloudflare hosting. `npm run build` produces this deployment. Render keeps
the Express API, Socket.IO, MongoDB records, file storage, payment callbacks and
TURN configuration; its existing `npm run build:backend` remains unchanged.
No database migration and no Render billing change are required.

The frontend Worker only proxies `/api/`, `/socket.io/` and `/health` to the fixed
Render backend. Cookies remain HttpOnly, on the frontend's own host, rather than
depending on third-party cookies on iPhone. API responses and uploads are never
cached. Range requests and WebSocket upgrades are forwarded without buffering.
Provider waiting HTML becomes a retryable JSON response while the locally served
platform loader stays visible. A new visitor never navigates to Render.

Google's button runs in a narrowly scoped iframe on its existing authorized
Render origin. Only the exact frontend window receives its credential, and the
backend still verifies the token with Google. This avoids breaking existing Google
accounts when the new frontend origin has not been added to Google Cloud.
Payment callbacks remain on Render; customer return URLs use the new frontend.

The owner portal remains separately hosted at
`https://emtidad-alelm-owner.onrender.com`; no admin API is exposed by the public
frontend. Opening the old public Render URL still opens its legacy frontend and
can encounter Render's first-visit waiting page. Share the new frontend URL to
avoid that page. A visitor must sign in once on the new hostname; browser
permissions and existing installed apps also belong to their original hostname.

For local development against the local Express server, use `npm run dev:client`
and `npm run dev:backend`. The built frontend proxy targets production Render;
do not use it for test transactions. The legacy D1 Worker is retained only as
source compatibility code, never as this deployment's live API.

## Legacy static entry

`https://taqyalhrainy.github.io/mnasah/launch/` is published alongside the application by the existing GitHub Pages workflow. It displays the platform logo and loading message immediately, checks the Render `/health` endpoint, and navigates to the normal platform URL only after a JSON `{ ok: true }` response. It never displays the provider's temporary HTML. Optional `?portal=teachers`, `?portal=students` and `?portal=owner` select the destination without accepting arbitrary redirect URLs. Existing login cookies remain on their normal Render origin; no credentials, tokens or payment data pass through this page.

The installed service worker also displays a branded waiting page if the host returns its own waiting HTML and the application shell is unavailable. A first-ever visit directly to an asleep `onrender.com` address still reaches Render before a service worker can run. Use the static entry URL for that case; the existing Render address and search canonical remain unchanged.

For a reliable first visit, open Render Dashboard → `emtidad-alelm` → Settings → Instance Type and select an always-on paid instance. Do the same for `emtidad-alelm-owner` if the owner portal needs the same guarantee. This changes billing and must be done by the account owner. Keep the existing environment variables, database and domains; no new deployment or data migration is required. If the service is managed by a Blueprint, update its `plan` to match the selected paid instance as well.

Application improvements in this update:

- Installed browsers load the cached shell within 150 ms while checking the server in the background.
- A Render waiting page cannot replace the cached application shell.
- Login, registration and workspace code load separately, with workspace prefetch for returning users.
- A pending request no longer shows a misleading retry button. Genuine failed requests still offer recovery.

The browser retains a renewable HttpOnly learning session for up to one year. Logout, password resets, account suspension, expiry and browser/site-data removal still invalidate access. Safari and an installed home-screen app may have separate browser storage; sign in once in each context. No passwords or session tokens are copied into localStorage.

References: https://render.com/docs/free and https://render.com/docs/faq
