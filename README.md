# @tristancage/baileys

A WebSockets library for interacting with WhatsApp Web.

## Install

Latest release from GitHub:

```bash
npm install github:TristanCage/Bailey#v6.8.0 --allow-git=all
```

or with yarn:

```bash
yarn add github:TristanCage/Bailey#v6.8.0
```

Requires Node.js 20+.

## Quick Start

```js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@tristancage/baileys';

const { state, saveCreds } = await useMultiFileAuthState('./auth');
const sock = makeWASocket({ auth: state });

sock.ev.on('creds.update', saveCreds);
sock.ev.on('connection.update', ({ connection, qr }) => {
  if (qr) console.log('Scan this QR:', qr);
  if (connection === 'open') console.log('Connected');
});

sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.message || msg.key.fromMe) continue;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    await sock.sendMessage(msg.key.remoteJid, { text: `You said: ${text}` });
  }
});
```

## Pairing Code

```js
// auto-generated code
const code = await sock.requestPairingCode('1234567890');

// custom 8-character code
const code = await sock.requestPairingCode('1234567890', 'ABCD1234');
```

## Sending Messages

```js
await sock.sendMessage(jid, { text: 'Hello' });
await sock.sendMessage(jid, { image: { url: 'https://example.com/a.jpg' }, caption: 'Photo' });
await sock.sendMessage(jid, { video: { url: 'https://example.com/a.mp4' }, caption: 'Video' });
await sock.sendMessage(jid, { document: { url: 'https://example.com/a.pdf' }, fileName: 'a.pdf' });
await sock.sendMessage(jid, { audio: { url: 'https://example.com/a.mp3' }, ptt: true });
await sock.sendMessage(jid, { sticker: { url: 'https://example.com/a.webp' } });
await sock.sendMessage(jid, { location: { degreesLatitude: 6.5, degreesLongitude: 3.3 } });
await sock.sendMessage(jid, { react: { text: '👍', key: msg.key } });
```

Quote and mention:

```js
await sock.sendMessage(jid, { text: '@user hello' , mentions: ['1234567890@s.whatsapp.net'] }, { quoted: msg });
```

Download incoming media:

```js
import { downloadMediaMessage } from '@tristancage/baileys';
const buffer = await downloadMediaMessage(msg, 'buffer', {});
```

## Interactive Buttons

All senders return the message key. `ai` defaults to `false`.

```js
import {
  sendButtons, sendUrlButtons, sendCopyButtons, sendCallButtons,
  sendList, sendInteractiveList, sendPoll, sendFooterOnly, sendInteractive,
  getButtonReplyId, getListReplyId,
  quickReply, ctaUrl, ctaCopy, ctaCall, singleSelectButton
} from '@tristancage/baileys';

// quick replies (max 3)
await sendButtons(sock, jid, {
  text: 'Pick one:',
  footer: 'Tap a button',
  buttons: [
    { id: 'yes', displayText: 'Yes ✅' },
    { id: 'no', displayText: 'No ❌' },
  ],
  mentions: ['1234567890@s.whatsapp.net'],
});

// URL buttons
await sendUrlButtons(sock, jid, {
  text: 'Links:',
  buttons: [{ displayText: 'Open 🌐', url: 'https://example.com' }],
});

// copy / call buttons
await sendCopyButtons(sock, jid, {
  text: 'Your code:',
  buttons: [{ displayText: 'Copy 📋', copyCode: 'SAVE20' }],
});
await sendCallButtons(sock, jid, {
  text: 'Call us:',
  buttons: [{ displayText: 'Call 📞', phoneNumber: '+1234567890' }],
});

// classic list (iOS + Android)
await sendList(sock, jid, {
  text: 'Choose:',
  buttonText: 'Open Menu',
  sections: [{
    title: 'Options',
    rows: [{ id: 'a', title: 'Option A' }, { id: 'b', title: 'Option B' }],
  }],
});

// poll
await sendPoll(sock, jid, {
  name: 'Best color?',
  options: ['Red', 'Blue', 'Green'],
  selectableOptionsCount: 1,
});

// mixed native-flow buttons
await sendInteractive(sock, jid, {
  text: 'Choose an action:',
  buttons: [
    quickReply('buy', 'Buy 🛒'),
    ctaUrl('Store 🏪', 'https://shop.example.com'),
    ctaCopy('Copy 📋', 'PROMO'),
    ctaCall('Call 📞', '+1234567890'),
  ],
});
```

