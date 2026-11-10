# PayPal wallet checkout

The student chooses a JOD wallet amount, reviews its USD equivalent, then pays on PayPal's hosted Payments Standard checkout. The configured recipient is `takee12345678900@gmail.com`. No card data passes through this application. Merchant eligibility, guest card checkout and currency acceptance remain controlled by PayPal; the UI does not promise that cards are available to every buyer.

Optional server configuration (defaults already supplied):

| Variable | Default |
| --- | --- |
| `PAYPAL_MODE` | `live` |
| `PAYPAL_RECEIVER_EMAIL` | `takee12345678900@gmail.com` |
| `PAYPAL_PUBLIC_ORIGIN` | `https://emtidad-alelm.onrender.com` |
| `PAYPAL_JOD_PER_USD` | `0.709` |

JOD is not a supported PayPal currency. The server quotes USD using the configured platform conversion rate and rounds up to a USD cent. The student sees both amounts before leaving. Their bank/PayPal may apply its own conversion or fees. Sandbox mode uses separate fixed checkout/verification endpoints and needs a sandbox merchant email. These settings are not API credentials.

Each checkout supplies `/api/payments/paypal/ipn` as `notify_url`. Browser return/cancel never adds funds. The listener verifies the original raw bytes with PayPal, validates recipient, mode, invoice, secret, currency, amount and transaction type, and waits for `Completed`.

Permanent transaction bindings and atomic per-order account markers prevent duplicate credits. Retried callbacks repair ledger/projection/audit failures. Full refunds reverse credit once, including callbacks arriving before the original payment. Ambiguous partial refunds/canceled reversals pause spending and PayPal top-ups until an owner reconciles them in the wallet review screen, with a version check, evidence and an idempotent reference. Balances may become negative if refunded funds were already spent.

The listener must remain reachable. Transient failures return a retryable error; recovery uses PayPal IPN retry/resend rather than a separate background reconciliation job.

Validation uses isolated Mongo-behavior test doubles, mocked PayPal verification, and browser checkout interception. No real payment or merchant-account eligibility check was performed.

References: [PayPal IPN verification](https://developer.paypal.com/api/nvp-soap/ipn/ht-ipn/), [per-payment notification URL](https://developer.paypal.com/api/nvp-soap/ipn/IPNSetup), [PayPal currencies](https://developer.paypal.com/api/codes/currency), [CBJ foreign exchange rates](https://www.cbj.gov.jo/en/Pages/foreignexchangerates).
