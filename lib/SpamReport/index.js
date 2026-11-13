import {
	getBinaryNodeChild,
	getBinaryNodeChildString,
	isHostedLidUser,
	isJidGroup,
	isLidUser,
	isPnUser,
	jidNormalizedUser,
	S_WHATSAPP_NET
} from '../WABinary/index.js';
import { extractMessageContent } from '../Utils/messages.js';

/** Controls how WhatsApp routes the report internally. */
export const SPAM_FLOWS = {
	ACCOUNT_INFO_REPORT: 'account_info_report',
	ACCOUNT_INFO_BLOCK: 'account_info_block',
	GROUP_INFO_REPORT: 'group_info_report',
	CONTACT_INFO_REPORT: 'contact_info_report',
	ONE_TO_ONE_SPAM_BANNER_REPORT: '1_1_spam_banner_report',
	MESSAGE_MENU: 'message_menu',
	OVERFLOW_MENU_REPORT: 'overflow_menu_report'
};

/** Numeric reason codes for the w:report IQ endpoint. */
export const REPORT_REASON_CODES = { spam: 1, harassment: 2, impersonation: 3, scam: 4, other: 5 };

const toBuffer = data => {
	if (!data) return null;
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof Uint8Array) return Buffer.from(data);
	if (typeof data === 'string') return Buffer.from(data, 'base64');
	return null;
};

// ─── Reporting-info store (per socket) ──────────────────────────────────────

const stores = new WeakMap();

const createStore = () => {
	const map = new Map();
	return {
		add(jid, info) {
			if (!jid || !info?.reportingTag) return;
			const list = map.get(jid) || [];
			list.unshift(info);
			map.set(jid, list.slice(0, 20));
		},
		getForJid(jid, max = 5) {
			return (map.get(jid) || []).slice(0, max);
		},
		clear(jid) {
			map.delete(jid);
		}
	};
};

/** Get (or create) the reporting-info store attached to a socket. */
export const getReportingInfoStore = sock => {
	let store = stores.get(sock);
	if (!store) {
		store = createStore();
		stores.set(sock, store);
	}
	return store;
};

// ─── JID resolution ─────────────────────────────────────────────────────────

export const resolveReportJid = async (jid, lidMapping) => {
	if (!jid) throw new Error('resolveReportJid: jid required');
	if (isJidGroup(jid) || isLidUser(jid) || isHostedLidUser(jid)) return jid;
	const lid = lidMapping?.getLIDForPN ? await lidMapping.getLIDForPN(jid) : null;
	return lid ?? jid;
};

export const resolveReportContext = async (jid, lidMapping) => {
	if (!jid) throw new Error('resolveReportContext: jid required');
	if (isJidGroup(jid)) return { reportJid: jid, spamFlow: SPAM_FLOWS.GROUP_INFO_REPORT, isGroup: true };
	return { reportJid: await resolveReportJid(jid, lidMapping), spamFlow: SPAM_FLOWS.ACCOUNT_INFO_REPORT, isGroup: false };
};

// ─── Tag / text extraction ──────────────────────────────────────────────────

export const normalizeReportingTag = tag => {
	const buf = toBuffer(tag);
	return buf?.length ? buf : null;
};

export const extractMessageText = msg => {
	if (!msg?.message) return '';
	const c = extractMessageContent(msg.message);
	if (!c) return '';
	return c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? '';
};

/** Extract reporting tag info from a raw incoming binary stanza. */
export const extractReportingInfoFromStanza = stanza => {
	const reporting = getBinaryNodeChild(stanza, 'reporting');
	if (!reporting) return null;
	const tokenNode = getBinaryNodeChild(reporting, 'reporting_token');
	const tagNode =
		getBinaryNodeChild(reporting, 'reporting_tag') ||
		getBinaryNodeChild(getBinaryNodeChild(reporting, 'reporting_validation'), 'reporting_tag');
	if (!tagNode?.content) return null;
	const raw = tagNode.content;
	const reportingTag = toBuffer(raw instanceof Uint8Array || Buffer.isBuffer(raw) ? raw : typeof raw === 'string' ? raw : null);
	if (!reportingTag?.length) return null;
	const stanzaId = tagNode.attrs?.id || stanza.attrs?.id;
	if (!stanzaId) return null;
	const tsRaw = tagNode.attrs?.ts_s || stanza.attrs?.t;
	return {
		stanzaId,
		timestamp: tsRaw ? Number(tsRaw) : 0,
		reportingTag,
		reportingToken: tokenNode?.content ? toBuffer(tokenNode.content) : null,
		tokenVersion: tokenNode?.attrs?.v ? parseInt(tokenNode.attrs.v) : null,
		validationPolicy: reporting.attrs?.validation_policy || null
	};
};

