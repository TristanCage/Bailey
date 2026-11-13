import { proto } from '../../WAProto/index.js';
import { generateMessageIDV2 } from '../Utils/generics.js';
import { generateWAMessageContent } from '../Utils/messages.js';
import { getBinaryNodeChild } from '../WABinary/index.js';

/**
 * Decode a channel status from its incoming `<status>` stanza.
 *
 * Wire shape (captured live from WhatsApp):
 *
 *   <status from="12036...@newsletter" type="text"
 *           id="3EB0..." t="1794223368" server_id="136">
 *     <plaintext>proto.Message bytes</plaintext>
 *   </status>
 *
 * Non-newsletter `<status>` stanzas return undefined: personal statuses are
 * handled through the ordinary message stream.
 *
 * @param {object} node binary node
 * @returns {object|undefined}
 */
export const decodeChannelStatus = (node) => {
	const from = node.attrs.from;
	if (!from?.endsWith('@newsletter')) {
		return undefined;
	}

	const plaintextNode = getBinaryNodeChild(node, 'plaintext');
	if (!plaintextNode?.content) {
		return undefined;
	}

	const contentBuf =
		typeof plaintextNode.content === 'string'
			? Buffer.from(plaintextNode.content, 'binary')
			: Buffer.from(plaintextNode.content);

	let message;
	try {
		// no toJSON(): it turns the font enum into its name ('SYSTEM' for 0)
		message = proto.Message.decode(contentBuf);
	} catch {
		return undefined;
	}

	const extendedText = message.extendedTextMessage;

	return {
		id: node.attrs.id || '',
		channelJid: from,
		type: node.attrs.type || 'text',
		serverId: node.attrs.server_id,
		messageTimestamp: +(node.attrs.t || 0),
		offline: !!node.attrs.offline,
		text: extendedText?.text || message.conversation || undefined,
		backgroundArgb: extendedText?.backgroundArgb ?? undefined,
		font: extendedText?.font ?? undefined,
		message
	};
};

/**
 * Post a channel status — the temporary (24h) update a channel admin posts
 * from the channel, shown in followers' Status tray.
 *
 * Sent as a top-level `<status>` stanza to the channel JID with a
 * `<plaintext>` child holding the plain proto.Message bytes.
 *
 * @param {object} sock socket instance (uses sendNode, waUploadToServer, user)
 * @param {string} jid channel JID (…@newsletter)
 * @param {object} content message content (same shapes as sendMessage)
 * @param {{ backgroundColor?: string, font?: number }} [options]
 * @returns {Promise<{ id: string, channelJid: string, message: object }>}
 */
export const sendChannelStatus = async (sock, jid, content, options = {}) => {
	const inner = await generateWAMessageContent(content, {
		...options,
		upload: sock.waUploadToServer
	});

	const id = generateMessageIDV2(sock.user?.id);
	const bytes = proto.Message.encode(inner).finish();

	await sock.sendNode({
		tag: 'status',
		attrs: {
			to: jid,
			id,
			type: 'text'
		},
		content: [{ tag: 'plaintext', attrs: {}, content: bytes }]
	});

	return { id, channelJid: jid, message: inner };
};
