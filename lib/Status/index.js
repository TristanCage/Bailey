import { randomBytes } from 'crypto';

/**
 * Status / story posting helpers.
 */

export const STATUS_BACKGROUNDS = {
	solid: {
		green: '#25D366',
		blue: '#34B7F1',
		purple: '#8B5CF6',
		red: '#EF4444',
		orange: '#F97316',
		yellow: '#EAB308',
		pink: '#EC4899',
		teal: '#14B8A6',
		gray: '#6B7280',
		black: '#000000',
		white: '#FFFFFF'
	},
	gradient: {
		sunset: ['#F97316', '#EF4444'],
		ocean: ['#3B82F6', '#06B6D4'],
		forest: ['#22C55E', '#10B981'],
		purple: ['#8B5CF6', '#EC4899'],
		midnight: ['#1E3A8A', '#4C1D95'],
		aurora: ['#06B6D4', '#8B5CF6', '#EC4899']
	}
};

export const STATUS_FONTS = {
	SANS_SERIF: 0,
	SERIF: 1,
	NORICAN: 2,
	BRYNDAN: 3,
	BEBASNEUE: 4,
	OSWALD: 5,
	DAMION: 6,
	DANCING: 7,
	COMFORTAA: 8,
	EXOTWO: 9
};

export const STATUS_BROADCAST_JID = 'status@broadcast';

/** Generate a WhatsApp-style status message ID starting with 3EB0. */
export const generateStatusMessageId = () => `3EB0${randomBytes(16).toString('hex').toUpperCase()}`;

export const getStatusJid = () => STATUS_BROADCAST_JID;

/** Build text status content. */
export const createTextStatus = options => ({
	text: options.text,
	backgroundColor: options.backgroundColor || STATUS_BACKGROUNDS.solid.green,
	font: options.font ?? STATUS_FONTS.SANS_SERIF,
	textColor: options.textColor || '#FFFFFF',
	contextInfo: {
		mentionedJid: options.mentions || [],
		isForwarded: false
	}
});

export const createImageStatus = (media, options) => ({
	image: typeof media === 'string' ? { url: media } : media,
	caption: options?.caption || ''
});

export const createVideoStatus = (media, options) => ({
	video: typeof media === 'string' ? { url: media } : media,
	caption: options?.caption || '',
	gifPlayback: options?.gifPlayback || false
});

export const createAudioStatus = (media, options) => ({
	audio: typeof media === 'string' ? { url: media } : media,
	ptt: true,
	mimetype: 'audio/ogg; codecs=opus',
	waveform: options?.waveform
});

/**
 * Send a status. Group JIDs in the list become group-status posts; individual
 * JIDs become the status audience. An empty list posts to all contacts.
 * @param {object} sock socket instance
 * @param {object} content status content (see create*Status)
 * @param {string[]} [jidList] audience / groups
 * @param {{ backgroundColor?: string, font?: number }} [options]
 */
export const sendStatus = async (sock, content, jidList = [], options = {}) => {
	if (!jidList || jidList.length === 0) {
		console.warn('sendStatus: jidList is empty — status may be visible to all contacts');
	}
	const groups = jidList.filter(jid => jid && jid.endsWith('@g.us'));
	const individuals = jidList.filter(jid => jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')));
	let lastResult;

	if (groups.length) {
		for (const groupJid of groups) {
			if (typeof sock.sendGroupStatus === 'function') {
				lastResult = await sock.sendGroupStatus(groupJid, content, options);
			} else {
				lastResult = await sock.sendMessage(groupJid, { ...content, groupStatus: true }, { messageId: generateStatusMessageId() });
			}
		}
	}

	if (individuals.length > 0 || jidList.length === 0) {
		const result = await sock.sendMessage(STATUS_BROADCAST_JID, content, {
			statusJidList: individuals.length > 0 ? individuals : undefined,
			messageId: generateStatusMessageId()
		});
		if (!lastResult) lastResult = result;
	}
	return lastResult;
};

/** Convenience builders. */
export const StatusHelper = {
	text: (text, backgroundColor, font) => createTextStatus({ text, backgroundColor, font }),
	image: (buffer, caption) => createImageStatus(buffer, { caption }),
	imageUrl: (url, caption) => createImageStatus(url, { caption }),
	video: (buffer, caption) => createVideoStatus(buffer, { caption }),
	videoUrl: (url, caption) => createVideoStatus(url, { caption }),
	gif: (buffer, caption) => createVideoStatus(buffer, { caption, gifPlayback: true }),
	voiceNote: buffer => createAudioStatus(buffer),
	send: sendStatus
};
