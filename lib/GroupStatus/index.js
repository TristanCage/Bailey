import { randomBytes } from 'crypto';
import { generateWAMessageContent, generateWAMessageFromContent } from '../Utils/messages.js';

/**
 * Post a group-status update using WhatsApp's groupStatusMessageV2 wrapper.
 *
 * The inner content uses the same AnyMessageContent shapes as sendMessage,
 * including text, image, video, audio, sticker, and other supported content.
 *
 * @param {object} sock socket instance (uses relayMessage, waUploadToServer, user)
 * @param {string} jid group JID
 * @param {object} content message content (same shapes as sendMessage)
 * @param {{ backgroundColor?: string, font?: number }} [options]
 */
export const sendGroupStatus = async (sock, jid, content, options = {}) => {
	// Build/upload the inner message exactly as a normal message.
	const inner = await generateWAMessageContent(content, {
		...options,
		upload: sock.waUploadToServer
	});
	const messageSecret = randomBytes(32);

	// WhatsApp expects the same secret on both the outer message and the
	// wrapped inner message.
	const wrapped = generateWAMessageFromContent(
		jid,
		{
			messageContextInfo: { messageSecret },
			groupStatusMessageV2: {
				message: {
					...inner,
					messageContextInfo: { messageSecret }
				}
			}
		},
		{ userJid: sock.user?.id }
	);

	await sock.relayMessage(jid, wrapped.message, { messageId: wrapped.key.id });
	return wrapped;
};
