# Judge setup

Install Node 22.12+ (22.x), 24.x or 26+, then run `npm ci`, `npm test`, `npm run build` and `npm run preview`. Open `http://127.0.0.1:4173` in Chrome. No Firebase credentials are needed for the manual workflow. Create a project, capture a fictional repair note, choose manual entry, review and confirm, then reload the timeline. Select the record under Share & handoff and inspect the preview without sending it.

For AI, use a compatible prepared desktop Chrome with the organizer-required Nano 4 setup. Supply your own project's six public Firebase web configuration values and public reCAPTCHA Enterprise site key from `.env.example` at build time. Production must use a site key valid for the hosting domain, not a development debug token. Verify AI Logic/provider/model availability and no-charge constraints before any cloud test. For optional sync, confirm the auth domain, anonymous authentication and deployed owner-isolation rules first. A pending write is not evidence of sync. Do not retry an unknown-outcome write.

Hosting configuration points only to `dist`. The credential-free production build supports local manual review, not verified hosted AI. Build again in a clean workspace with approved public web settings before any authorized Firebase Hosting-only deployment. Never upload `.env.local`, private credentials, history or node_modules. Do not change billing or App Check enforcement for the demo.

Earlier genuine on-device extraction and offline SDK evidence are not a successful fresh hybrid test. Latest structured attempt timed out; product cloud synthesis returned HTTP 503; live Firestore receipt and effective Nano generation are unconfirmed.
