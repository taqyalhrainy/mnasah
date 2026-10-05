# Payments and Display Preferences

## Payments

The admin Payments tab and teacher Payments tab use `GET /api/:portal/payments?start=YYYY-MM-DD&end=YYYY-MM-DD`.

- Only authenticated, active admins and teachers can read reports. Teachers see only their own lessons.
- Ranges are inclusive civil dates in `Asia/Amman`, with Monday as the weekly anchor. One day or up to 31 days can be selected. Future dates are rejected.
- Only completed lessons contribute to earnings. Cancelled and confirmed lessons are excluded.
- Amounts remain integer minor units (100 per JOD). Commission is rounded per lesson, then summed consistently for the period, teacher, and daily totals.
- `PLATFORM_COMMISSION_PERCENT` controls commission, defaulting to the existing 15%. Mongo and D1 use the same accounting implementation.
- Recorded lesson payments are shown separately from uncollected amounts. They are not bank transfers or teacher payouts. This view does not initiate transfers or mark earnings as settled.
- The Mongo report filters by indexed slot dates and is not limited to the previous 500-row overview cap.
- CSV export respects the selected period and teacher filter, includes the commission rate, and escapes spreadsheet formulas.

## Preferences

The language selector and sun/moon control are available on sign-in, the workspace, and the in-call navigation menu. Defaults are Arabic and the device colour scheme. Explicit selections persist in `mansah-language` and `mansah-theme`, and sync between open tabs.

The HTML bootstrap applies saved preferences before React renders. Arabic uses RTL; English uses LTR. Labels, errors, notifications, dates, currencies, and built-in curriculum labels are localised. Names and user-authored messages are shown as entered. Catalogue records are never rewritten; custom content without a dictionary translation is shown as entered. Form values and API identifiers remain unchanged. The existing purple palette remains the dark theme; the original bright palette is the light theme.

## Verification

Run `npm run build` and `npm test`, then `node tests/preferences-payments-browser.mjs` against the Vite preview (or set `UI_BASE_URL`). The browser test covers all portal views, both languages and themes, 320-1440px layouts, persistence, canonical form values, date-range limits, financial totals, teacher filtering, CSV export, empty periods, and translated sign-in errors. Existing room tests also verify that changing preferences preserves the active camera and microphone stream.

Dark-mode checks also reject near-white interface surfaces and insufficient text contrast, including placeholders, account menus, lesson and credential dialogs, curriculum editors, teaching-level pickers, and empty payment summaries. Student and teacher workspaces inherit the shared dark surface tokens instead of their legacy light overrides.
