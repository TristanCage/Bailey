import crypto from 'crypto';
import { proto } from '../../WAProto/index.js';
import { generateWAMessageFromContent } from '../Utils/messages.js';
import { tokenizeCode } from './index.js';

/**
 * Advanced AI rich-response layout primitives (images, reels, posts, products,
 * maps, GIFs, social profiles, menu widgets). Ported from @zervonex/baileys
 * (MIT, nexustechpro2) with attribution.
 */

const section = viewModel => ({ __typename: 'GenAIUnifiedResponseSection', view_model: viewModel });
const single = primitive => section({ __typename: 'GenAISingleLayoutViewModel', primitive });
const vstack = primitives => section({ __typename: 'GenAIVStackLayoutViewModel', primitives });
const hscroll = primitives => section({ __typename: 'GenAIHScrollLayoutViewModel', primitives });
const grid = primitives => section({ __typename: 'GenAIGridLayoutViewModel', primitives });
const actionRow = primitives => section({ __typename: 'GenAIActionRowLayoutViewModel', primitives });
const addonAction = (type, primitives, alignment = 'END') =>
	section({ __typename: 'GenAIAddonActionLayoutViewModel', addon_action_type: type, addon_action_alignment: alignment, primitives });

const markdownText = (text, inlineEntities = []) => ({
	__typename: 'GenAIMarkdownTextUXPrimitive',
	text,
	inline_entities: inlineEntities
});

export const richMarkdown = (text, entities = []) => single(markdownText(text, entities));

export const richCode = (content, language = '', unifiedCodeBlock = []) =>
	single({
		__typename: 'GenAICodeUXPrimitive',
		language,
		code_blocks: unifiedCodeBlock.length ? unifiedCodeBlock : tokenizeCode(content, language)
	});

export const richTable = (rows, title = '') => {
	if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('richTable requires a non-empty rows array');
	const firstRow = Array.isArray(rows[0]) ? rows[0] : rows[0].cells ?? rows[0].items ?? [];
	if (firstRow.length > 200) throw new RangeError('richTable: too many columns (max 200)');
	if (rows.length * firstRow.length > 100000) throw new RangeError('richTable: too many cells (max 100000)');
	const normalized = Array.isArray(rows[0])
		? rows.map((row, index) => ({ is_header: index === 0, cells: row.map(String), markdown_cells: row.map(cell => ({ text: String(cell) })) }))
		: rows.map(row => ({
				is_header: !!row.is_header,
				cells: (row.cells ?? row.items ?? []).map(String),
				markdown_cells: (row.cells ?? row.items ?? []).map(cell => ({ text: String(cell) }))
			}));
	return single({ __typename: 'GenAITableUXPrimitive', title, rows: normalized });
};

export const richImage = (input, expiration) => {
	const image = typeof input === 'string' ? { url: input } : input;
	const exp = expiration ?? String(Date.now() + 30 * 24 * 60 * 60 * 1000);
	const first = (...values) => values.find(value => value != null && String(value).length > 0);
	const previewUrl = first(image.previewUrl, image.preview_url, image.imagePreviewUrl, image.url) ?? '';
	const fullUrl = first(image.highResUrl, image.high_res_url, image.imageHighResUrl, image.fullUrl, image.full_url, image.url, previewUrl);
	const darkPreview = first(image.darkModePreviewUrl, image.dark_mode_preview_url, previewUrl);
	const darkFull = first(image.darkModeHighResUrl, image.dark_mode_high_res_url, darkPreview);
	const mime = image.mimeType ?? image.mime_type ?? (/\.png$/i.test(image.url ?? '') ? 'image/png' : 'image/jpeg');
	const width = Number(image.width ?? 600);
	const height = Number(image.height ?? 400);
	const media = (url, w, h) => ({ url, url_fallback: url, mime_type: mime, expiration_timestamp_ms: exp, width: w, height: h });
	return single({
		__typename: 'GenAIImagePrimitive',
		preview_image: media(previewUrl, width, height),
		full_image: media(fullUrl, width, height),
		dark_mode_preview_image: media(darkPreview, width, height),
		dark_mode_full_image: media(darkFull, width, height),
		asset_query_status: 'FETCHED'
	});
};

export const richInlineImage = (url, alignment = 'center') =>
	single({ __typename: 'GenAIInlineImageUXPrimitive', image: { __typename: 'GenAIMediaItem', mime_type: 'image/jpeg', url }, alignment });