Handling replies:

```js
sock.ev.on('messages.upsert', ({ messages }) => {
  for (const msg of messages) {
    const buttonId = getButtonReplyId(msg.message);
    if (buttonId) console.log('button:', buttonId);
    const rowId = getListReplyId(msg.message);
    if (rowId) console.log('list row:', rowId);
  }
});
```

## WhatsApp Flows

```js
import { parseWhatsAppFlowResponse, resolveNativeFlowButtons } from '@tristancage/baileys';

await sock.sendWhatsAppFlow(jid, {
  flowId: 'FLOW_ID',
  flowToken: 'TOKEN',
  cta: 'Open form',
  body: 'Complete the form below',
  footer: 'Powered by bot',
});

const flow = parseWhatsAppFlowResponse(msg.message);
if (flow) console.log(flow.flowId, flow.screen, flow.data);

// build any native-flow button set
const buttons = resolveNativeFlowButtons([
  { text: 'Buy', url: 'https://example.com' },
  { text: 'Reply', id: 'r1' },
  { text: 'Menu', sections: [{ title: 'A', rows: [{ id: 'a', title: 'A' }] }] },
]);
```

## Username

Lookup and management:

```js
// username → JID (cached, with live fallback)
const jid = await sock.getJidForUsername('alice');

// JID → username (cached from messages/groups)
const username = await sock.getUsernameForJid('1234567890@s.whatsapp.net');

// live lookup
const result = await sock.resolveUsername('alice');
// { status: 'valid' | 'taken' | 'not-found' | 'invalid', jid?, username? }

const availability = await sock.checkUsername('newname');
const mine = await sock.getMyUsername();
await sock.setUsername('newname');
await sock.deleteUsername();
await sock.setUsernamePin('1234');
await sock.getUsernameRecommendations();
await sock.findUserByUsername('alice');
await sock.fetchContactUsernames('1234567890@s.whatsapp.net');
```

Username ↔ JID mappings persist in the auth key store and auto-populate from incoming
messages, group participant updates, and lookups.

## Status / Stories

```js
import { StatusHelper, createTextStatus, sendStatus } from '@tristancage/baileys';

// personal status to specific contacts
await sock.sendStatus(StatusHelper.text('Hello world', '#25D366', 0), ['1234567890@s.whatsapp.net']);

// image / video / gif / voice note
await sock.sendStatus(StatusHelper.image(buffer, 'Caption'), ['1234567890@s.whatsapp.net']);
await sock.sendStatus(StatusHelper.videoUrl('https://example.com/a.mp4', 'Clip'), []);
await sock.sendStatus(StatusHelper.gif(buffer, 'GIF'), []);
await sock.sendStatus(StatusHelper.voiceNote(buffer), []);

// group status
await sock.sendGroupStatus(groupJid, { text: 'Group update' });

// channel status
await sock.sendChannelStatus(channelJid, { text: 'Channel update' });
sock.ev.on('newsletter.status', status => console.log(status));
```

`STATUS_BACKGROUNDS` and `STATUS_FONTS` are exported for text styling.

## Rich Messages

AI-style rich responses (text, tables, code blocks, LaTeX, images, citations):

