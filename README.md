# Mansah

Arabic tutoring platform with separate `/admin`, `/teachers`, and `/students` portals. React runs in the browser; a Cloudflare Worker enforces account permissions and stores shared data in D1. The public `/video` shortcut redirects into the signed-in portal; rooms are opened from reservations.

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

Open `http://127.0.0.1:8787/students`, `/teachers`, or `/admin`. Configure a local-only `OWNER_SETUP_TOKEN` in ignored `.dev.vars`. Open `/admin#setup=YOUR_LOCAL_TOKEN` to create the owner once. Never commit this token or use the local testing value in production.

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

PeerJS currently uses hosted public signaling and STUN. A managed TURN service is still required for reliable connectivity on restrictive networks. The room gate revokes access on the next client check (30 seconds); existing direct media is not centrally terminable without a managed media/signaling service. No recording is performed.

The downloadable APK is the existing debug-signed WebView wrapper. It receives website updates live. Native Android screen capture and a release-signed application are not implemented; native changes require an APK update.