export const richInlineLink = (links = []) => {
	let text = '';
	const entities = [];
	links.forEach((link, index) => {
		const key = `INLINE_HYPERLINK_${index}`;
		const display = link.text || link.displayName || link.url || '';
		text += `{{${key}}}${display}{{/${key}}}`;
		entities.push({
			key,
			metadata: { display_name: display, is_trusted: link.isTrusted !== false, url: link.url || '', __typename: 'GenAIInlineLinkItem' }
		});
	});
	return single(markdownText(text, entities));
};

export const richVideo = url => single({ __typename: 'GenAIVideoPrimitive', media: { __typename: 'GenAIMediaItem', mime_type: 'video/mp4', url } });

export const richReel = data =>
	single({
		__typename: 'GenAIReelPrimitive',
		creator: data.creator ?? '',
		avatar_url: data.avatar_url ?? '',
		thumbnail_url: data.thumbnail_url ?? '',
		reels_url: data.reels_url ?? '',
		reels_title: data.title ?? '',
		likes_count: data.likes_count ?? 0,
		shares_count: data.shares_count ?? 0,
		view_count: data.view_count ?? 0,
		reel_source: data.reel_source ?? 'IG',
		is_verified: !!data.is_verified
	});

export const richPost = data =>
	single({
		__typename: 'GenAIPostPrimitive',
		title: data.title ?? '',
		username: data.username ?? '',
		subtitle: data.subtitle ?? '',
		thumbnail_url: data.thumbnail_url ?? '',
		post_url: data.post_url ?? data.url ?? '',
		post_caption: data.post_caption ?? data.caption ?? '',
		post_type: data.post_type ?? 'photo',
		source_app: data.source_app ?? 'instagram',
		likes_count: data.likes_count ?? 0,
		comments_count: data.comments_count ?? 0,
		shares_count: data.shares_count ?? 0,
		is_verified: data.is_verified ?? false,
		is_carousel: data.is_carousel ?? false,
		orientation: data.orientation ?? 'portrait',
		profile_picture_url: data.profile_picture_url ?? null,
		footer_label: data.footer_label ?? null,
		footer_icon: data.footer_icon ?? null,
		additional_images: data.additional_images ?? []
	});

export const richProduct = data =>
	single({
		__typename: 'GenAIProductItemCardPrimitive',
		title: data.title ?? '',
		brand: data.brand ?? '',
		price: data.price ?? '',
		sale_price: data.sale_price ?? null,
		product_url: data.product_url ?? data.url ?? '',
		image: { url: data.image_url ?? data.image ?? '' },
		additional_images: []
	});

export const richSearchResult = data =>
	single({
		__typename: 'GenAISearchResultPrimitive',
		source_url: data.url ?? data.source_url ?? '',
		source_display_name: data.title ?? data.source_display_name ?? '',
		source_type: data.source_type ?? 'web',
		source_subtitle: data.subtitle ?? data.source_subtitle ?? '',
		favicon: data.favicon ?? null
	});

export const richMapPrimitive = data =>
	single({
		__typename: 'GenAIMapPrimitive',
		latitude: data.latitude,
		longitude: data.longitude,
		name: data.name ?? '',
		address: data.address ?? ''
	});

/** Map primitive plus the protobuf submessage needed for the map card. */
export const richMap = data => {
	const { centerLatitude, centerLongitude, latitudeDelta, longitudeDelta, annotations = [], showInfoList = false } = data;
	if (centerLatitude == null || centerLongitude == null) throw new TypeError('richMap requires centerLatitude and centerLongitude');
	const submessage = {
		messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_MAP,
		mapMetadata: {
			centerLatitude,
			centerLongitude,
			...(latitudeDelta != null ? { latitudeDelta } : {}),
			...(longitudeDelta != null ? { longitudeDelta } : {}),
			showInfoList: !!showInfoList,
			annotations: annotations.map((annotation, index) => ({
				annotationNumber: annotation.annotationNumber ?? index + 1,
				latitude: annotation.latitude,
				longitude: annotation.longitude,
				title: annotation.title ?? '',
				body: annotation.body ?? ''
			}))
		}
	};
	const display = annotations[0] ?? {};
	return {
		submessage,
		section: richMapPrimitive({
			latitude: display.latitude ?? centerLatitude,
			longitude: display.longitude ?? centerLongitude,
			name: display.title,
			address: display.body
		})
	};
};