```js
await sock.sendRichResponse(jid, {
  headerText: '# Report',
  contentText: 'Here are the results:',
  code: 'const x = 1;',
  language: 'javascript',
  table: [['Name', 'Value'], ['A', '1'], ['B', '2']],
  footerText: 'Generated by bot',
});

// or explicit submessages
await sock.sendRichResponse(jid, {
  richResponse: [
    { text: 'Summary' },
    { code: ['const a = 1;'], language: 'javascript' },
    { table: [['A', 'B'], ['1', '2']], title: 'Numbers' },
    { inlineImage: 'https://example.com/a.png', imageText: 'Chart' },
  ],
});
```

Advanced layouts:

```js
import { RichLayout } from '@tristancage/baileys';

const layout = new RichLayout()
  .text('# Results')
  .table([['A', 'B'], ['1', '2']], 'Numbers')
  .searchResult({ title: 'Source', url: 'https://example.com' })
  .image({ url: 'https://example.com/a.png' })
  .map({ centerLatitude: 6.5, centerLongitude: 3.3, annotations: [{ latitude: 6.5, longitude: 3.3, title: 'Here' }] });

await sock.sendRichLayout(jid, layout);
```

Primitives: `richMarkdown`, `richCode`, `richTable`, `richImage`, `richInlineImage`,
`richInlineLink`, `richVideo`, `richReel`, `richPost`, `richProduct`, `richSearchResult`,
`richMap`, `richDynamic`, `richWidget`, `richFooterAction`, `richSocialProfile`, `richMenu`.

## Scheduled Messages

Server-side scheduling (chats 10 min – 14 days, channels up to 30 days):

```js
const scheduled = await sock.sendScheduledMessage(jid, { text: 'Reminder!' }, Math.floor(Date.now() / 1000) + 3600);
await sock.unscheduleMessage(jid, scheduled.key);
```

Local scheduler (in-process queue):

```js
import { createMessageScheduler } from '@tristancage/baileys';

const scheduler = createMessageScheduler((jid, content) => sock.sendMessage(jid, content));
const entry = scheduler.scheduleDelay(jid, { text: 'Later' }, 60_000);
scheduler.cancel(entry.id);
```

## A2UI Surfaces

```js
import { A2UI } from '@tristancage/baileys';

await sock.sendA2UI(jid, [
  A2UI.text('root', 'Welcome', { variant: 'h1' }),
  A2UI.column('col', ['root', 'btn']),
  A2UI.button('btn', 'root', { call: 'openUrl', args: { url: 'https://example.com' } }, { variant: 'primary' }),
]);

const ui = new A2UI(sock)
  .addText('root', 'Pick one', { variant: 'h2' })
  .addRow('row', ['root'])
  .addButton('reply', { text: 'Reply', id: 'r1' });
await ui.send(jid);
```

Components: `text`, `image`, `icon`, `video`, `audio`, `column`, `row`, `list`, `card`,
`tabs`, `modal`, `divider`, `button`, `textField`, `checkBox`, `choicePicker`, `slider`,
`dateTimeInput`. Surfaces require a component with id `root`.

## Grid Layouts

```js
await sock.sendGridImage(jid, ['https://example.com/1.png', 'https://example.com/2.png']);
await sock.sendVideoGrid(jid, [{ url: 'https://example.com/v.mp4', title: 'Clip' }]);
await sock.sendVerticalAlbum(jid, [
  { image: 'https://example.com/a.png' },
  { video: { url: 'https://example.com/b.mp4' } },
]);
```

## Sticker Packs

```js
await sock.sendStickerPack(jid, {
  name: 'My Pack',
  publisher: 'My Bot',
  description: 'Cool stickers',
  stickers: [
    { data: buffer1, emojis: ['😀'], fileName: 'one.webp' },
    { data: buffer2, emojis: ['😎'], fileName: 'two.webp' },
  ],
  trayIcon: trayBuffer,
  trayIconFileName: 'tray.png',
  origin: 'THIRD_PARTY',
});
```

## Spam Reporting

