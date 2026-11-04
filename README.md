# امتداد

Arabic tutoring platform with separate `/owner`, `/teachers`, and `/students` portals. React runs in the browser; a Cloudflare Worker enforces account permissions and stores shared data in D1. The public `/video` shortcut redirects into the signed-in portal; rooms are opened from reservations.

## Separate administration deployment

The owner portal is a separate Render web service at `https://emtidad-alelm-owner.onrender.com/owner`. It uses the existing MongoDB accounts and data with host-only administration cookies. It does not require ChatGPT sign-in or use the earlier Sites gateway. The public service runs with `PORTAL_MODE=public`; the owner service runs with `PORTAL_MODE=owner`. Both are free-plan services and deploy from the same `main` branch.

`PORTAL_MODE=owner` serves only the administration portal and its API. `PORTAL_MODE=public` rejects administration pages, administration API requests and administration sign-in, including old sessions. Role authorization remains mandatory in both deployments. The default `all` mode preserves existing deployments until the separate service is ready.

Deploy `render-owner.yaml` as a Render Blueprint first. It references the existing `emtidad-alelm` service's database environment variables without copying secrets into source. Verify the new service's actual URL and owner sign-in, then set `PORTAL_MODE=public` on the existing public service and redeploy it. Do not enable public-only mode before verifying the owner service, to avoid locking out the owner. See [Render Blueprint environment references](https://render.com/docs/blueprint-spec#referencing-service-properties).

Regression checks for saved teacher subjects and portal isolation: `node --import tsx --test tests/teaching-choices.test.ts tests/portal-access.test.mjs`. The light/dark desktop/mobile discovery UI check is `node tests/portal-discovery-regression-browser.mjs` against Vite on port 5192 (or `UI_BASE_URL`).

## Owner phone notifications

The owner account menu contains an explicit device-notification switch and a test-notification button. It requests system permission only in response to that switch. Home Screen web apps on iOS/iPadOS 16.4+ and installed Chrome web apps on Android use Web Push. Denied permission is shown honestly and must be changed in the device settings; no automatic permission prompt runs on startup.

Both Render services must share the same `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`. Keep the private key in Render environment variables, never in source. Owner subscriptions are registered on the owner origin; audit events from the public service send encrypted notifications to active owners using the shared database. Clicking a notification opens its dashboard section, and explicit logout unsubscribes that device. `node --test tests/owner-push-server.test.mjs tests/owner-push-worker.test.mjs` tests delivery and background-worker behavior; `node tests/owner-push-browser.mjs` checks the permission flow with simulated iPhone/Android browser APIs.

## Workflows

- Students register, browse available appointments, reserve a lesson, cancel future reservations, read materials, and message their teacher.
- Teachers register for approval, maintain their profile, publish non-overlapping appointments, enter booked lessons, share lesson notes and HTTPS resource links, and complete past lessons.
- The owner approves or suspends accounts, views reservations, records or reverses manually received payments with a receipt reference, exports CSV, and reviews the operation log.
- The owner account directory has separate teacher and student tabs with name/email search. Current password hashes are never returned. After confirming their own password, the owner can issue a 24-hour temporary password, displayed once and stored only as a salted hash. Existing sessions are revoked, the reset is audited without the password, and the recipient must choose a different password before accessing any account data. Resetting an owner account through this flow is not allowed.
- Every API request checks the session, role and record ownership. No public admin registration. Sessions use hashed random tokens in HttpOnly cookies and are revoked on suspension or password change.
- Video rooms are limited to the booked student and teacher. They open 15 minutes before a lesson and remain available while the booking is confirmed; room identifiers rotate when a lesson is cancelled or completed. Existing PeerJS camera, microphone and desktop screen sharing behavior is preserved.
- Confirmed lessons glow gently starting 15 minutes before their start, with a countdown across the teacher/student portal. Users can opt into audio and browser notifications, delivered once during the reminder window and once at the start. Reduced-motion preferences disable animation. Reminder polling stops on logout and ignores cancelled lessons; delivery history is device-local and deduplicated across tabs when Web Locks is available. These are open-site reminders, not server push: a closed or OS-suspended browser cannot reliably deliver them.

## Local Development

Requires Node.js 24 and npm.

```sh
npm ci
npm run db:local
npm run dev
```

Open `http://127.0.0.1:8787/students`, `/teachers`, or `/owner`. Configure a local-only `OWNER_SETUP_TOKEN` in ignored `.dev.vars`. Open `/owner#setup=YOUR_LOCAL_TOKEN` to create the owner once. Never commit this token or use the local testing value in production.

For frontend hot reload, keep `npm run dev:worker` on 8787 and run `npm run dev:client` on 5173.

## Node/MongoDB Backend

The standalone backend is in `server/index.js`. It is written in JavaScript with Node.js, Express, and MongoDB.

Create a local `.env` file from `.dev.vars.example`, set `MONGODB_URI`, `MONGODB_USER`, `MONGODB_PASSWORD`, and `MONGODB_DB`, then run:

```sh
npm run build
npm run backend
```

For a GitHub Pages frontend, rebuild with `VITE_API_URL` set to the deployed backend URL.

## Checks

```sh
npm run build
npm test
node tests/browser.mjs
node tests/reminders-browser.mjs
```

The browser check uses installed Chrome and the running local Worker. It creates local test accounts only. API tests exercise the built Worker against a fresh SQLite database, including unauthorized access, booking conflicts, payment permissions, room isolation, messages, cancellation, and session revocation.

## Source Layout

| Directory | Responsibility |
| --- | --- |
| `src/app` | Portal shell and navigation |
| `src/features/auth` | Login and registration |
| `src/features/portal` | Accounts, appointments and reservations |
| `src/features/video` | Lesson call UI |
| `src/services` | API client and PeerJS connection |
| `worker` | Authentication, authorization and server API |
| `db`, `drizzle` | Schema and generated migrations |
| `scripts` | Worker build and packaging support |
| `tests` | API and browser workflow checks |
| `android` | Existing Android wrapper |

## Publishing and Operations

### Temporary Development Login

Server secrets `DEVELOPMENT_LOGIN_HASH` (salted PBKDF2 hash) and `DEVELOPMENT_LOGIN_EXPIRES` (UTC epoch milliseconds) enable an expiring shared login password for existing teacher/student accounts only. The account email and matching portal are still required. Owner login, suspended-account blocking, pending-teacher approval, and record ownership checks remain enforced. Original passwords are unchanged. Development sessions skip the temporary-password-change screen, are audited, expire with the configured deadline, and become invalid when the shared secret is removed or rotated. Never put the plaintext shared password in source, client assets, or database records. Remove the environment keys and redeploy to disable this development access.

Reuse the Sites project in `.openai/hosting.json`. `npm run build` emits `dist/client`, `dist/server/index.js` and `dist/.openai`, including schema migrations. Configure a unique secret `OWNER_SETUP_TOKEN` through Sites runtime settings before the first deployment. It permits exactly one owner account, then becomes unusable. Keep its setup link private.

Generate future migrations with `npm run db:generate`; do not rewrite already deployed migrations. Prices are stored as integer hundredths of JOD. Times are stored as UTC milliseconds and displayed in the visitor's device timezone. Lists currently return up to 500 reservations/appointments and 1,000 accounts; extend pagination before those limits are reached.

Payment records represent manual receipt confirmation, not card processing or automatic refunds. Cancelled paid lessons are flagged for refund review. Email verification, automated password recovery, notifications and a payment processor are not connected. Arrange D1 backups and retention procedures before collecting substantial business data.

PeerJS currently uses hosted public signaling and STUN. A managed TURN service is still required for reliable connectivity on restrictive networks. Scheduled rooms close after the five-minute grace period and cannot be re-entered. Existing direct media still cannot be centrally terminated before that deadline without a managed media/signaling service. No recording is performed.

### Device push notifications

Generate a VAPID key pair once with `npx web-push generate-vapid-keys`, then add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` to the Render environment. Never commit the private key. After deployment, users who enable message notifications receive Web Push notifications even when the site is closed (subject to Android/browser notification permissions).

The downloadable APK is the existing debug-signed WebView wrapper. It receives website updates live. Native Android screen capture and a release-signed application are not implemented; native changes require an APK update.
