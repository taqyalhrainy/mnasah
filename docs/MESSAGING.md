# Persistent student–teacher messaging

The `messages` view is in the student/teacher navigation and in the call's
navigation drawer. A call stays mounted when the user opens this view.

- A successful reservation creates one conversation per student/teacher pair.
  Existing bookings are backfilled on the first inbox request. Conversations
  survive completed or cancelled lessons; users cannot contact unbooked accounts.
- Render stores conversations, members, messages, settings and reactions in
  MongoDB, with indexes created at startup. No external chat/GIF API key is needed.
- Socket.IO signals authenticated user rooms to refresh messages/read receipts;
  typing has a separate short-lived event. HTTP is authoritative, with polling as
  a fallback. GIF links are restricted to direct HTTPS GIFs from Giphy/Tenor.
- Read receipts, presence visibility, notifications and sound are global account
  preferences. Mute/block are per conversation. Blocking prevents both senders.
- Delete clears only the requesting member's history using a stored cutoff and
  hides their conversation. Restore/new messages reopen it without restoring
  old history. The other member's history is preserved. This is not a global
  purge of message records.
- The D1 worker implements the same API using migration
  `drizzle/0008_persistent_chat.sql`; apply it if deploying to D1. Render uses
  MongoDB and does not need this migration.

Checks: `npm run build`, `npm test`, and `node tests/chat-browser.mjs`.
The server/browser integration tests use an isolated in-memory Mongo operation
adapter; they do not create or edit production accounts. The browser test
exercises the actual Express routes, Socket.IO authentication and built client.

The optional purple color layer and its rollback are documented in
`DESIGN_THEME.md`. The original page layout and assets are preserved.