Incoming messages automatically cache their reporting tags.

```js
await sock.reportSpam(jid);                              // uses cached tags
await sock.reportContact(jid, [msg.key]);
await sock.reportGroup(groupJid, [msg.key]);             // also leaves the group
await sock.reportUser(jid, 'spam');
await sock.reportMessage(jid, msg.key.id, 'spam');
await sock.reportAndBlockUser(jid, 'spam');

sock.reportingInfoStore.getForJid(jid, 5);
```

Reasons: `spam`, `harassment`, `impersonation`, `scam`, `other`.

## In-Memory Store

```js
import { makeInMemoryStore } from '@tristancage/baileys';

const store = makeInMemoryStore({ socket: sock });
store.bind(sock.ev);

store.chats.all();
store.contacts;
store.messages[jid]?.array;
await store.loadMessage(jid, msg.key.id);
await store.loadMessages(jid, 50);
await store.fetchGroupMetadata(jid, sock);

store.toJSON();
store.writeToFile('./store.json');
store.readFromFile('./store.json');
```

## Message Search

```js
import { searchMessages, MessageSearchManager } from '@tristancage/baileys';

const results = searchMessages(store.messages[jid].array, 'invoice', { limit: 10 });

const index = new MessageSearchManager();
index.addFromStore(store);
index.search('invoice');
index.getByType('image');
index.getByJid(jid);
```

## Presence Tracker

```js
import { PresenceTracker } from '@tristancage/baileys';

const tracker = new PresenceTracker(sock, ['1234567890@s.whatsapp.net']);
tracker.on('online', ({ jid }) => console.log(jid, 'online'));
tracker.on('offline', ({ jid }) => console.log(jid, 'offline'));
tracker.on('typing', ({ jid }) => console.log(jid, 'typing'));
tracker.on('lastSeen', ({ jid, lastSeen }) => console.log(jid, lastSeen));

tracker.isOnline(jid);
tracker.getPresence(jid);
tracker.getAllPresence();
await tracker.subscribe(jid);
tracker.destroy();
```

## vCard & JID Utilities

```js
import { generateVCard, parseVCard, createContactCard, quickContact } from '@tristancage/baileys';

const contact = quickContact('John Doe', '+15551234567', { email: 'john@example.com' });
const vcard = generateVCard(contact);
const parsed = parseVCard(vcard);
await sock.sendMessage(jid, createContactCard(contact));

import {
  parseJid, normalizePhoneToJid, extractPhoneNumber, formatJidDisplay,
  isSameUser, getJidVariants, constructJidWithDevice, getRemoteJidFromMessage, createJidPlotter
} from '@tristancage/baileys';

parseJid('123456:2@s.whatsapp.net');
normalizePhoneToJid('+1 (555) 123-4567');
getRemoteJidFromMessage(msg);
```

## Auth State Backends

```js
import {
  useMultiFileAuthState,
  useSingleFileAuthState,
  useSqliteAuthState,
  useKeyvAuthState
} from '@tristancage/baileys';

// multiple files (default)
const { state, saveCreds } = await useMultiFileAuthState('./auth');

// single JSON file with atomic writes
const single = await useSingleFileAuthState('./auth.json');

// SQLite (bun:sqlite, node:sqlite or better-sqlite3)
const sqlite = await useSqliteAuthState('./auth.db');

// Keyv (requires: npm i keyv plus an adapter, e.g. @keyv/redis)
const keyv = await useKeyvAuthState('session-id', keyvInstance);
```

All return `{ state, saveCreds }`; use `sock.ev.on('creds.update', saveCreds)`.

## Anti-Ban Toolkit (opt-in)

Nothing runs unless you call `wrapSocket()` or instantiate a class.

