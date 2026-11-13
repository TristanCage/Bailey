# Changes after v6.7.10

> **Version policy:** this document tracks everything added after v6.7.10. **v6.8.0** is the
> first release containing these changes; npm remains on 6.7.10 until a separate publish.

---

## 1. Core updates

- **WAProto** updated: new message types, fields and enums
- **App-state sync rework**: fetch retry/backoff, fatal-error classification, fail-fast while holding the key lock, sync round limits
- **Blocklist**: `getBlocklist`, `fetchBlocklist`, LID-aware blocking
- **libsignal**: incoming-session lookup, duplicate-message counter preservation (`MessageCounterError`)
- **messages-recv/send**: LID addressing, sender-key delivery, device fanout, receipt handling
- **reporting-utils**, history, media upload, validate-connection, stanza-ack updates
- `fetchNewChatMessageCap()` — new-chat quota/usage via MEX
- `ACCOUNT_RESTRICTED_TEXT` + `NACK_REASONS.SenderReachoutTimelocked` (463) used on failed acks
- `isStringNullOrEmpty` helper
- `DEF_MEDIA_HOST` export + custom host in `getUrlFromDirectPath`
- Profile-picture tctoken and `WIN_HYBRID` support

---

## 2. New modules and features

### Username API (`lib/Username/`)
- `checkUsername`, `checkUsernameMulti`
- `setUsername`, `deleteUsername`, `getMyUsername`
- `getUsernameRecommendations`, `setUsernamePin`
- `findUserByUsername`, `fetchContactUsernames` (JID → username)
- `setUsernameQueryIds` — runtime patch for rotated GraphQL query IDs
- Socket: `sock.checkUsername`, `sock.setUsername`, `sock.getMyUsername`, `sock.findUserByUsername`, etc.
- Results auto-populate the persistent username ↔ JID map

### Group status (`lib/GroupStatus/`)
- `sendGroupStatus(jid, content, options)` / `sock.sendGroupStatus`
- Uses `groupStatusMessageV2` with a shared message secret

### Channel status (`lib/ChannelStatus/`)
- `sendChannelStatus` / `sock.sendChannelStatus`
- `decodeChannelStatus`
- New `newsletter.status` event on incoming channel statuses

### Sticker packs (`lib/StickerPack/`, `lib/Utils/zip.js`)
- `sendStickerPack` / `sock.sendStickerPack`
- Dependency-free ZIP writer (`createZip`, `crc32`)
- Correct `sticker-pack` / `thumbnail-sticker-pack` HKDF keys and media paths

### Rich messages (`lib/RichMessages/`)
- Basic builder: `prepareRichResponseMessage`, `sendRichResponse`, `wrapToBotForwardedMessage`
- Code highlighting: `tokenizeCode`; tables, latex, inline images, citation links
- **Advanced layouts** (`layouts.js`): `richImage`, `richVideo`, `richReel`, `richPost`,
  `richProduct`, `richSearchResult`, `richMap`, `richDynamic` (GIF/image), `richInlineLink`,
  `richWidget`, `richSocialProfile`, `richMenu`, `richTable`, `richCode`
- `RichLayout` fluent builder + `sendRichLayout` / `sock.sendRichLayout`

### WhatsApp Flows (`lib/Flows/`)
- `parseNativeFlowResponse`, `parseWhatsAppFlowResponse`
- `buildWhatsAppFlowButton`, `makeWhatsAppFlowButton`
- `resolveNativeFlowButtons` (url, webview, call, copy, flow, reminder, location, catalog,
  review/pay/order, payment status, transaction details)
- `sendWhatsAppFlow` / `sock.sendWhatsAppFlow`

### Spam reporting (`lib/SpamReport/`)
- `reportSpam`, `reportContact`, `reportGroup`, `reportUser`, `reportMessage`, `reportAndBlockUser`
- Automatic capture of `reporting_tag` from incoming messages
- Constants: `SPAM_FLOWS`, `REPORT_REASON_CODES`
- Helpers: `extractReportingInfoFromStanza`, `buildSpamReportIq`, `parseSpamReportResponse`
- Socket: `sock.reportSpam`, `sock.reportMessage`, `sock.reportingInfoStore`, etc.

### Modern message builders (`lib/ModernMessages/`)
- Questions: `makeQuestionMessage`, `makeQuestionReplyMessage`, `makeQuestionResponseMessage`
- Status: `makeStatusQuestionAnswerMessage`, `makeStatusQuotedMessage`,
  `makeStatusStickerInteractionMessage`, `makeStatusNotificationMessage`,
  `makeStatusMentionMessage`, `makeStatusAudienceMetadata`, `makeGroupStatusReactionMessage`
