import crypto from 'crypto';
import { generateWAMessageFromContent } from '../Utils/messages.js';

/**
 * AI grid / stack media layouts built as rich responses.
 * Ported from @zervonex/baileys (MIT, nexustechpro2) with attribution.
 */

const BOT_RENDERING_CONFIG_METADATA = {
	bloksVersioningId: '6e955f4ffe31e9c45cd7702090f9b02107f6ef04bbbae6062a2d9c9b99e03f05',
	pixelDensity: 2.75
};

const BOT_CONTEXT_INFO = {
	isForwarded: true,
	forwardingScore: 1,
	forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
	forwardOrigin: 4
};

const richBizNode = () => ({
	tag: 'biz',
	attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: String(Math.floor(Date.now() / 1000)) },
	content: [{
		tag: 'quality_control',
		attrs: { decision_id: crypto.randomBytes(20).toString('hex'), source_type: 'third_party' },
		content: [{ tag: 'decision_source', attrs: { value: 'df' } }]
	}]
});

const buildRichContent = (unified, submessages = []) => ({
	messageContextInfo: {
		botMetadata: {
			pluginMetadata: {},
			botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA
		}
	},
	botForwardedMessage: {
		message: {
			richResponseMessage: {
				messageType: 1,
				submessages,
				unifiedResponse: { data: Buffer.from(JSON.stringify(unified)) },
				contextInfo: BOT_CONTEXT_INFO
			}
		}
	}
});

const sendRich = async (sock, jid, content, quoted) => {
	const wrapped = generateWAMessageFromContent(jid, content, {
		quoted,
		userJid: sock.user?.id,
		upload: sock.waUploadToServer
	});
	await sock.relayMessage(jid, wrapped.message, {
		messageId: wrapped.key.id,
		additionalNodes: [richBizNode()]
	});
	return wrapped;
};

const imageMedia = (url, image, width, height) => {
	const expiration = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
	const media = (mediaUrl, w, h) => ({
		url: mediaUrl,
		url_fallback: mediaUrl,
		mime_type: image?.mimeType ?? image?.mime_type ?? 'image/png',
		expiration_timestamp_ms: expiration,
		width: w,
		height: h
	});
	return {
		preview_image: media(url, width, height),
		full_image: media(image?.highResUrl ?? url, width, height),
		dark_mode_preview_image: media(image?.darkModePreviewUrl ?? url, width, height),
		dark_mode_full_image: media(image?.darkModeHighResUrl ?? url, width, height),
		asset_query_status: 'FETCHED'
	};
};

/**
 * Vertical stack of images/videos (GenAI "imagine" layout).
 * @param {object} sock socket instance
 * @param {string} jid target JID
 * @param {Array<object|string>} items [{ image|video, url, mimeType, width, height }] (min 2)
 */
export const sendVerticalAlbum = async (sock, jid, items, options = {}) => {
	if (!Array.isArray(items) || items.length < 2) throw new Error('VerticalAlbum requires at least 2 items');
	const primitives = items.map((item, i) => {
		const kind = item?.type || (item?.video ? 'video' : 'image');
		if (kind === 'video') {
			const video = item.video || item.data || item;
			const url = typeof video === 'string' ? video : video?.url ?? video?.videoUrl ?? '';
			if (!url) throw new Error(`VerticalAlbum item ${i}: video requires a URL`);
			return {
				media: {
					url,
					mime_type: video?.mimeType ?? video?.mime_type ?? 'video/mp4',
					file_length: video?.fileLength ?? video?.file_length ?? 0,
					duration: video?.duration ?? 0
				},
				imagine_type: 'ANIMATE',
				status: { status: 'READY' },
				__typename: 'GenAIImaginePrimitive',
				...(video?.thumbnail ? { thumbnail: { raw_media: video.thumbnail } } : {})
			};
		}
		const image = item?.image || item?.data || item;
		const url = typeof image === 'string'
			? image
			: image?.imageHighResUrl ?? image?.highResUrl ?? image?.fullUrl ?? image?.imagePreviewUrl ?? image?.previewUrl ?? image?.url ?? '';
		if (!url) throw new Error(`VerticalAlbum item ${i}: image requires a URL`);
		const width = Number(image?.width ?? 600);
		const height = Number(image?.height ?? 400);
		return { ...imageMedia(url, image, width, height), display_mode: 'FULL_WIDTH', full_width: true, __typename: 'GenAIImagePrimitive' };
	});
	const unified = {
		response_id: crypto.randomUUID(),
		sections: [{
			view_model: {
				primitives,
				display_mode: 'FULL_WIDTH',
				full_width: true,
				__typename: 'GenAIVStackLayoutViewModel'
			}
		}]
	};
	return sendRich(sock, jid, buildRichContent(unified), options.quoted);
};

