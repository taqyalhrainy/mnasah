# Call transport and resilience

## Production prerequisite

The authenticated production ICE endpoint was audited on 2026-11-14. It returned
STUN servers and **no TURN endpoints**. Code changes cannot provision an external
relay account. Do not describe production relay support as enabled until a
credentialed relay-only connection has been tested.

Configure ONE provider in the Render backend Environment settings, then redeploy:

* Cloudflare Realtime TURN: `CLOUDFLARE_TURN_KEY_ID` and
  `CLOUDFLARE_TURN_API_TOKEN` from the account's TURN key.
* An existing standard TURN provider: `TURN_URLS`, `TURN_USERNAME`,
  `TURN_CREDENTIAL`. Include UDP and TLS/TCP 443 endpoints supplied by that provider.
* Existing Twilio TURN credentials remain supported through `TWILIO_ACCOUNT_SID`
  and `TWILIO_AUTH_TOKEN`.

New Cloudflare master credentials must remain backend-only, without a `VITE_`
prefix. The authenticated ICE endpoint returns short-lived client credentials,
coalesces concurrent provider calls, caches them, limits upstream requests to four
seconds, and retains valid cached credentials through temporary provider failures.
`relay_available` reports configured credentials, not proof of a successful
allocation; verify a real relay candidate as well. Account creation and billing
are separate actions; this patch does not activate a paid service.

Provider documentation:
https://developers.cloudflare.com/realtime/turn/generate-credentials/
https://developers.cloudflare.com/realtime/turn/

## Runtime behavior

* Preserve low-rate moving video under congestion. High RTT or video loss alone
  does not switch the lesson to audio-only. Sustained severe audio damage can
  temporarily suspend video and resume it after clean audio samples.
* Opus mono, FEC, DTX and high audio priority; bounded video bitrates, resolution
  and frame rate; receiver feedback limits the other endpoint's send rate.
* Optional bounded receiver jitter smoothing; packet-stall detection and native
  online/background recovery without reopening the microphone for network faults.
* Teacher initiates a replacement media call. Keep the old stream until the new
  transport connects. A failed replacement cannot close a working original call.
* Board/data-channel recovery is independent from healthy voice/video. Explicit
  peer leave still ends remote presence immediately.
* Remote SDP tracks alone are not proof that media is connected. Attach remote
  media after the transport connects, including cameras enabled during joining.

## Verification

`npm run build:backend`

`node --test tests/video-ice.test.mjs tests/adaptive-call-quality.test.mjs tests/video-connection-service.test.mjs`

`node tests/weak-network-call-browser.mjs` checks the actual app with real peer
media and injected congestion telemetry, including both audio directions and
gradual video recovery. This is distinct from actual packet loss.

Optional real UDP impairment lab (not a production dependency):

`npm install --prefix DO_NOT_UPLOAD/call-network-lab node-turn@0.0.6 --no-audit --no-fund`

`node tests/relay-call-browser.mjs`

The lab grants local-network access ONLY to its isolated browser context to reach
its own localhost TURN server. Production uses public relays and does not request
that permission. The lab throttles and discards actual encrypted UDP media and
checks real audio decoding, video frames and recovery after an outage. It uses
fake camera/microphone devices, not human recordings. It runs the actual classroom
UI and service, with 176 kbps per direction, 3% random packet loss and 45 ms added
latency plus bounded queuing. After a 9.5-second full media outage it requires
newly received audio packets and decoded video on a connected replacement, with
no microphone reacquisition. Physical iOS/Android tests on real carrier/Wi-Fi
networks remain a separate acceptance step. These lab conditions are not a
guarantee of intelligibility on every device or network.
