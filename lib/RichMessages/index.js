import { getRandomValues, randomUUID } from 'crypto';
import { proto } from '../../WAProto/index.js';
import { generateWAMessageFromContent } from '../Utils/messages.js';
import { unixTimestampSeconds } from '../Utils/generics.js';

/**
 * Rich AI responses (text, code blocks with highlighting, tables, latex,
 * inline images, citation links) delivered as `botForwardedMessage`.
 *
 * Ported from @itsliaaa/baileys (MIT, Lia Wynn) with attribution.
 */

const TEXT_ENCODER = new TextEncoder();

const LEXER_REGEX =
	/(\/\/.*|\/\*[\s\S]*?\*\/|#.*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[\s\S]*?`)|(\b[a-zA-Z_]\w*\b)(?=\s*\()|(\b[a-zA-Z_]\w*\b)|(\b\d+(?:\.\d+)?\b)|(\s+|[^\w\s]+)/g;

const JS_KEYWORDS = new Set([
	'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
	'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
	'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
	'async', 'await', 'static', 'true', 'false', 'null', 'undefined'
]);
const PY_KEYWORDS = new Set([
	'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
	'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
	'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'True', 'False', 'None'
]);
const LANGUAGE_KEYWORDS = {
	javascript: JS_KEYWORDS,
	typescript: JS_KEYWORDS,
	js: JS_KEYWORDS,
	ts: JS_KEYWORDS,
	python: PY_KEYWORDS,
	py: PY_KEYWORDS
};

export const CodeHighlightType = {
	DEFAULT: 0,
	KEYWORD: 1,
	METHOD: 2,
	STRING: 3,
	NUMBER: 4,
	COMMENT: 5
};

export const RichSubMessageType = {
	UNKNOWN: 0,
	GRID_IMAGE: 1,
	TEXT: 2,
	INLINE_IMAGE: 3,
	TABLE: 4,
	CODE: 5,
	DYNAMIC: 6,
	MAP: 7,
	LATEX: 8,
	CONTENT_ITEMS: 9
};

export const tokenizeCode = (code, language = 'javascript') => {
	const keywords = LANGUAGE_KEYWORDS[language] || new Set();
	const blocks = [];
	LEXER_REGEX.lastIndex = 0;
	let match;
	while ((match = LEXER_REGEX.exec(code)) !== null) {
		if (match[1]) {
			blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: match[1] });
		} else if (match[2]) {
			blocks.push({ highlightType: CodeHighlightType.STRING, codeContent: match[2] });
		} else if (match[3]) {
			blocks.push({
				highlightType: keywords.has(match[3]) ? CodeHighlightType.KEYWORD : CodeHighlightType.METHOD,
				codeContent: match[3]
			});
		} else if (match[4]) {
			blocks.push({
				highlightType: keywords.has(match[4]) ? CodeHighlightType.KEYWORD : CodeHighlightType.DEFAULT,
				codeContent: match[4]
			});
		} else if (match[5]) {
			blocks.push({ highlightType: CodeHighlightType.NUMBER, codeContent: match[5] });
		} else {
			blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: match[6] });
		}
	}
	return blocks;
};

