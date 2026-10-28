# PayPal sandbox testing

Run `node scripts/sandbox-check.mjs` (add `--card` for the full server-side lifecycle). It reads credentials from `.env` (gitignored, mode 600) and prints only statuses and public ids, never credentials or tokens. It refuses to run against a non-sandbox base URL.

## Verified against the real sandbox (2026-10-28)

| Step | Result |
| --- | --- |
| OAuth client credentials token | works |
| Create order, intent AUTHORIZE, PayPal wallet source (same payload as `lib/paypal.ts`) | works, status PAYER_ACTION_REQUIRED, approval link on www.sandbox.paypal.com |
| App flow `POST /api/deals` then `POST /api/milestones/:id/fund` with real credentials | works, ledger records the real order id |
| Authorize before buyer approval | correctly rejected with ORDER_NOT_APPROVED (422) |
| Card test source, intent AUTHORIZE: order plus authorization | works (authorization status CREATED) |
| Capture that authorization (final capture) | works, COMPLETED |
| Void a second authorization | works, HTTP 204 |

## Needs a browser buyer approval

The wallet flow used by the app (`payer-action` link, then the return URL calls `/authorize`) needs a sandbox personal (buyer) account to log in on www.sandbox.paypal.com and approve. That step cannot be done with only the REST app credentials, so the authorize call inside the app was exercised through the card source instead, which covers the same authorize, capture and void endpoints.

To complete the wallet path by hand:

1. Run `npm run dev` with `.env` filled in.
2. Create a deal, click Fund on a milestone, and open the approval link.
3. Log in with a sandbox personal account from developer.paypal.com under Testing Tools, Sandbox Accounts, and approve.
4. PayPal redirects to `/api/paypal/return`, which authorizes. Then submit work, release (capture) or cancel (void).
