import { randomBytes } from 'crypto';
import { generateWAMessageContent, generateWAMessageFromContent } from '../Utils/messages.js';


export const sendGroupStatus = async (sock, jid, content, options = {}) => {
	
	const inner = await generateWAMessageContent(content, {
		...options,
		upload: sock.waUploadToServer
	});
	const messageSecret = randomBytes(32);

	
	
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
