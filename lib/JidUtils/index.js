import { isHostedLidUser, isHostedPnUser, isLidUser, jidDecode, jidNormalizedUser } from '../WABinary/index.js';

/**
 * JID inspection and conversion helpers (PN ↔ LID variants, device IDs).
 */

const isPnJid = jid => !!jid?.endsWith('@s.whatsapp.net') || isHostedPnUser(jid);

/** Parse a JID into its components and flags. */
export const parseJid = jid => {
	if (!jid) return null;
	const decoded = jidDecode(jid);
	if (!decoded) return null;
	return {
		jid,
		user: decoded.user,
		server: decoded.server,
		device: decoded.device || 0,
		isLid: !!(isLidUser(jid) || isHostedLidUser(jid)),
		isPn: isPnJid(jid),
		isHosted: jid.includes('@hosted') || isHostedLidUser(jid) || isHostedPnUser(jid),
		isGroup: jid.endsWith('@g.us'),
		isNewsletter: jid.endsWith('@newsletter'),
		normalizedUser: jidNormalizedUser(jid)
	};
};

/** Current session phone-number info from creds. */
export const getSenderPn = creds => {
	if (!creds?.me?.id) return null;
	const decoded = jidDecode(creds.me.id);
	if (!decoded) return null;
	return {
		phoneJid: `${decoded.user}@s.whatsapp.net`,
		phoneNumber: decoded.user,
		lid: creds.me.lid || undefined,
		deviceId: decoded.device || 0,
		pushName: creds.me.name,
		platform: creds.platform
	};
};

export const getCurrentSenderInfo = authState => getSenderPn(authState?.creds);

/** True when the JID belongs to the current account (PN or LID). */
export const isSelf = (jid, senderPn) => {
	if (!jid || !senderPn) return false;
	const normalized = jidNormalizedUser(jid);
	if (normalized === jidNormalizedUser(senderPn.phoneJid)) return true;
	if (senderPn.lid && normalized === jidNormalizedUser(senderPn.lid)) return true;
	return false;
};

/** Parse a JID and label its PN/LID form without any mapping lookup. */
export const plotJid = jid => {
	const info = parseJid(jid);
	if (!info) return null;
	const result = { original: jid, primary: jid, info };
	if (info.isPn) {
		result.pn = info.normalizedUser;
		result.primary = info.normalizedUser;
	} else if (info.isLid) {
		result.lid = info.normalizedUser;
		result.primary = info.normalizedUser;
	}
	return result;
};

/** Normalize a phone number (or JID) to a valid WhatsApp JID. */
export const normalizePhoneToJid = phone => {
	const value = String(phone);
	if (value.includes('@')) return jidNormalizedUser(value);
	return `${value.replace(/[^\d@]/g, '')}@s.whatsapp.net`;
};

/** Extract the phone number from a PN JID (null for groups/LIDs). */
export const extractPhoneNumber = jid => {
	const info = parseJid(jid);
	return info?.isPn ? info.user : null;
};

export const formatJidDisplay = (jid, options = {}) => {
	const info = parseJid(jid);
	if (!info) return jid;
	let display = info.user;
	if (options.showDevice && info.device > 0) display += `:${info.device}`;
	if (options.showType) {
		if (info.isLid) display += ' (LID)';
		else if (info.isGroup) display += ' (Group)';
		else if (info.isNewsletter) display += ' (Newsletter)';
		else if (info.isPn) display += ' (PN)';
	}
	return display;
};

/** Compare two JIDs by normalized user (does not map LID↔PN). */
export const isSameUser = (jid1, jid2) => {
	const info1 = parseJid(jid1);
	const info2 = parseJid(jid2);
	return !!info1 && !!info2 && info1.normalizedUser === info2.normalizedUser;
};

/** Common JID variants for a phone number. */
export const getJidVariants = phone => {
	const cleaned = String(phone).replace(/[^\d]/g, '');
	return [
		`${cleaned}@s.whatsapp.net`,
		`${cleaned}:0@s.whatsapp.net`,
		`${cleaned}@lid`,
		`${cleaned}:1@s.whatsapp.net`,
		`${cleaned}:2@s.whatsapp.net`
	];
};

export const constructJidWithDevice = (user, device, server = 's.whatsapp.net') =>
	device === 0 ? `${user}@${server}` : `${user}:${device}@${server}`;

/** Chat JID + sender JID from a message key. */
export const getRemoteJidFromMessage = msg => {
	const chatJid = msg?.key?.remoteJid;
	if (!chatJid) return null;
	const isGroupMsg = chatJid.endsWith('@g.us');
	return { chatJid, senderJid: isGroupMsg ? msg.key.participant || chatJid : chatJid };
};

/** Create a plotter that resolves LID ↔ PN via the mapping store. */
export const createJidPlotter = (getLIDForPN, getPNForLID) => ({
	plotToLid: pn => getLIDForPN(pn),
	plotToPn: lid => getPNForLID(lid),
	plotBidirectional: async jid => {
		const info = parseJid(jid);
		const result = { original: jid, primary: jid, info };
		if (!info) return result;
		if (info.isPn) {
			result.pn = info.normalizedUser;
			const lid = await getLIDForPN(jid);
			if (lid) result.lid = lid;
			result.primary = info.normalizedUser;
		} else if (info.isLid) {
			result.lid = info.normalizedUser;
			const pn = await getPNForLID(jid);
			if (pn) result.pn = pn;
			result.primary = result.pn || info.normalizedUser;
		}
		return result;
	}
});