```js
import { wrapSocket } from '@tristancage/baileys';

wrapSocket(sock, {
  rateLimiter: { maxPerMinute: 8, maxPerHour: 200, maxPerDay: 1500, minDelayMs: 1500, maxDelayMs: 5000 },
  warmup: { dayOneLimit: 20, growthPerDay: 20, maxPerDay: 1500 },
  groupGuard: { limits: { add: { max: 3, windowMs: 600000 } } },
  timelockGuard: {},          // handles 463 reach-out restrictions
  reconnectThrottle: {},      // exponential backoff with jitter
  humanEntropy: { jids: ['1234567890@s.whatsapp.net'] },
});

sock.antiban.rateLimiter.stats();
sock.antiban.unwire();
```

Standalone classes: `RateLimiter`, `WarmUp`, `GroupOperationGuard`, `TimelockGuard`,
`ReconnectThrottle`, `HumanEntropy`, plus `classifyGroupOpError`.

## Chat Modifications

```js
await sock.chatModify({ pin: true }, jid);
await sock.chatModify({ archive: true }, jid);
await sock.chatModify({ clear: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] }, jid);
```

`clear` requires `lastMessages`; app-state is synced automatically before patches.

## Groups & Communities

```js
await sock.groupCreate('Name', ['1234567890@s.whatsapp.net']);
await sock.groupParticipantsUpdate(groupJid, [jid], 'add');    // add | remove | promote | demote
await sock.groupUpdateSubject(groupJid, 'New name');
await sock.groupUpdateDescription(groupJid, 'New description');
await sock.groupSettingUpdate(groupJid, 'announcement');       // announcement | not_announcement
await sock.groupMetadata(groupJid);
await sock.groupInviteCode(groupJid);
await sock.communityCreate('Name', 'Description');
```

## Newsletters (Channels)

```js
await sock.newsletterCreate('Name', 'Description');
await sock.newsletterMetadata('jid');
await sock.newsletterFollow(jid);
await sock.newsletterMute(jid);
await sock.newsletterUpdateName(jid, 'New name');
await sock.newsletterUpdateDescription(jid, 'New description');
```

## Chat State & Receipts

```js
await sock.readMessages([msg.key]);
await sock.sendPresenceUpdate('available');       // available | unavailable | composing | recording | paused
await sock.presenceSubscribe(jid);
await sock.fetchStatus(jid);
await sock.profilePictureUrl(jid, 'image');
```

## Account & Privacy

```js
await sock.updateProfileName('Bot');
await sock.updateProfileStatus('Online 24/7');
await sock.updateProfilePicture(jid, { url: 'https://example.com/a.jpg' });
await sock.updateBlockStatus(jid, 'block');       // block | unblock
await sock.fetchBlocklist();
await sock.fetchNewChatMessageCap();              // new-chat quota/usage
```

## Utilities

```js
import {
  captureEventStream, readAndEmitEventStream, ProtocolDebug,
  createZip, crc32, isStringNullOrEmpty, makeInMemoryStore
} from '@tristancage/baileys';

captureEventStream(sock.ev, './events.jsonl');
const { ev, task } = readAndEmitEventStream('./events.jsonl');

const debug = new ProtocolDebug({ protocolDebug: true, protocolDebugDir: './logs/protocol' });
debug.startup(config);
debug.append('frames.jsonl', { node });
```

## Events

Common socket events:

```
connection.update   creds.update        messages.upsert     messages.update
messages.delete     messages.reaction   message-receipt.update
chats.upsert        chats.update        chats.delete        contacts.upsert
contacts.update     groups.upsert       groups.update       group-participants.update
presence.update     blocklist.set       blocklist.update    lid-mapping.update
newsletter.status   message-capping.update                  account-reachout-timelock.update
messaging-history.set
```

## Changelog

See [docs/POST-6.7.10-CHANGES.md](docs/POST-6.7.10-CHANGES.md) for everything added after v6.7.10.

## Disclaimer

This project is not affiliated with WhatsApp or Meta. Use at your own discretion and in
compliance with WhatsApp's Terms of Service.
