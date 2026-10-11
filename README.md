# @tristancage/baileys

A WebSockets library for interacting with WhatsApp Web. Fork of [Baileys](https://github.com/WhiskeySockets/Baileys) with custom pairing code support and interactive button senders.

## Install

```bash
npm install @tristancage/baileys
```

## Quick Start

```js
import makeWASocket, { useMultiFileAuthState } from '@tristancage/baileys';

const { state, saveCreds } = await useMultiFileAuthState('./auth');
const sock = makeWASocket({ auth: state });

sock.ev.on('creds.update', saveCreds);

sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.message || msg.key.fromMe) continue;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    await sock.sendMessage(msg.key.remoteJid, { text: `You said: ${text}` });
  }
});
```

## Pairing Code

Request a pairing code, optionally providing your own custom 8-character code:

```js
// Auto-generated code
const code = await sock.requestPairingCode('1234567890');

// Custom code
const code = await sock.requestPairingCode('1234567890', 'ABCD1234');
```

## Interactive Buttons

Send quick reply, URL, copy, and call buttons directly — no external packages needed:

```js
import {
  sendButtons, sendUrlButtons, sendCopyButtons, sendCallButtons,
  sendList, sendPoll, getButtonReplyId, getListReplyId
} from '@tristancage/baileys';

// Quick reply buttons (max 3)
await sendButtons(sock, jid, {
  text: 'Pick one:',
  buttons: [
    { id: 'yes', displayText: 'Yes ✅' },
    { id: 'no', displayText: 'No ❌' },
  ],
});

// URL buttons
await sendUrlButtons(sock, jid, {
  text: 'Links:',
  buttons: [{ displayText: 'Open 🌐', url: 'https://example.com' }],
});

// Copy-to-clipboard buttons
await sendCopyButtons(sock, jid, {
  text: 'Your code:',
  buttons: [{ displayText: 'Copy 📋', copyCode: 'SAVE20' }],
});

// Call buttons
await sendCallButtons(sock, jid, {
  text: 'Call us:',
  buttons: [{ displayText: 'Call 📞', phoneNumber: '+1234567890' }],
});

// List menu (iOS + Android)
await sendList(sock, jid, {
  text: 'Choose:',
  buttonText: 'Open Menu',
  sections: [{
    title: 'Options',
    rows: [
      { id: 'a', title: 'Option A' },
      { id: 'b', title: 'Option B' },
    ],
  }],
});

// Poll
await sendPoll(sock, jid, {
  name: 'Best color?',
  options: ['Red', 'Blue', 'Green'],
  selectableOptionsCount: 1,
});
```

## Mentions

All button/list senders accept a `mentions` array of JIDs:

```js
await sendButtons(sock, jid, {
  text: '@user pick one:',
  buttons: [{ id: 'yes', displayText: 'Yes ✅' }],
  mentions: ['1234567890@s.whatsapp.net'],
});
```

## Handling Replies

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    const buttonId = getButtonReplyId(msg.message);
    if (buttonId) console.log('Button pressed:', buttonId);

    const rowId = getListReplyId(msg.message);
    if (rowId) console.log('List selected:', rowId);
  }
});
```

## API Reference

For full API docs (message types, media, groups, channels, etc.), see the [official Baileys docs](https://baileys.wiki).

## Disclaimer

This project is not affiliated with WhatsApp or Meta. Use at your own discretion and in compliance with WhatsApp's Terms of Service.
