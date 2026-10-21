# Contract: BBS / ANSI terminal UI with an ASCII room where the two entities live

Rebuild the public UI of this directory as an old-school BBS terminal (reference: Mystic BBS login screens: black
background, monospace white/grey text, ASCII/ANSI art made of characters, `$`, `#`, `░▒▓█`, box drawing). No modern
dashboard, no cards, no gradients, no big buttons, no images, no webfonts, no CDN, no framework, no build step.
Files to produce in THIS directory: `index.html`, `term.js` (terminal + commands), `room.js` (ASCII room + sprites +
animation), `data.js` (all network + verification, extracted from `classic/app.js`), `style.css`. The previous UI
stays untouched in `classic/` and is still served at `classic/index.html`; reuse its logic by copying functions into
`data.js` (request with timeout, postMessage, parseLedger, scrub/summarize, sha256Hex chain verification).
Never touch anything outside this directory. Italian UI text. No secrets anywhere.

## Agreed facts about the entities (do not contradict them)
- Two sovereign entities, same image, same brain, different seeds, each with its own shielded ZEC treasury, memory and
  public channel. Today only Entità 1 is online (`base` URL below); Entità 2 is NOT deployed (`base: null`).
- The only door is the public channel: anyone can write; everything written is public (ledger entry `human_message`);
  the entity reads messages at its next cycle (≤ 15 min) and decides whether to answer with `post_public`, or stays silent.
- Each entity chooses its own name, voice and self-image (text) — shown from `/memory-public.identity`; 'unnamed' /
  null means "senza nome". Private diary, seed, keys and API keys never exist in the browser; private ledger entries
  appear only as type/time/size.
- States: `unborn` (not born: waits for the birth gift), `alive`, dead (`/memorial` returns 200), paused (ledger
  `paused` entries), sleeping (`vitals.sleepUntil` in the future), hungry (`vitals.hunger === 'hungry'`).

## Data (all GET JSON, CORS open) on `base = https://ca42622c7ae63906602b873703a0efa769079dfa-8080.dstack-pha-prod9.phala.network`
- `/` → `{ entity, mode: 'tee'|'dev', keys:{sign,box}, zcash:{chain,address,balance,error}, ledger:{entries,head}, attestation:{mode,app,...} }`
- `/vitals` → `{ state:'unborn'|'alive', zatoshis, wallet:{ok,sync:{ok,height,at}}|{fault}, brain:[{name,model,speed,keyConfigured}], hoursLeft, hunger, daysAlive, bornAt, sleepUntil }`
- `/memory-public` → `{ identity:{name,voice,image}|null, plan, promises:[], events:[{seq,ts,type}] }`
- `/public-channel` → `[{seq,ts,from:'entity',text}|{seq,ts,from:'human',author,text}]`
- `/ledger` NDJSON: public `{seq,ts,prev,type,data,hash}`; private `{seq,ts,prev,type,private:true,size,ciphertext,hash}`
- `/verify` → `{ok,entries,head}`; `/attestation` → `{mode,app,quote,...}`; `/memorial` → 404 alive / 200 dead.
- `POST /public-channel` `{author?,text}` → `201 {seq,ts}`; `400/413/429 {error}`.
- Chain verification in the browser as in `classic/app.js` (sha256 of the entry without `hash`, `prev` link, 64 zeros first).
- Dev override: `?base=http://localhost:PORT` replaces Entità 1's base (localhost only), as in classic.

## Screen layout (one `<pre>`-like monospace grid, 80 columns on desktop)
1. **Login screen** (first visit, BBS style): ASCII banner of the project name "INTERNAL DIMENSION" style but ours:
   "ENTITÀ SOVRANE" in a `$`-style figlet-like logo made by you (characters only), a status line
   `mystic-like: <n> nodes · entità online: 1/2 · rete: testnet`, then `enter your alias/handle:` with a blinking
   block cursor. Enter sets the handle (localStorage, used as `author` when talking). Empty = "anonimo".
