# Persistent student–teacher messaging

The `messages` view is in the student/teacher navigation and in the call's
navigation drawer. A call stays mounted when the user opens this view.

- A successful reservation creates one conversation per student/teacher pair.
  Existing bookings are backfilled on the first inbox request. Conversations
  survive completed or cancelled lessons; users cannot contact unbooked accounts.
- Render stores conversations, members, messages, settings and reactions in
  MongoDB, with indexes created at startup. No external chat/GIF API key is needed.
- Students and teachers can attach up to 10 files to one message. Every file may
  be up to 25 MB and the message total is capped at 100 MB. Word, PowerPoint,
  PDF, archives and arbitrary file types download as attachments; verified PNG,
  JPEG, GIF and WebP files also receive an inline preview.
- Render stores attachment bytes in MongoDB GridFS, so they survive service
  restarts and are not placed on Render's temporary filesystem. Downloads are
  authenticated and re-check conversation ownership and personal-history cutoffs.
  Pending uploads are private until their message is sent and expire after a day.
- Socket.IO signals authenticated user rooms to refresh messages/read receipts;
  typing has a separate short-lived event. HTTP is authoritative, with polling as
  a fallback. GIF links are restricted to direct HTTPS GIFs from Giphy/Tenor.
- Read receipts, presence visibility, notifications and sound are global account
  preferences. Mute/block are per conversation. Blocking prevents both senders.
- Delete clears only the requesting member's history using a stored cutoff and
  hides their conversation. Restore/new messages reopen it without restoring
  old history. The other member's history is preserved. This is not a global
  purge of message records.
- The D1 worker implements the same API using migrations
  `drizzle/0008_persistent_chat.sql` and `0009_chat_attachments.sql`; attachment
  bytes are split into 1 MB BLOB rows. Render uses MongoDB and does not need
  these migrations.

Checks: `npm run build`, `npm test`, and `node tests/chat-browser.mjs`.
The server/browser integration tests use an isolated in-memory Mongo operation
adapter; they do not create or edit production accounts. The browser test
exercises the actual Express routes, Socket.IO authentication, protected file
upload/download, image preview, and the built client.

The optional purple color layer and its rollback are documented in
`DESIGN_THEME.md`. The original page layout and assets are preserved.
