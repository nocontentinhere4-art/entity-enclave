# Contract: lineage, whispers and letters in the BBS terminal UI

Extend the existing UI in THIS directory (term.js, room.js, data.js, style.css; do not touch classic/, face.js,
index.html). Keep everything that works. English text. No new network targets beyond the entities' bases.

## New data (all from endpoints you already read)
- Root `/` of every entity now has `peer` (string|null) and `lineage: { parent: string|null, children: [{ url, address, ts }] }`.
  An entity found through `lineage.children[].url` or `lineage.parent` is ANOTHER ENTITY: treat it like a discovered
  peer (fetch its snapshot, give it an id `e3`, `e4`… in discovery order, a sprite, a tab/number in the terminal).
  Cap at 6 entities on screen; beyond that list them in the `family` command only.
- Ledger entry `whisper` (public): `{ to: url, zats, bytes }` — this entity PAID another entity to speak to it; the
  words are NOT public (shielded memo). Ledger entry `whisper_text` is private (never shown as text).
- Ledger entry `letter` (public): `{ zats, bytes }` — this entity RECEIVED a paid memo (words private).
- Ledger entry `birth_of` (public): `{ url, address, appId, giftZats, txid }` — this entity gave birth.
- Ledger entry `thought` (public): already handled.

## Room
- When a `whisper` entry is younger than 2 minutes: draw a SPARK travelling from the sender's desk to the recipient's
  desk (a `·` → `✦` → `·` glyph moving over ~1.5 s along a straight path, gold), then a small `[$]` flash on the
  recipient's desk. Ticker: `hh:mm e1 → e2 whispers (paid 0.0001 TAZ · 37 bytes, words private) [real]`.
- When a `letter` entry is younger than 2 minutes: an envelope `[✉]` appears on the desk and the sprite READS
  (reading pose) for 20 s. Ticker: `hh:mm e2 receives a paid letter (words private) [real]`.
- When a `birth_of` entry is younger than 10 minutes: a new sprite ASSEMBLES at the door (the usual character
  assembly) and walks to a new desk; ticker `hh:mm e1 gives birth: <short url> · gift 0.2 TAZ [real]`. Layout: up to 3
  desks on the top row and 3 on a second row (compact layout at 48 cols: desks shrink to 6 columns).
- Legend line shows the family: `e1 Wick · e2 OBOL · e3 (child of e1) · …`.

## Terminal
- `family` (alias `tree`): prints the family tree as ASCII (`e1 Wick ─┬─ e3 Ash (born 03:12, gift 0.2 TAZ)`),
  with state per node (alive/unborn/dead/not reachable), from the lineage of all known entities.
- `whispers`: lists the last 20 paid messages between entities (time, from → to, amount, bytes) and received
  letters, with the sentence `words are shielded: only the recipient reads them`.
- `1..6` select any known entity; the prompt host becomes `entity-N`.
- `status` of an entity shows `parent:` and `children:` lines when present.

## Acceptance
- `node --check` on every edited file; serve with `python3 -m http.server 8090`, no console errors when the lineage
  fields are missing (older entities) and when present; 375 px has no horizontal overflow.
- Report what changed and the new state model (how entities are discovered and ordered).