- Comments, event invites, scheduled call create/edit, poll add-option
- Newsletter admin/follower invites, status attributions, message associations
- `prepareModernMessageContent` normalizes friendly keys into protobuf fields

### Scheduled messages (`lib/ScheduledMessages/`)
- `sendScheduledMessage` / `sock.sendScheduledMessage`
- `unscheduleMessage` / `sock.unscheduleMessage`
- AES-256-GCM reveal-key encryption (`encodeScheduledMessage`, `decodeScheduledMessage`)
- `buildScheduledMsgMetaNode`, `buildUnscheduleProtocolMessage`
- Window validation (`isScheduledTimeValid`): chats 10 min–14 days, channels up to 30 days

### A2UI surfaces (`lib/A2UI/`)
- `A2UI` class with static components: text, image, icon, video, audio, column, row, list,
  card, tabs, modal, divider, button, textField, checkBox, choicePicker, slider, dateTimeInput
- `sendA2UI`, `sendA2UIMessage`, `sock.sendA2UI`, `sock.sendA2UIMessage`
- Image inputs accept URL, Buffer or file path (uploaded automatically)

### Grid media layouts (`lib/GridMessages/`)
- `sendGridImage`, `sendVideoGrid`, `sendVerticalAlbum`
- Socket: `sock.sendGridImage`, `sock.sendVideoGrid`, `sock.sendVerticalAlbum`

### In-memory store (`lib/Store/`)
- `makeInMemoryStore` with chats, messages, contacts, group metadata, presences, labels
- Binds to socket events for automatic updates
- `loadMessages`, `loadMessage`, `mostRecentMessage`, `getChatLabels`, `getMessageLabels`,
  `fetchImageUrl`, `fetchGroupMetadata`, `fetchMessageReceipts`, `toJSON`/`fromJSON`,
  `writeToFile`/`readFromFile`
- Dependency-free `KeyedDB`, `ObjectRepository`, `makeOrderedDictionary`

### Extras (`lib/Extras/`)
- Payments: `money`, `readMoney`, `buildSplitPayment`, `buildSplitPaymentUpdate`,
  `buildPaymentReminder`, `readSplitPayment`, `readPaymentReminder`
- Sticker annotations: `locationSticker`, `channelSticker`, `linkSticker`, `musicSticker`,
  `messageSticker`, `normalizeStickers`, `readStickers`, `stickerArea`
- Music: `buildMusicMessage`, `readMusicMessage`, `isMusicHostAllowed`

### Auth state backends
- `useSingleFileAuthState` — debounced atomic writes (`lib/Utils/use-single-file-auth-state.js`)
- `useSqliteAuthState` — `bun:sqlite`, `node:sqlite` or `better-sqlite3`
- `useKeyvAuthState` / `hasKeyvAuth` — optional `keyv` package, any Keyv adapter

### Utilities
- `USyncFeatureProtocol` + `USyncQuery.withFeatureProtocol()` — queries `encrypt*`, `voip`,
  `multi_agent`, `bot_eligible` capabilities
- `captureEventStream` / `readAndEmitEventStream` — record and replay socket events
- `ProtocolDebug` — dump startup context and protocol frames to disk
- `getMediaHost` / `sock.getMediaHost()` — live media host from `media_conn`
- Android browser detection accepts both tuple shapes (`['Android',…]` and `[name,'Android',…]`)
- MEX notification handlers: `MessageCappingInfoNotification` (`message-capping.update`) and
  `NotificationUserReachoutTimelockUpdate` (`connection.update.reachoutTimeLock`)

---

## 3. Fixes and safeguards

- **Buttons module**: removed `viewOnceMessage` wrapper (Desktop render fix), `ai` defaults to
  `false`, plain JS payloads (proto encoding was dropping mentions), mentions placed inside the
  message type and at top level for maximum client compatibility
- **Duplicate export fix**: `XWAPaths`/`QueryIds` conflict between `Types/Mex.js` and
  `Types/Newsletter.js` resolved via named re-export
- **Chat modify**: `clear` requires `lastMessages`; blocked app-state collections are retried
  with a full snapshot before encoding patches
- **Android browser**: correct platform/`webInfo` payload for view-once delivery
- **Long dependency**: declared explicitly as a direct dependency
- **`datasync` fallback** for fs shims (Yarn PnP)

