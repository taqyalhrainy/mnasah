# Opening the platform without the Render waiting page

The public service currently uses Render's **Free** instance (`render.yaml`). Render can put it to sleep after 15 minutes of inactivity and serve its own waiting page before any application code executes. GitHub's scheduled health checks are best effort; scheduled jobs can be delayed and do not guarantee uptime.

## Branded static entry

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
