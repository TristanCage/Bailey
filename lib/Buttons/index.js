import { proto } from '../../WAProto/index.js';
import { generateWAMessageFromContent } from '../Utils/messages.js';

/**
 * Interactive button, list, and poll senders for Baileys.
 *
 * Senders: sendButtons, sendUrlButtons, sendCopyButtons, sendCallButtons,
 * sendList, sendInteractiveList, sendPoll, sendRequestPhoneNumber,
 * sendFooterOnly, sendInteractive.
 *
 * Reply parsing: getButtonReplyId, getListReplyId.
 *
 * Button builders (for sendInteractive): quickReply, ctaUrl, ctaCopy,
 * ctaCall, singleSelectButton.
 */

function quickReply(id, displayText) {
	return {
		name: 'quick_reply',
		buttonParamsJson: JSON.stringify({ display_text: displayText, id })
	};
}

function ctaUrl(displayText, url) {
	return {
		name: 'cta_url',
		buttonParamsJson: JSON.stringify({ display_text: displayText, url })
	};
}

function ctaCopy(displayText, copyCode) {
	return {
		name: 'cta_copy',
		buttonParamsJson: JSON.stringify({ display_text: displayText, copy_code: copyCode })
	};
}

function ctaCall(displayText, phoneNumber) {
	return {
		name: 'cta_call',
		buttonParamsJson: JSON.stringify({ display_text: displayText, phone_number: phoneNumber })
	};
}

function singleSelectButton(buttonTitle, sections) {
	return {
		name: 'single_select',
		buttonParamsJson: JSON.stringify({
			title: buttonTitle,
			sections: sections.map(s => ({
				title: s.title || '',
				rows: s.rows.map(r => ({
					id: r.id,
					title: r.title,
					description: r.description || ''
				}))
			}))
		})
	};
}

function interactiveNodes(jid, ai = false) {
	const nodes = [
		{
			tag: 'biz',
			attrs: {},
			content: [
				{
					tag: 'interactive',
					attrs: { type: 'native_flow', v: '1' },
					content: [
						{
							tag: 'native_flow',
							attrs: { v: '9', name: 'mixed' }
						}
					]
				}
			]
		}
	];
	if (ai && !String(jid).endsWith('@g.us')) {
		nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
	}
	return nodes;
}

async function sendInteractive(sock, jid, { text, footer = '', title = '', buttons, quoted, ai = false, mentions = [] } = {}) {
	if (!text) throw new Error('sendInteractive: text is required');
	if (!Array.isArray(buttons) || buttons.length === 0) {
		throw new Error('sendInteractive: buttons must be a non-empty array');
	}
	const contextInfo = mentions.length ? { mentionedJid: mentions } : {};
	const msg = generateWAMessageFromContent(
		jid,
		{
			viewOnceMessage: {
				message: {
					messageContextInfo: {
						deviceListMetadata: {},
						deviceListMetadataVersion: 2
					},
					interactiveMessage: proto.Message.InteractiveMessage.create({
						header: proto.Message.InteractiveMessage.Header.create({
							title,
							hasMediaAttachment: false
						}),
						body: proto.Message.InteractiveMessage.Body.create({ text }),
						footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
						nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons }),
						...(mentions.length ? { contextInfo } : {})
					})
				}
			}
		},
		{ quoted, userJid: sock.user?.id }
	);
	await sock.relayMessage(jid, msg.message, {
		messageId: msg.key.id,
		additionalNodes: interactiveNodes(jid, ai)
	});
	return msg.key;
}

async function sendButtons(sock, jid, { text, footer = '', title = '', buttons, quoted, ai = false, mentions = [] } = {}) {
	if (!Array.isArray(buttons) || buttons.length === 0) {
		throw new Error('sendButtons: buttons must be a non-empty array');
	}
	if (buttons.length > 3) {
		throw new Error('sendButtons: WhatsApp allows max 3 buttons per message');
	}
	return sendInteractive(sock, jid, {
		text,
		footer,
		title,
		quoted,
		ai,
		mentions,
		buttons: buttons.map(b => quickReply(b.id, b.displayText))
	});
}

async function sendList(sock, jid, { text, footer = '', title = '', buttonText, sections, quoted, ai = false, mentions = [] } = {}) {
	if (!buttonText) throw new Error('sendList: buttonText is required');
	if (!Array.isArray(sections) || sections.length === 0) {
		throw new Error('sendList: sections must be a non-empty array');
	}
	const contextInfo = mentions.length ? { mentionedJid: mentions } : {};
	const msg = generateWAMessageFromContent(
		jid,
		{
			listMessage: proto.Message.ListMessage.create({
				title: title || undefined,
				description: text,
				buttonText,
				listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
				sections: sections.map(s => ({
					title: s.title || '',
					rows: s.rows.map(r => ({
						title: r.title,
						description: r.description || '',
						rowId: r.id
					}))
				})),
				footerText: footer || undefined,
				...(mentions.length ? { contextInfo } : {})
			})
		},
		{ quoted, userJid: sock.user?.id }
	);
	await sock.relayMessage(jid, msg.message, {
		messageId: msg.key.id,
		additionalNodes: [
			{
				tag: 'biz',
				attrs: {},
				content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }]
			}
		]
	});
	return msg.key;
}

