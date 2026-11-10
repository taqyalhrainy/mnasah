# Direct card checkout — PayTabs Jordan

The integration is implemented, but **not activated**. It requires an approved
LIVE merchant profile from PayTabs Jordan (including approval for the platform's
student-wallet top-ups and private tuition business model). No PayTabs account
or credentials were available during implementation, and no real payment was made.

## Activation on the public Render service

1. Register/sign in at https://merchant-jordan.paytabs.com and complete the
   provider's merchant onboarding and bank settlement requirements.
2. Obtain the LIVE Profile ID and Server Key under Developers / Key Management.
   Never put the server key in a VITE variable, frontend source, or chat.
3. Add Render server environment variables:

   ```dotenv
   PAYTABS_PROFILE_ID=<live profile id>
   PAYTABS_SERVER_KEY=<live server key>
   PAYTABS_PUBLIC_ORIGIN=https://emtidad-alelm.onrender.com
   PAYTABS_ENABLED=true
   ```

4. Enable Visa/Mastercard (`creditcard`) and JOD on that profile. Confirm the
   transaction endpoint is `https://secure-jordan.paytabs.com`.
5. Configure profile IPN (also for portal-initiated refunds) to:
   `https://emtidad-alelm.onrender.com/api/payments/card/callback`.
   Every checkout also supplies this URL as its callback. Duplicate callbacks
   are safe. Browser return is `/api/payments/card/return`.
6. Redeploy. The independent **bank card** method appears in the student wallet
   only when all required settings are configured. This is configuration
   readiness, not proof of merchant approval. Run a real low-value payment and
   refund, verify JOD amount, wallet ledger, owner notification and settlement.

## Behavior and limits

- Hosted card checkout in JOD, without a PayPal account or provider buyer account.
- Card data goes directly to PayTabs. The app never collects PAN/CVV.
- Real saved name/email/phone are prefilled; no fabricated billing address.
  PayTabs may still request missing billing fields and the issuing bank may
  require 3-D Secure. `hide_shipping` does not suppress required billing checks.
- Browser redirects never credit funds. HMAC-SHA256 over the original raw
  callback body is checked, then order/profile/reference/type/currency/exact
  amount are validated. On return, an authenticated server query can recover a
  missing callback. Pending/hold/declined/unknown states never credit.
- Live-profile activation is explicit. References starting `TST` are rejected.
  Never configure a sandbox profile on a production wallet.
- Wallet balance and per-order event markers update atomically with a CAS.
  Repeated or concurrent deliveries never double-credit. Ledger writes recover
  on retry. Partial/full signed refunds debit only their amount, at most the
  original payment; refund-before-sale callbacks do not create spendable credit.
- Refunds are initiated in the merchant dashboard, not from this app. A refunded
  payment may make a spent wallet negative; ordinary insufficient-balance checks
  prevent additional spending. Unexpected capture/void/chargeback types do not
  credit and require merchant reconciliation. This integration does not automate
  disputes or merchant payouts.
- When keys are rotated, resolve pending payments under the old profile before
  changing Profile ID. Gateway delivery retries and profile IPN must be enabled.
- Automated tests mock the gateway and use an isolated database. They do not
  prove bank acceptance, fees, checkout billing fields or merchant eligibility.

Official references:
- https://support.paytabs.com/en/support/solutions/articles/60000718070
- https://support.paytabs.com/en/support/solutions/articles/60000992876
- https://support.paytabs.com/en/support/solutions/articles/60000718961