export const richDynamic = ({ url, type = 'GIF', version, loopCount } = {}) => {
	if (!url) throw new TypeError('richDynamic requires a url');
	const isImage = String(type).toUpperCase() === 'IMAGE';
	const dynamicType = isImage
		? proto.AIRichResponseDynamicMetadata.AIRichResponseDynamicMetadataType.AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_IMAGE
		: proto.AIRichResponseDynamicMetadata.AIRichResponseDynamicMetadataType.AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_GIF;
	const submessage = {
		messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_DYNAMIC,
		dynamicMetadata: { type: dynamicType, url, ...(version != null ? { version } : {}), ...(loopCount != null ? { loopCount } : {}) }
	};
	return {
		submessage,
		section: single({
			__typename: 'GenAIDynamicMediaPrimitive',
			url,
			mime_type: isImage ? 'image/jpeg' : 'image/gif',
			...(loopCount != null ? { loop_count: loopCount } : {})
		})
	};
};

export const richWidget = (actions, title = '') =>
	single({
		__typename: 'GenAI3PExtWidgetPrimitive',
		header: { __typename: 'GenAI3PExtWidgetStandardHeader', title },
		body: {
			__typename: 'GenAI3PExtCalendarEventList',
			ctas: actions.map(action => ({
				__typename: 'GenAI3PExtWidgetCTA',
				label: action.label,
				state: 'PENDING',
				kind: action.kind ?? 'OTHER',
				tool_call_id: action.tool_call_id ?? action.id ?? crypto.randomBytes(8).toString('hex'),
				toast: { __typename: 'GenAI3PExtWidgetToast', label: action.toast ?? '' }
			})),
			sections: []
		}
	});

export const richFooterAction = data =>
	single({
		__typename: 'GenAIFooterActionPrimitive',
		cta_text: data.cta_text ?? data.text ?? '',
		cta_type: data.cta_type ?? 'OPEN_URL',
		cta_url: data.cta_url ?? data.url ?? ''
	});

export const richSocialProfile = ({
	username = '',
	platform = 'GENERIC',
	title = '',
	subtitle = '',
	imageUrl = '',
	entityId,
	entityUrl,
	entityType,
	fullName = '',
	isVerified = false,
	resultText = 'See results'
}) => {
	if (!username) throw new TypeError('richSocialProfile requires a username');
	const normalizedPlatform = String(platform).toUpperCase();
	const profileUrl = entityUrl ?? `https://www.${platform.toLowerCase()}.com/${encodeURIComponent(username)}`;
	const resolvedType = entityType ?? (normalizedPlatform === 'INSTAGRAM' ? 'IG_PROFILE' : 'SOCIAL_PROFILE');
	const image = imageUrl ? { url: imageUrl, mime_type: 'image/png' } : undefined;
	return [
		single({
			__typename: 'GenAICompactEntityPrimitive',
			title,
			subtitle,
			...(image ? { image } : {}),
			entity_id: String(entityId ?? username),
			entity_url: profileUrl,
			entity_type: 'WEBSITE',
			action_type: 'OPEN_URL',
			is_verified: !!isVerified
		}),
		section({
			__typename: 'GenAIVStackLayoutViewModel',
			primitives: [{ type: 'HORIZONTAL_LINE', __typename: 'GenAIDividerPrimitive' }]
		}),
		single({
			__typename: 'GenAISpacerPrimitive'
		}),
		single(
			markdownText(`# {{social_entity_1}}${resultText}\0{{/social_entity_1}}    `, [
				{
					key: 'social_entity_1',
					metadata: {
						__typename: 'GenAISocialEntityItem',
						entity_id: String(entityId ?? username),
						entity_name: username,
						entity_full_name: fullName,
						platform: normalizedPlatform,
						entity_picture_url: imageUrl,
						entity_url: profileUrl,
						entity_type: resolvedType,
						is_verified: !!isVerified
					}
				}
			])
		),
		single({ __typename: 'GenAISpacerPrimitive' })
	];
};