async function sendInteractiveList(sock, jid, { text, footer = '', title = '', buttonText, sections, quoted, ai = false, mentions = [] } = {}) {
	if (!buttonText) throw new Error('sendInteractiveList: buttonText is required');
	if (!Array.isArray(sections) || sections.length === 0) {
		throw new Error('sendInteractiveList: sections must be a non-empty array');
	}
	return sendInteractive(sock, jid, {
		text,
		footer,
		title,
		quoted,
		ai,
		mentions,
		buttons: [singleSelectButton(buttonText, sections)]
	});
}

async function sendUrlButtons(sock, jid, { text, footer = '', title = '', buttons, quoted, ai = false, mentions = [] } = {}) {
	if (!Array.isArray(buttons) || buttons.length === 0) {
		throw new Error('sendUrlButtons: buttons must be a non-empty array');
	}
	return sendInteractive(sock, jid, {
		text,
		footer,
		title,
		quoted,
		ai,
		mentions,
		buttons: buttons.map(b => ctaUrl(b.displayText, b.url))
	});
}

async function sendCopyButtons(sock, jid, { text, footer = '', title = '', buttons, quoted, ai = false, mentions = [] } = {}) {
	if (!Array.isArray(buttons) || buttons.length === 0) {
		throw new Error('sendCopyButtons: buttons must be a non-empty array');
	}
	return sendInteractive(sock, jid, {
		text,
		footer,
		title,
		quoted,
		ai,
		mentions,
		buttons: buttons.map(b => ctaCopy(b.displayText, b.copyCode))
	});
}

async function sendCallButtons(sock, jid, { text, footer = '', title = '', buttons, quoted, ai = false, mentions = [] } = {}) {
	if (!Array.isArray(buttons) || buttons.length === 0) {
		throw new Error('sendCallButtons: buttons must be a non-empty array');
	}
	return sendInteractive(sock, jid, {
		text,
		footer,
		title,
		quoted,
		ai,
		mentions,
		buttons: buttons.map(b => ctaCall(b.displayText, b.phoneNumber))
	});
}

async function sendPoll(sock, jid, { name, options, selectableOptionsCount = 1, quoted } = {}) {
	if (!name) throw new Error('sendPoll: name is required');
	if (!Array.isArray(options) || options.length < 2) {
		throw new Error('sendPoll: options must be an array of at least 2');
	}
	const msg = generateWAMessageFromContent(
		jid,
		{
			poll: {
				name,
				values: options,
				selectableCount: selectableOptionsCount
			}
		},
		{ quoted }
	);
	await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
	return msg.key;
}

async function sendRequestPhoneNumber(sock, jid, { quoted } = {}) {
	const msg = generateWAMessageFromContent(
		jid,
		{ requestPhoneNumberMessage: {} },
		{ quoted, userJid: sock.user?.id }
	);
	await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
	return msg.key;
}

async function sendFooterOnly(sock, jid, { text, footer = '', title = '', quoted, ai = false, mentions = [] } = {}) {
	if (!text) throw new Error('sendFooterOnly: text is required');
	const contextInfo = mentions.length ? { mentionedJid: mentions } : {};
	const msg = generateWAMessageFromContent(
		jid,
		{
			viewOnceMessage: {
				message: {
					messageContextInfo: {
						deviceListMetadata: {},
						deviceListMetadataVersion: 2
					},
					interactiveMessage: proto.Message.InteractiveMessage.create({
						header: proto.Message.InteractiveMessage.Header.create({
							title,
							hasMediaAttachment: false
						}),
						body: proto.Message.InteractiveMessage.Body.create({ text }),
						footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
						nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: [] }),
						...(mentions.length ? { contextInfo } : {})
					})
				}
			}
		},
		{ quoted, userJid: sock.user?.id }
	);
	await sock.relayMessage(jid, msg.message, {
		messageId: msg.key.id,
		additionalNodes: interactiveNodes(jid, ai)
	});
	return msg.key;
}

function getButtonReplyId(message) {
	try {
		const t = message?.templateButtonReplyMessage?.selectedId;
		if (t) return t;
		const r = message?.interactiveResponseMessage;
		if (!r) return null;
		const params = r?.nativeFlowResponseMessage?.paramsJson;
		if (params) return JSON.parse(params).id || null;
		return r?.singleSelectReply?.selectedRowId || null;
	} catch {
		return null;
	}
}

function getListReplyId(message) {
	try {
		return (
			message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
			message?.interactiveResponseMessage?.singleSelectReply?.selectedRowId ||
			null
		);
	} catch {
		return null;
	}
}

export {
	sendInteractive,
	sendButtons,
	sendUrlButtons,
	sendCopyButtons,
	sendCallButtons,
	sendList,
	sendInteractiveList,
	sendPoll,
	sendRequestPhoneNumber,
	sendFooterOnly,
	getButtonReplyId,
	getListReplyId,
	quickReply,
	ctaUrl,
	ctaCopy,
	ctaCall,
	singleSelectButton
};
