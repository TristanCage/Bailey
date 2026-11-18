# Argo MEX responses — investigation note

## Which queries return Argo vs JSON

The live report is for `newsletterMetadata('invite', code)`:

- `<result format="argo">`, 498 bytes, query ID `27456920720571478`
- Plain `JSON.parse` throws on that payload

Live logs also show `FOLLOW` (`24404358912487870`) and `UNFOLLOW` (`9767147403369991`)
returning Argo. The fix branches on the `format` attribute inside the shared
`executeWMexQuery`, so every MEX query is covered. The JSON path is unchanged.

## Current query ID

Verified against the live `web.whatsapp.com` bundle on 2026-11-18, and independently
confirmed by `wacore` 0.7.0:

- `WAWebMexFetchNewsletterJobQuery` → `params.id = "27456920720571478"`
- Variables: `fetch_creation_time`, `fetch_full_image`, `fetch_pinned_messages`,
  `fetch_status_metadata`, `fetch_viewer_metadata`, `fetch_wamo_sub`, `input`
- `input` carries `key`, `type` (`JID`/`INVITE`) and `view_role` (`GUEST`)

`QueryIds.METADATA` uses `27456920720571478`. `UPDATE_METADATA` already matched
the current Web ID `24250201037901610`.

Official Baileys (WhiskeySockets master) still uses the old ID and has no Argo
handling; whatsmeow maps the same query to platform-specific IDs and disables
Argo decoding.

## Wire format (corrected)

The header `0x04` decodes to bitset `2` (SelfDescribing), but the Core is **not**
a `DESC` value: WhatsApp writes it against the query's wire schema. A DESC parse
reads the first `00` as `false` and stops immediately — that was the bug in the
first implementation.

The real 498-byte payload splits cleanly into six scalar blocks plus a 34-byte
Core:

| # | len | content |
|---|-----|---------|
| 0 | 61 | id + name.id + preview.id (`ID` block) |
| 1 | 6 | `ACTIVE` (state enum) |
| 2 | 366 | creation_time, name.text, update_time, direct_path, invite, subscribers_count (`String` block) |
| 3 | 7 | `PREVIEW` (picture type enum) |
| 4 | 10 | `UNVERIFIED` (verification enum) |
| 5 | 5 | `BASIC` (reaction-codes setting enum) |
| 6 | 34 | Core, schema-driven RECORD |

Blocks are assigned lazily in schema-encounter order, exactly as the reference
Argo decoder does. `lib/Utils/argo.js` now walks the query schema field by field
(`WAWebMexFetchNewsletterJobQuery`, plus join/leave/update/create), with bounds
checks and descriptive errors.

## What the real invite payload contains

- `id` = `120363413156936744@newsletter`
- `state.type` = `ACTIVE`
- `thread_metadata.name.text` = `CypherX Space`
- `thread_metadata.preview.type` = `PREVIEW`, `direct_path` starts `/m1/v/t24/`
- `thread_metadata.invite` = `0029Vb8tzN4BFLgPH89T4I1I`
- `thread_metadata.verification` = `UNVERIFIED`
- `thread_metadata.subscribers_count` = `3244` (string)
- `thread_metadata.settings.reaction_codes.value` = `BASIC`
- `viewer_metadata` = `null` (the invite lookup carries no viewer data)
- `picture` = `null`, `handle` = `null`

Numeric-ish leaves (`creation_time`, `update_time`, `subscribers_count`, picture
`id`) arrive as strings.

## Verification

`test/argo-metadata.test.mjs` hard-codes the real 498-byte base64 fixture and
asserts the record above, plus JSON-path regression, malformed-payload errors,
and a genuine SelfDescribing payload. Run:

```
yarn node --test test/argo-metadata.test.mjs
```