export const richMenu = ({ header = {}, body = {}, footer = {} }) => {
	const sections = [];
	if (header?.title) sections.push(single({ __typename: 'FOATextPrimitive', text: '# ' + header.title }));
	if (header?.image?.url) {
		sections.push(header.image.inline ? richInlineImage(header.image.url) : richImage(header.image));
	}
	const cards = Array.isArray(body?.cards) ? body.cards : [];
	const buttons = Array.isArray(body?.buttons) ? body.buttons : [];
	if (cards.length) {
		sections.push(
			section({
				__typename: body.carousel ? 'GenAIHScrollLayoutViewModel' : 'GenAIActionRowLayoutViewModel',
				primitives: cards.map(card => richWidget(Array.isArray(card?.buttons) ? card.buttons : [], card?.title || '').view_model.primitive)
			})
		);
	} else if (buttons.length) {
		sections.push(richWidget(buttons, body.title || ''));
	}
	if (footer?.text || footer?.url) {
		sections.push(actionRow([richFooterAction(footer).view_model.primitive]));
	}
	return sections;
};

/**
 * Fluent builder for advanced rich layouts.
 */
export class RichLayout {
	constructor() {
		this.sections = [];
		this.submessages = [];
	}

	add(richItem) {
		if (Array.isArray(richItem)) {
			this.sections.push(...richItem);
		} else if (richItem?.section) {
			this.sections.push(richItem.section);
			if (richItem.submessage) this.submessages.push(richItem.submessage);
		} else if (richItem) {
			this.sections.push(richItem);
		}
		return this;
	}

	text(text, entities) { return this.add(richMarkdown(text, entities)); }
	code(content, language, blocks) { return this.add(richCode(content, language, blocks)); }
	table(rows, title) { return this.add(richTable(rows, title)); }
	image(input, expiration) { return this.add(richImage(input, expiration)); }
	inlineImage(url, alignment) { return this.add(richInlineImage(url, alignment)); }
	inlineLinks(links) { return this.add(richInlineLink(links)); }
	video(url) { return this.add(richVideo(url)); }
	reel(data) { return this.add(richReel(data)); }
	post(data) { return this.add(richPost(data)); }
	product(data) { return this.add(richProduct(data)); }
	searchResult(data) { return this.add(richSearchResult(data)); }
	map(data) { return this.add(richMap(data)); }
	dynamic(data) { return this.add(richDynamic(data)); }
	widget(actions, title) { return this.add(richWidget(actions, title)); }
	footerAction(data) { return this.add(richFooterAction(data)); }
	socialProfile(data) { return this.add(richSocialProfile(data)); }
	menu(data) { return this.add(richMenu(data)); }
	row(primitives) { return this.add(actionRow(primitives)); }
	stack(primitives) { return this.add(vstack(primitives)); }
	hscroll(primitives) { return this.add(hscroll(primitives)); }
	grid(primitives) { return this.add(grid(primitives)); }
}

/**
 * Send an advanced rich layout (RichLayout instance or sections array).
 * @param {object} sock socket instance
 * @param {string} jid target JID
 * @param {RichLayout|Array} layout
 * @param {{ quoted?: object }} [options]
 */
export const sendRichLayout = async (sock, jid, layout, options = {}) => {
	const sections = layout instanceof RichLayout ? layout.sections : layout;
	const submessages = layout instanceof RichLayout ? layout.submessages : [];
	if (!Array.isArray(sections) || !sections.length) throw new TypeError('sendRichLayout requires at least one section');
	const richResponseMessage = {
		messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
		submessages,
		unifiedResponse: { data: Buffer.from(JSON.stringify({ response_id: crypto.randomUUID(), sections })) },
		contextInfo: {
			isForwarded: true,
			forwardingScore: 1,
			forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
			forwardOrigin: 4
		}
	};
	const content = {
		messageContextInfo: {
			botMetadata: {
				pluginMetadata: {},
				botRenderingConfigMetadata: {
					bloksVersioningId: '6e955f4ffe31e9c45cd7702090f9b02107f6ef04bbbae6062a2d9c9b99e03f05',
					pixelDensity: 2.75
				}
			}
		},
		botForwardedMessage: { message: { richResponseMessage } }
	};
	const wrapped = generateWAMessageFromContent(jid, content, { quoted: options.quoted, userJid: sock.user?.id });
	await sock.relayMessage(jid, wrapped.message, { messageId: wrapped.key.id });
	return wrapped;
};
