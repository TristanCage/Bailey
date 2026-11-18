# Argo MEX responses — investigation note

## Which queries return Argo vs JSON

The live report is for `newsletterMetadata('invite', code)` only:

- `<result format="argo">`, 495 bytes, query ID `6563316087068696` (Baileys' old `METADATA` ID)
- Plain `JSON.parse` throws on that payload

The fix branches on the `format` attribute inside the shared `executeWMexQuery`, so **every**
MEX query is covered if the server flips other queries to Argo later. The JSON path is
byte-for-byte unchanged. Without an authenticated live session here we cannot assert that
`newsletterSubscribers`, `newsletterFollow`, etc. currently return Argo; the observed evidence
only covers metadata.

## Current query ID

Verified against the live `web.whatsapp.com` bundle on 2026-11-18:

- `WAWebMexFetchNewsletterJobQuery` → `params.id = "27456920720571478"`
- Its variables are `fetch_creation_time`, `fetch_full_image`, `fetch_pinned_messages`,
  `fetch_status_metadata`, `fetch_viewer_metadata`, `fetch_wamo_sub`, `input` — all with
  `defaultValue: null`, so Baileys' existing three-variable request remains valid.

`QueryIds.METADATA` now uses `27456920720571478`. (`UPDATE_METADATA` already matched the
current Web ID `24250201037901610`.)

For reference, official Baileys (WhiskeySockets master) still uses the old ID and has **no**
Argo handling; whatsmeow maps the same query to other platform-specific IDs
(`6563316087068696` mobile / `9779843322044422` desktop) and explicitly disables Argo
decoding ("argo decoding is currently broken").

## Why the decoder needs no wire schema

Argo normally requires a wire type derived from the query and GraphQL schema. The captured
payload starts `04 7a ...`:

- `0x04` is the header bitset — zigzag/bitset decode gives `2`, i.e. bit 1 = **SelfDescribing**
- `0x7a` zigzag-decodes to `61`, the length of the first block — its 61 bytes are exactly
  `120363413156936744@newsletter` + `1794990968814604` + `1791239157` + `363305`
  (the apparent leading "z" in the `strings` dump was this length byte)

In SelfDescribing mode the Core is a `DESC` value, which carries its own type markers, so
`lib/Utils/argo.js` decodes it without a wire schema (objects, lists, strings with
backreferences, bytes, ints, floats; all reads bounds-checked).

## Remaining verification

The 495-byte payload lives on another VPS, so this branch ships with a synthetic fixture
built to the same framing and the known field values (JID, name, invite, `ACTIVE`,
`UNVERIFIED`, `PREVIEW`, picture path). Drop the real base64 payload into
`test/argo-metadata.test.mjs` and re-run `yarn node --test test/argo-metadata.test.mjs` to
confirm the exact field mapping end-to-end. If the server ever returns a non-SelfDescribing
Argo payload, the decoder throws a descriptive error with a base64 preview rather than
silently corrupting data.
