import { isHostedLidUser, isHostedPnUser, isLidUser, jidDecode, jidNormalizedUser } from '../WABinary/index.js';



const isPnJid = jid => !!jid?.endsWith('@s.whatsapp.net') || isHostedPnUser(jid);


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


export const isSelf = (jid, senderPn) => {
	if (!jid || !senderPn) return false;
	const normalized = jidNormalizedUser(jid);
	if (normalized === jidNormalizedUser(senderPn.phoneJid)) return true;
	if (senderPn.lid && normalized === jidNormalizedUser(senderPn.lid)) return true;
	return false;
};


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


export const normalizePhoneToJid = phone => {
	const value = String(phone);
	if (value.includes('@')) return jidNormalizedUser(value);
	return `${value.replace(/[^\d@]/g, '')}@s.whatsapp.net`;
};


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


export const isSameUser = (jid1, jid2) => {
	const info1 = parseJid(jid1);
	const info2 = parseJid(jid2);
	return !!info1 && !!info2 && info1.normalizedUser === info2.normalizedUser;
};


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


export const getRemoteJidFromMessage = msg => {
	const chatJid = msg?.key?.remoteJid;
	if (!chatJid) return null;
	const isGroupMsg = chatJid.endsWith('@g.us');
	return { chatJid, senderJid: isGroupMsg ? msg.key.participant || chatJid : chatJid };
};


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