/** Inject buffer into unifiedResponse.data so clients render tables/code properly. */
export const toUnified = (submessages, uuid) => ({
	response_id: uuid || randomUUID(),
	sections: submessages.map(submessage => {
		switch (submessage.messageType) {
			case RichSubMessageType.CODE: {
				const codeMetadata = submessage.codeMetadata;
				return {
					view_model: {
						primitive: {
							language: codeMetadata.codeLanguage,
							code_blocks: codeMetadata.codeBlocks.map(block => ({
								content: block.codeContent,
								type: CodeHighlightType[block.highlightType]
							})),
							__typename: 'GenAICodeUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				};
			}
			case RichSubMessageType.TABLE: {
				const tableMetadata = submessage.tableMetadata;
				return {
					view_model: {
						primitive: {
							title: tableMetadata.title,
							rows: tableMetadata.rows.map(row => ({
								is_header: row.isHeading,
								cells: row.items,
								markdown_cells: row.items.map(item => ({ text: item }))
							})),
							__typename: 'GenAITableUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				};
			}
			case RichSubMessageType.TEXT:
				return {
					view_model: {
						primitive: {
							text: submessage.messageText,
							inline_entities: submessage.inlineEntities,
							__typename: 'GenAITextUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				};
			default:
				return {};
		}
	})
});

const buildSubmessage = submessage => {
	if (submessage.text) {
		return { messageType: RichSubMessageType.TEXT, messageText: submessage.text, inlineEntities: submessage.inlineEntities };
	}
	if (submessage.code) {
		return {
			messageType: RichSubMessageType.CODE,
			codeMetadata: { codeLanguage: submessage.language, codeBlocks: submessage.code }
		};
	}
	if (submessage.items) {
		return {
			messageType: RichSubMessageType.CONTENT_ITEMS,
			contentItemsMetadata: {
				itemsMetadata: submessage.items,
				contentType: proto.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL
			}
		};
	}
	if (submessage.inlineImage) {
		return {
			messageType: RichSubMessageType.INLINE_IMAGE,
			imageMetadata: {
				imageUrl: submessage.inlineImage,
				imageText: submessage.imageText,
				alignment: submessage.alignment,
				tapLinkUrl: submessage.tapLinkUrl
			}
		};
	}
	if (submessage.inlineVideo) {
		return { messageType: RichSubMessageType.TEXT, messageText: 'INLINE_VIDEO' };
	}
	if (submessage.latex) {
		return {
			messageType: RichSubMessageType.LATEX,
			latexMetadata: { text: submessage.text, expressions: submessage.latex }
		};
	}
	if (submessage.posts) {
		return { messageType: RichSubMessageType.TEXT, messageText: 'POSTS' };
	}
	if (submessage.products) {
		return { messageType: RichSubMessageType.TEXT, messageText: 'PRODUCTS' };
	}
	if (submessage.suggested) {
		return { messageType: RichSubMessageType.TEXT, messageText: 'SUGGESTED_PROMPT' };
	}
	if (submessage.table) {
		return {
			messageType: RichSubMessageType.TABLE,
			tableMetadata: {
				title: submessage.title,
				rows: submessage.table.map((items, index) => ({ isHeading: index === 0, items }))
			}
		};
	}
	return submessage;
};

/**
 * Build the content object for a rich response.
 * Accepts { richResponse: [...] } or the flat { headerText, contentText, code, table, ... }.
 */
export const prepareRichResponseMessage = content => {
	let { alignment, code, contentText, disclaimerText, footerText, headerText, imageText, inlineImage, inlineVideo,
		items, language, latex, links, noHeading, posts, products, suggested, richResponse, table, tapLinkUrl, title } = content;

	let submessages = [];
	if (Array.isArray(richResponse)) {
		submessages = richResponse.map(buildSubmessage);
	} else {
		if (headerText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: headerText });
		if (contentText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: contentText });
		if (code) {
			language ||= 'javascript';
			submessages.push({
				messageType: RichSubMessageType.CODE,
				codeMetadata: { codeLanguage: language, codeBlocks: tokenizeCode(code, language) }
			});
		}
		if (items) {
			submessages.push({
				messageType: RichSubMessageType.CONTENT_ITEMS,
				contentItemsMetadata: {
					itemsMetadata: items,
					contentType: proto.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL
				}
			});
		}
		if (inlineImage) {
			submessages.push({
				messageType: RichSubMessageType.INLINE_IMAGE,
				imageMetadata: { imageUrl: inlineImage, imageText, alignment, tapLinkUrl }
			});
		}
		if (inlineVideo) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'INLINE_VIDEO' });
		if (latex) {
			submessages.push({
				messageType: RichSubMessageType.LATEX,
				latexMetadata: { text: title, expressions: latex }
			});
		}
		if (links) {
			links.forEach((linkField, index) => {
				const prefix = 'SS_' + index;
				const url = linkField.url || '';
				const sources = linkField.sources?.map(sourceField => ({
					source_type: 'THIRD_PARTY',
					source_display_name: sourceField.displayName || 'Source',
					source_subtitle: sourceField.subtitle || '',
					source_url: sourceField.url || url
				}));
				submessages.push({
					messageType: RichSubMessageType.TEXT,
					messageText: linkField.text + ` {{${prefix}}}¹{{/${prefix}}} `,
					inlineEntities: [{
						key: prefix,
						metadata: {
							reference_id: index + 1,
							reference_url: url,
							reference_title: linkField.title || 'Source',
							reference_display_name: linkField.displayName || 'Source',
							sources: sources || [],
							__typename: 'GenAISearchCitationItem'
						}
					}]
				});
			});
		}
		if (posts) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'POSTS' });
		if (products) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'PRODUCTS' });
		if (suggested) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'SUGGESTED_PROMPT' });
		if (table) {
			submessages.push({
				messageType: RichSubMessageType.TABLE,
				tableMetadata: {
					title,
					rows: table.map((rowItems, index) => ({ isHeading: !noHeading && index === 0, items: rowItems }))
				}
			});
		}
		if (footerText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: footerText });
	}

	const uuid = randomUUID();
	const unified = toUnified(submessages, uuid);
	const richResponseMessage = proto.AIRichResponseMessage.create({
		submessages,
		messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
		unifiedResponse: { data: TEXT_ENCODER.encode(JSON.stringify(unified)) },
		contextInfo: {
			isForwarded: true,
			forwardingScore: 1,
			forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
			forwardOrigin: 4
		}
	});
	const message = wrapToBotForwardedMessage(richResponseMessage);
	if (disclaimerText) {
		message.messageContextInfo.botMetadata.messageDisclaimerText = disclaimerText;
	}
	message.messageContextInfo.botMetadata.botResponseId = uuid;
	return message;
};

export const botMetadataSignature = () => {
	const signature = new Uint8Array(64);
	getRandomValues(signature);
	return signature;
};

export const botMetadataCertificate = (length = 685) => {
	const certificate = new Uint8Array(length);
	certificate[0] = 48;
	certificate[1] = 130;
	getRandomValues(certificate.subarray(2));
	return certificate;
};

export const wrapToBotForwardedMessage = richResponseMessage => ({
	messageContextInfo: {
		botMetadata: {
			verificationMetadata: {
				proofs: [{
					certificateChain: [botMetadataCertificate(), botMetadataCertificate(892)],
					version: 1,
					useCase: 1,
					signature: botMetadataSignature()
				}]
			}
		}
	},
	botForwardedMessage: { message: { richResponseMessage } }
});

/**
 * Send a rich response message.
 * @param {object} sock socket instance
 * @param {string} jid target JID
 * @param {object} content rich content (see prepareRichResponseMessage)
 * @param {{ quoted?: object }} [options]
 */
export const sendRichResponse = async (sock, jid, content, options = {}) => {
	const messageContent = prepareRichResponseMessage(content);
	const wrapped = generateWAMessageFromContent(jid, messageContent, {
		quoted: options.quoted,
		userJid: sock.user?.id
	});
	await sock.relayMessage(jid, wrapped.message, { messageId: wrapped.key.id });
	return wrapped;
};