/**
 * Capture reporting info from an incoming message so it can be reported later.
 * Call from the message pipeline (already wired in messages-recv).
 */
export const captureReportingInfo = (store, stanza, msg) => {
	const info = extractReportingInfoFromStanza(stanza);
	if (!info) return;
	const jid = stanza.attrs?.from;
	if (!jid) return;
	store.add(jid, {
		...info,
		text: extractMessageText(msg),
		pushName: stanza.attrs?.notify || msg?.pushName || '',
		messageType: stanza.attrs?.type || 'text',
		fromJid: jid
	});
};

// ─── Node builders ──────────────────────────────────────────────────────────

export const buildSpamReportMessageNodes = (messages, logger) => {
	const ts = () => Math.floor(Date.now() / 1000);
	const nodes = messages.slice(0, 5).reduce((acc, m) => {
		const reportingTag = normalizeReportingTag(m.reportingTag);
		if (!reportingTag) {
			logger?.warn?.({ stanzaId: m.stanzaId }, 'buildSpamReportMessageNodes: skipping — missing reportingTag');
			return acc;
		}
		const t = String(m.timestamp || ts());
		acc.push({
			tag: 'message',
			attrs: { t, id: m.stanzaId, reported_push_name: m.pushName || '', type: m.messageType || 'text', from: m.fromJid },
			content: [
				{ tag: 'raw', attrs: { local_message_type: '0', v: '2' }, content: m.text != null ? String(m.text) : '' },
				{
					tag: 'reporting',
					attrs: {},
					content: [{
						tag: 'reporting_validation',
						attrs: {},
						content: [{ tag: 'reporting_tag', attrs: { id: m.stanzaId, ts_s: t }, content: reportingTag }]
					}]
				}
			]
		});
		return acc;
	}, []);
	if (!nodes.length) {
		logger?.error?.({}, 'buildSpamReportMessageNodes: all messages filtered — none had a valid reportingTag');
		throw new Error('reportSpam: no valid messages with reportingTag after filtering');
	}
	return nodes;
};

export const buildSpamReportIq = (jid, messages, spamFlow = SPAM_FLOWS.ACCOUNT_INFO_REPORT, logger) => {
	if (!messages?.length) {
		logger?.error?.({ jid, spamFlow }, 'buildSpamReportIq: called with empty messages array');
		throw new Error('reportSpam: at least one message with reporting_tag required');
	}
	return {
		tag: 'iq',
		attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
		content: [{ tag: 'spam_list', attrs: { jid, spam_flow: spamFlow }, content: buildSpamReportMessageNodes(messages, logger) }]
	};
};

export const buildSimpleReportNode = (jid, messageKeys) => ({
	tag: 'report',
	attrs: { jid, type: 'spam' },
	content: (messageKeys || []).map(key => ({
		tag: 'message',
		attrs: { id: key.id || key, ...(key.fromMe ? {} : { from: jid }) }
	}))
});

export const parseSpamReportResponse = result => {
	if (!result) return { success: false, error: 'empty response' };
	if (result.attrs?.type === 'error') {
		const errNode = getBinaryNodeChild(result, 'error');
		const code = errNode?.attrs?.code;
		const text = errNode?.content?.toString?.() || errNode?.attrs?.text;
		return { success: false, error: `spam IQ error${code ? ` ${code}` : ''}${text ? `: ${text}` : ''}` };
	}
	const reportNode = getBinaryNodeChild(result, 'report');
	const reportId = reportNode?.attrs?.id || getBinaryNodeChildString(reportNode, 'id');
	if (reportId) return { success: true, reportId: String(reportId) };
	if (result.attrs?.type === 'result') return { success: true };
	return { success: false, error: 'unexpected spam IQ response' };
};

// ─── Socket API ─────────────────────────────────────────────────────────────

const resolveToPN = async (sock, jid) => {
	if (!isLidUser(jid)) return jidNormalizedUser(jid);
	const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
	if (!pn) {
		sock.logger?.error?.({ jid }, 'resolveToPN: could not resolve LID to PN');
		throw new Error(`resolveToPN: no PN found for LID ${jid}`);
	}
	return jidNormalizedUser(pn);
};

const wReportQuery = async (sock, node, label, meta, waitForAckMs = 5000) => {
	try {
		await sock.query(node, waitForAckMs);
		sock.logger?.info?.(meta, `${label} (ack received)`);
		return true;
	} catch (err) {
		const code = err?.output?.statusCode || err?.statusCode;
		if (code === 408 || err?.message?.toLowerCase?.().includes('timed out')) {
			sock.logger?.warn?.(meta, `${label} (no ack; request likely sent)`);
			return false;
		}
		throw err;
	}
};

