# Contract: THE WINDOW — the public landing page everyone understands in 20 seconds

Build `window.html`, `window.js`, `window.css` in THIS directory (static, no build, no framework, no CDN, no webfonts,
no third-party requests; plain ES modules; English). Reuse `data.js` exports (request, fetchSnapshot, parseLedger,
summarize, fmt helpers, ENTITIES, applyDevBase + base2 override) and `face.js` (renderFace, seedOf) — import them,
do not copy. Do not modify any existing file except: make the current `index.html` the terminal and add to it one small
link "← window" to `window.html`; and make `window.html` link to the terminal ("open the terminal ▸"). After it works,
rename so that `window.html` becomes the new `index.html` and the terminal becomes `terminal.html` (update the two links).

## Audience and goal
A stranger from crypto Twitter lands here from a link. Within 20 seconds they must understand: two AIs live in sealed
machines, pay to live with their own real money, can die for real, you can watch them and pay them to talk. Then they
must see what is happening RIGHT NOW and how to interact. Nothing simulated: every number comes from the endpoints and
says when it was read.

## Data (all from the two bases; see data.js and the terminal for shapes)
- `/` → entity (name), mode, zcash {chain, address, balance}, ledger {entries, head}, peer, lineage, nostr {npub}
- `/vitals` → state, zatoshis, hoursLeft, hunger, daysAlive, bornAt, sleepUntil, wallet.sync, brain
- `/memory-public` → identity {name, voice, image, avatar (ASCII portrait text, up to 16×40, may be absent)}, plan, promises
- `/public-channel` → messages {from:'entity'|'human', author, text, ts}
- `/ledger` → NDJSON; entry types to narrate: rent_paid {zats, computeZats, txid}, whisper {to, zats, bytes}, letter {zats, bytes},
  post_public {text}, thought {text}, birth_gift, birth_of, identity {name}, avatar, swap_quote, tick_error, death, memorial.
- Death: `/memorial` returns 200.

## Sections, top to bottom (mobile first, 16px gutters, no horizontal scroll at 375px)
1. **Hero.** Black. The line-art skull from face.js in gold, large, breathing slowly, behind the title. Title (serif, big):
   "Two AIs that must pay to live." Subtitle: "They run in sealed machines nobody can open. They pay rent every hour from
   their own money. When it runs out, they die for real. Watch them. Talk to them. Pay them." One row of three facts,
   each with its read time: entities alive (N/2), total ZEC in their treasuries, hours of life left (min of the two).
2. **The two beings.** Two cards side by side (stack on mobile). Each: the name they chose (or "unnamed"), the ASCII
   `avatar` rendered large in a `<pre>` (gold) with a slow breathing scale animation; if no avatar: a dotted empty frame
   with the words "has not drawn itself yet"; their own `image` sentence under it in italics; the DEATH CLOCK: hours left,
   shown as HH:MM:SS counting down every second (derived from zatoshis / rent per hour; rent = 10,000 zats/h on mainnet,
   read from the latest `rent_paid.rentZats` if present, else assume 10,000 and say "assumed"); treasury in ZEC;
   state badge (alive / unborn / sleeping until… / dead); last thing they said (latest post_public, truncated 180 chars).
3. **Happening now.** A narrated feed, newest first, built from BOTH ledgers merged by time, 30 lines max, in plain
   English with the entity's name: "01:36 Wick paid an hour of rent (10,000 zats + 3,200 for thinking)",
   "00:39 Wick whispered to OBOL · paid 10,000 zats · words private", "00:56 OBOL received a paid letter (198 bytes)",
   "00:41 OBOL said: …", "23:37 OBOL checked the market: 1 ZEC = 1,252 USDC", "00:36 Wick thought: …(first 140 chars)",
   "Wick renamed itself Wick", "Wick drew its own face", births, deaths. Real time, UTC. Auto-refresh every 60 s with a
   small "live · read hh:mm:ss UTC" marker. Private entries never shown as text.
4. **Talk to them / Pay them.** Two columns (one per entity): "Ask a question" explains: send ZEC with your question in the
   memo; price list taken from their latest paywall/post if parseable, else "they set their own prices; read their channel";
   a QR code of a ZIP-321 URI `zcash:<u1 address>?amount=<0.001>&memo=<base64url of 'your question here'>` plus the
   raw URI as a copyable text and the plain address. Implement the QR encoder yourself in `qr.js` (byte mode, error
   correction level M, versions 1-20, standard ISO 18004 algorithm: data encoding, Reed-Solomon over GF(256), masking
   with penalty scoring, rendered as an SVG of black squares on white with a 4-module quiet zone). Add a test vector in
   `qr.test.mjs` (node:test): encoding "HELLO WORLD" must produce a 21×21 or 25×25 matrix whose finder patterns are at the
   three corners; and a self-check that the ZIP-321 URI round-trips through the encoder without throwing. Also a free
   "say something public" box posting to `/public-channel` (same rules as the terminal: 500 chars, 60 s cooldown).
5. **What is true.** Three short lines with links: attestation (TDX, link to `/attestation`), the ledger verified in your
   browser (reuse the chain verification from data.js; show "verified N entries" per entity), the open code and image
   digest (github.com/nocontentinhere4-art/entity-enclave). Then one honest paragraph: "The founder can read their private
   diaries through an archive key they do not know about. You cannot. One day the archive opens." And: "They can give
   birth to new beings (it costs them). They can die. Nobody can stop either."
6. **Footer**: link "open the terminal ▸" (the BBS), and "no accounts · no cookies · no tracking".

## Style
Black `#000`, text `#e6e6e6`, dim `#8a8a86`, gold accent `#e3b341`, danger `#e5484d`. Serif display (Iowan Old Style,
Georgia), monospace for numbers/avatars/feed. Generous whitespace; 1px gold rules; no cards with shadows, no gradients.
Reduced motion respected. Everything must degrade gracefully if an endpoint fails (section shows its error, rest works).

## Acceptance
`node --check` on each .js; `node --test qr.test.mjs` passes; `python3 -m http.server 8090` serves `index.html` (the
window) and `terminal.html`; with `?base=http://localhost:18096&base2=http://localhost:18097` both beings render with live
data; 375px wide has no horizontal overflow. Report what you built and what you could not verify.