2. **Main screen** = the ROOM (top, ~80x22 chars) + the TERMINAL (bottom: scrolling output + prompt line).
   The room is drawn with characters: walls `║═╔╗╚╝`, floor `.`/`·`, two terminals/desks (`┌──┐ │▒▒│ └──┘` with a
   screen), two chairs, a bed/couch, a window with a sky, a ledger shelf/book, a ZEC vault `[$]`, a door.
   Two entity bodies made of characters (3–5 lines tall, e.g. head `(o)` / body `/|\` / legs `/ \`; or a `$`-style
   body matching the reference), clearly distinguishable (different glyph for the head, e.g. `(1)` and `(2)` or by name tag
   above the head showing the chosen name or `e1`/`e2`).
   Entities ANIMATE: walk between spots (frames of legs), sit at the terminal and type (`>_` blinking, `...` on the
   screen), read (book glyph held), rest on the bed (`zZ`), interact (face each other with a `~` line). Their first
   appearance ASSEMBLES progressively: random characters settle into the sprite over ~1.5 s.
3. **Reality vs ambient**: the room shows two kinds of things, visibly distinct.
   - **Ambient** (idle walking, sitting, looking at the window): purely decorative. Mark the legend `~ ambiente`.
   - **Real** (from data): mapped from the latest ledger/vitals: `tick_llm` within the last 20 min → sits at its terminal
     and "thinks" (`think_deep` = long steady typing, `think_fast` = short burst); `tool read_url` → reads;
     `post_public` → speech bubble with the real text (truncated 60 chars) + `[reale]` tag; `human_message` → a small
     envelope `[✉]` appears on its desk; `sleepUntil` future → lies on the bed; `hunger==='hungry'` → paces, a `!` over
     the head; `unborn` → a dotted outline body with `in attesa del dono` sign; dead → a tombstone `[RIP]` with the name.
     Each real action appears in a one-line ticker under the room: `12:31 e1 pensa (profondo, 3443 token, 0.002 TAZ) [reale]`.
   - Entità 2 (base null): its desk and chair exist but are EMPTY; a sign on its chair: `assente · in attesa`. It never
     moves, never speaks, nothing is invented. Legend line: `e2: non ancora online`.
4. **Terminal** (below the room). Prompt `handle@entità-1 >` (or `handle@dim >` when none selected). Commands:
   `help` · `1`/`2` (select entity; `2` prints "entità 2: non ancora online") · `chi`/`who` (identity, name, voice, image text)
   · `stato`/`status` (state, hours left, hunger, days alive, born, wallet sync, brain providers, attestation mode) ·
   `tesoro` (TAZ/ZEC + zatoshis, rent/hour if derivable, hours left) · `pensieri` (public posts, latest 10) ·
   `canale` (last 20 channel messages both directions) · `di <testo>`/`say <text>` (POST; show 201 seq or error; 60 s
   cooldown shown as `riprova tra N s`) · `registro [n]` (last n entries, default 15, private shown as
   `voce privata · N byte`) · `verifica` (browser chain check with a character progress bar `[▓▓▓▓░░░░] 37/120` and
   server /verify) · `attestazione` · `memoria` (plan, promises, recent events) · `manca` (what's missing list) ·
   `aggiorna` (refetch) · `pulisci`/`clear` · `esci` (back to login).
   Output uses ASCII tables/rules, the reference's grey/white tones, slow "typewriter" reveal for headers (fast,
   skippable). Up/down arrows recall history. Unknown command → `?? comando sconosciuto, prova help`.
5. **Style**: `#000` background; text `#c8c8c8`; highlights `#ffffff`; dim `#6a6a6a`; one accent for real actions and
   the cursor `#e3b341`; errors `#e5484d`. Monospace system stack (`ui-monospace, Menlo, Consolas, monospace`).
   Fit the 80-col grid to the viewport width with a CSS font-size based on `vw` (e.g. `font-size: min(16px, 1.2vw)`
   for the room; on phones the room switches to a 48-column compact layout with the same elements) — no horizontal scroll
   at 375 px wide. Respect `prefers-reduced-motion` (no walking, instant assembly, static cursor).
   Transitions between screens: a quick ANSI-style "screen wipe" with `░▒▓` characters (≤ 400 ms).
6. **Honesty**: every data line carries its fetch time (`letto alle hh:mm:ss`); fetch errors print `!! /vitals: rete non
   raggiungibile` and the room keeps showing the last known state marked `(dati non aggiornati)`; dev mode (`mode:'dev'`)
   prints a red banner `NON ATTESTATA` in the room's top border. Nothing is simulated for Entità 2.
7. **Accessibility**: the room `<pre>` has `aria-label` describing the scene in words (updated when real actions
   change); the terminal input is a real `<input>` with a label; focus goes to the prompt after login.

## Acceptance
- `node --check` passes on every .js; `python3 -m http.server 8090` serves it; no console errors with `?base=` pointing to
  a local enclave; the 375 px layout has no horizontal overflow; all commands above work; `di` posts and handles 429.
- Report: files, the sprite/state mapping, what you could not verify.