/**
 * Grid of images (GenAI grid layout).
 * @param {object} sock socket instance
 * @param {string} jid target JID
 * @param {Array<object|string>} images [{ url, width, height, mimeType }] (min 2)
 */
export const sendGridImage = async (sock, jid, images, options = {}) => {
	if (!Array.isArray(images) || images.length < 2) throw new Error('GridImage requires at least 2 images');
	const imageUrls = images.map(image => {
		const normalized = typeof image === 'string' ? { url: image } : image;
		const url = normalized.imageHighResUrl ?? normalized.highResUrl ?? normalized.fullUrl ?? normalized.imagePreviewUrl ?? normalized.previewUrl ?? normalized.url ?? '';
		return { imagePreviewUrl: url, imageHighResUrl: normalized.highResUrl ?? url, sourceUrl: url };
	});
	const submessages = [{ messageType: 6, gridImageMetadata: { imageUrls } }];
	const sections = images.map(image => {
		const normalized = typeof image === 'string' ? { url: image } : image;
		const url = normalized.imageHighResUrl ?? normalized.highResUrl ?? normalized.fullUrl ?? normalized.imagePreviewUrl ?? normalized.previewUrl ?? normalized.url ?? '';
		return { ...imageMedia(url, normalized, Number(normalized.width ?? 600), Number(normalized.height ?? 400)), __typename: 'GenAIImagePrimitive' };
	});
	const unified = {
		response_id: crypto.randomUUID(),
		sections: [{ view_model: { primitives: sections, __typename: 'GenAIGridLayoutViewModel' } }]
	};
	return sendRich(sock, jid, buildRichContent(unified, submessages), options.quoted);
};

/**
 * Grid of videos / reels.
 * @param {object} sock socket instance
 * @param {string} jid target JID
 * @param {Array<object|string>} videos [{ url, title, thumbnailUrl, creator, ... }] (min 2)
 */
export const sendVideoGrid = async (sock, jid, videos, options = {}) => {
	if (!Array.isArray(videos) || videos.length < 2) throw new Error('VideoGrid requires at least 2 videos');
	const primitives = videos.map((video, i) => {
		const item = typeof video === 'string' ? {} : video;
		const url = typeof video === 'string' ? video : video?.url ?? video?.videoUrl ?? video?.reelsUrl ?? '';
		if (!url) throw new Error(`VideoGrid item ${i}: requires a URL`);
		return {
			post_id: item.postId != null ? String(item.postId) : undefined,
			reels_url: url,
			reels_title: item.title,
			thumbnail_url: item.thumbnailUrl ?? item.thumbnail,
			creator: item.creator,
			avatar_url: item.avatarUrl,
			content_hash: item.contentHash,
			likes_count: item.likes,
			comments_count: item.comments,
			shares_count: item.shares,
			is_verified: item.isVerified,
			source_app: item.sourceApp,
			video_delivery_response: {
				progressive_urls: (item.progressiveUrls ?? []).map(u => ({ progressive_url: u, __typename: 'GenAIProgressiveUrlResponse' })),
				dash_manifests: (item.dashManifests ?? []).map(m => ({ manifest_xml: m, __typename: 'GenAIDashManifestResponse' })),
				__typename: 'GenAIVideoDeliveryResponse'
			},
			__typename: 'GenAIVideoPrimitive'
		};
	});
	const unified = {
		response_id: crypto.randomUUID(),
		sections: [{ view_model: { primitives, __typename: 'GenAIGridLayoutViewModel' } }]
	};
	return sendRich(sock, jid, buildRichContent(unified), options.quoted);
};