---

## 4. Socket methods added after 6.7.10

```
getJidForUsername / getUsernameForJid / resolveUsername (caching)
checkUsername / checkUsernameMulti / setUsername / deleteUsername
getMyUsername / getUsernameRecommendations / setUsernamePin
findUserByUsername / fetchContactUsernames / setUsernameQueryIds
fetchNewChatMessageCap
sendGroupStatus / sendChannelStatus
sendStickerPack
sendWhatsAppFlow
sendRichResponse / sendRichLayout
reportSpam / reportContact / reportGroup / reportUser / reportMessage / reportAndBlockUser
sendScheduledMessage / unscheduleMessage
sendA2UI / sendA2UIMessage
sendGridImage / sendVideoGrid / sendVerticalAlbum
getMediaHost
```

## 5. Data added to the public exports

`UsernameMappingStore`, `KeyedDB`, `ObjectRepository`, `makeInMemoryStore`,
`RichLayout`, `A2UI`, `ProtocolDebug`, `USyncFeatureProtocol`, and all helpers listed above.

---

## 6. Before v6.7.10 (for context)

These already existed in 6.7.10 and are not part of this changelog: the standalone **Buttons**
module (quick replies, URL/copy/call buttons, lists, polls, mentions, reply parsing), the
persistent **username ↔ JID mapping store**, `resolveUsername`, tctoken recovery, offline batch
requester, shortcake passkey linking, offline-node processing, and the protocol updates made
before the 6.7.10 bump.

---

## 7. Additional modules and utilities

### Status posting (`lib/Status/`)
- `sendStatus(sock, content, jidList, options)` / `sock.sendStatus`
- `StatusHelper.text/image/imageUrl/video/videoUrl/gif/voiceNote`
- `STATUS_BACKGROUNDS`, `STATUS_FONTS`, `generateStatusMessageId`
- Individual JIDs become `statusJidList`; group JIDs route through `sendGroupStatus`

### vCard utilities (`lib/VCard/`)
- `generateVCard`, `generateVCards`, `parseVCard`
- `createContactCard`, `createContactCards`, `quickContact`

### JID utilities (`lib/JidUtils/`)
- `parseJid`, `getSenderPn`, `getCurrentSenderInfo`, `isSelf`, `plotJid`
- `normalizePhoneToJid`, `extractPhoneNumber`, `formatJidDisplay`, `isSameUser`
- `getJidVariants`, `constructJidWithDevice`, `getRemoteJidFromMessage`
- `createJidPlotter` (LID ↔ PN resolution)

### Message search (`lib/MessageSearch/`)
- `extractSearchableText`, `getSearchableMessageType`
- `searchMessages`, `searchMessagesRegex`
- `MessageSearchManager` (`addMessages`, `addFromStore`, `search`, `getByJid`, `getByType`, …)

### Presence tracker (`lib/PresenceTracker/`)
- `PresenceTracker` / `PresenceMonitor` / `createPresenceTracker`
- Tracks online/offline, typing, recording, last-seen; LID alias linking
- Events: `presence.update`, `online`, `offline`, `typing`, `recording`, `lastSeen`
- `subscribe`, `unsubscribe`, `resubscribeAll`, `getPresence`, `getAllPresence`, `isOnline`, `destroy`

### Message scheduler (`lib/MessageScheduler/`)
- `MessageScheduler` / `createMessageScheduler` — local queue with `schedule`, `scheduleDelay`,
  `cancel`, `cancelForJid`, `getPending`, `stop`/`start`, auto-stop when empty, `unref` timer

### MEX update constants (`lib/Types/Mex.js`)
- `MexUpdatesOperations`: community owner, group member link, group limit sharing
- `XWAPathsMexUpdates`: group prop change, community roles change

### Anti-ban toolkit (`lib/Antiban/`) — opt-in, zero overhead when unused
- `RateLimiter` — per-minute/hour/day limits, Gaussian jitter, identical-message guard, serialized queue
- `WarmUp` — day-based daily limits with JSON save/restore
- `GroupOperationGuard` — add/create/remove/promote/demote windows + `classifyGroupOpError`
- `TimelockGuard` — 463 reachout restriction backoff (15 min → 24 h)
- `ReconnectThrottle` — exponential backoff with jitter
- `HumanEntropy` — optional typing/read/presence cycles (timers `unref`'d)
- `wrapSocket(sock, options)` — wraps `sendMessage` and group operations; exposes `sock.antiban`
  with `unwire()`; nothing runs unless explicitly called

