# Opening the platform without the Render waiting page

The public service currently uses Render's **Free** instance (`render.yaml`). Render can put it to sleep after 15 minutes of inactivity and serve its own waiting page before any application code executes. GitHub's scheduled health checks are best effort; scheduled jobs can be delayed and do not guarantee uptime.

For a reliable first visit, open Render Dashboard → `emtidad-alelm` → Settings → Instance Type and select an always-on paid instance. Do the same for `emtidad-alelm-owner` if the owner portal needs the same guarantee. This changes billing and must be done by the account owner. Keep the existing environment variables, database and domains; no new deployment or data migration is required. If the service is managed by a Blueprint, update its `plan` to match the selected paid instance as well.

Application improvements in this update:

- Installed browsers load the cached shell within 150 ms while checking the server in the background.
- A Render waiting page cannot replace the cached application shell.
- Login, registration and workspace code load separately, with workspace prefetch for returning users.
- A pending request no longer shows a misleading retry button. Genuine failed requests still offer recovery.

The browser retains a renewable HttpOnly learning session for up to one year. Logout, password resets, account suspension, expiry and browser/site-data removal still invalidate access. Safari and an installed home-screen app may have separate browser storage; sign in once in each context. No passwords or session tokens are copied into localStorage.

References: https://render.com/docs/free and https://render.com/docs/faq