/** Report a chat using stored reporting tags. */
export const reportSpam = async (sock, jid, options = {}) => {
	const { spamFlow: manualFlow, messages: manualMessages, maxMessages = 5 } = options;
	const store = getReportingInfoStore(sock);
	const { reportJid, spamFlow: autoFlow, isGroup } = await resolveReportContext(jid, sock.signalRepository?.lidMapping);
	const spamFlow = manualFlow ?? autoFlow;
	let messages = manualMessages;
	if (!messages?.length) {
		messages = store.getForJid(reportJid, maxMessages);
		if (!messages.length && !isGroup) {
			messages = store.getForJid(jid, maxMessages);
		}
	}
	if (!messages?.length) {
		throw new Error(`reportSpam: no reporting_tag stored for ${jid}`);
	}
	const normalized = messages.slice(0, maxMessages).map(m => ({
		stanzaId: m.stanzaId || m.id,
		timestamp: Number(m.timestamp || m.sendTimestamp || m.t) || Math.floor(Date.now() / 1000),
		reportingTag: m.reportingTag || m.tag,
		text: m.text != null ? String(m.text) : m.raw != null ? String(m.raw) : '',
		pushName: m.pushName || m.reportedPushName || '',
		messageType: m.messageType || m.type || 'text',
		fromJid: m.fromJid || m.from || reportJid
	}));
	const result = await sock.query(buildSpamReportIq(reportJid, normalized, spamFlow, sock.logger));
	return { ...parseSpamReportResponse(result), messageCount: normalized.length };
};

const simpleReportQuery = (sock, jid, messageKeys) =>
	sock.query({
		tag: 'iq',
		attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
		content: [buildSimpleReportNode(jid, messageKeys)]
	});

export const reportContact = async (sock, jid, messageKeys = []) => {
	if (!isPnUser(jid) && !isLidUser(jid)) {
		throw new Error('reportContact requires a valid contact JID');
	}
	const pnJid = await resolveToPN(sock, jid);
	return parseSpamReportResponse(await simpleReportQuery(sock, pnJid, messageKeys));
};

export const reportGroup = async (sock, jid, messageKeys = []) => {
	if (!isJidGroup(jid)) {
		throw new Error('reportGroup requires a valid group JID');
	}
	const parsed = parseSpamReportResponse(await simpleReportQuery(sock, jid, messageKeys));
	if (parsed.success) {
		try {
			await sock.query({
				tag: 'iq',
				attrs: { type: 'set', xmlns: 'w:g2', to: '@g.us' },
				content: [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id: jid } }] }]
			});
		} catch (err) {
			sock.logger?.warn?.({ jid, err: err?.message }, 'reportGroup: leave failed after successful report');
		}
	}
	return parsed;
};

export const reportUser = async (sock, jid, reason = 'spam', waitForAckMs = 5000) => {
	const pnJid = await resolveToPN(sock, jid);
	return wReportQuery(
		sock,
		{
			tag: 'iq',
			attrs: { id: sock.generateMessageTag(), xmlns: 'w:report', to: 's.whatsapp.net', type: 'set' },
			content: [{ tag: 'user', attrs: { jid: pnJid, reason: String(REPORT_REASON_CODES[reason] ?? 1) } }]
		},
		'reported user',
		{ jid: pnJid, reason },
		waitForAckMs
	);
};

export const reportMessage = async (sock, jid, messageId, reason = 'spam', participantJid, waitForAckMs = 5000) => {
	const pnJid = await resolveToPN(sock, jid);
	const participant = participantJid ? await resolveToPN(sock, participantJid) : undefined;
	const attrs = { id: String(messageId), reason: String(REPORT_REASON_CODES[reason] ?? 1), ...(participant ? { participant } : {}) };
	return wReportQuery(
		sock,
		{
			tag: 'iq',
			attrs: { id: sock.generateMessageTag(), xmlns: 'w:report', to: 's.whatsapp.net', type: 'set' },
			content: [{ tag: 'message', attrs }]
		},
		'reported message',
		{ jid: pnJid, messageId, reason, participant },
		waitForAckMs
	);
};

export const reportAndBlockUser = async (sock, jid, reason = 'spam', options = {}) => {
	const { waitForAckMs = 5000, maxAttempts = 4, delayMs = 1500 } = options;
	const pnJid = await resolveToPN(sock, jid);
	let attempts = 0;
	while (attempts < maxAttempts) {
		await reportUser(sock, pnJid, reason, waitForAckMs);
		attempts++;
		await new Promise(resolve => setTimeout(resolve, delayMs));
	}
	return { attempts };
};
