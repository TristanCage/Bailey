import crypto from 'crypto';
import { generateWAMessageFromContent, prepareWAMessageMedia } from '../Utils/messages.js';
import { resolveNativeFlowButtons } from '../Flows/index.js';

/**
 * A2UI (bloks) interactive surfaces.
 */

const A2UI_VERSIONS = {
	imgVariant: ['icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header'],
	imgFit: ['contain', 'cover', 'fill', 'none', 'scaleDown'],
	textVariant: ['h1', 'h2', 'h3', 'h4', 'h5', 'caption', 'body'],
	btnVariant: ['default', 'primary', 'borderless'],
	colJustify: ['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'],
	rowJustify: ['center', 'end', 'spaceAround', 'spaceBetween', 'spaceEvenly', 'start', 'stretch'],
	align: ['start', 'center', 'end', 'stretch'],
	listDir: ['vertical', 'horizontal'],
	tfVariant: ['longText', 'number', 'shortText', 'obscured'],
	cpVariant: ['mutuallyExclusive', 'multipleSelection'],
	cpDisplay: ['checkbox', 'chips'],
	divAxis: ['horizontal', 'vertical'],
	icons: [
		'accountCircle', 'add', 'arrowBack', 'arrowForward', 'attachFile', 'calendarToday', 'call', 'camera',
		'check', 'close', 'delete', 'download', 'edit', 'event', 'error', 'fastForward', 'favorite', 'favoriteOff',
		'folder', 'help', 'home', 'info', 'locationOn', 'lock', 'lockOpen', 'mail', 'menu', 'moreVert', 'moreHoriz',
		'notificationsOff', 'notifications', 'pause', 'payment', 'person', 'phone', 'photo', 'play', 'print',
		'refresh', 'rewind', 'search', 'send', 'settings', 'share', 'shoppingCart', 'skipNext', 'skipPrevious',
		'star', 'starHalf', 'starOff', 'stop', 'upload', 'visibility', 'visibilityOff', 'volumeDown',
		'volumeMute', 'volumeOff', 'volumeUp', 'warning'
	]
};

const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const requireId = (id, name) => {
	if (!id) throw new TypeError(`${name} requires an id`);
	return id;
};

const bizNodeFor = message => {
	if (!message?.interactiveMessage) return [];
	return [{
		tag: 'biz',
		attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: String(Math.floor(Date.now() / 1000)) },
		content: [
			{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] },
			{
				tag: 'quality_control',
				attrs: { decision_id: crypto.randomBytes(20).toString('hex'), source_type: 'third_party' },
				content: [{ tag: 'decision_source', attrs: { value: 'df' } }]
			}
		]
	}];
};

export class A2UI {
	static VERSION = 'v0.9';
	static get CATALOG() {
		return `https://a2ui.org/specification/${this.VERSION}/catalogs/basic/catalog.json`;
	}

	static text(id, text, { variant = 'body' } = {}) {
		return { id: requireId(id, 'text'), component: 'Text', text: String(text), variant: pick(variant, A2UI_VERSIONS.textVariant, 'body') };
	}

	static image(id, input, { variant = 'mediumFeature', fit = 'fill' } = {}) {
		if (!input) throw new TypeError('image requires a url, buffer, or file path');
		return { id: requireId(id, 'image'), component: 'Image', url: '', _raw: input, variant: pick(variant, A2UI_VERSIONS.imgVariant, 'mediumFeature'), fit: pick(fit, A2UI_VERSIONS.imgFit, 'fill') };
	}

	static icon(id, name) {
		if (!name) throw new TypeError('icon requires a name');
		if (typeof name === 'string' && !A2UI_VERSIONS.icons.includes(name)) throw new TypeError(`invalid icon: ${name}`);
		return { id: requireId(id, 'icon'), component: 'Icon', name };
	}

	static video(id, url) {
		if (!url) throw new TypeError('video requires a url');
		return { id: requireId(id, 'video'), component: 'Video', url: String(url) };
	}

	static audio(id, url, { description = '' } = {}) {
		if (!url) throw new TypeError('audio requires a url');
		return { id: requireId(id, 'audio'), component: 'AudioPlayer', url: String(url), ...(description ? { description: String(description) } : {}) };
	}

	static column(id, children = [], { justify = 'start', align = 'stretch' } = {}) {
		if (!children.length) throw new TypeError('column requires at least one child');
		return { id: requireId(id, 'column'), component: 'Column', children: children.map(String), justify: pick(justify, A2UI_VERSIONS.colJustify, 'start'), align: pick(align, A2UI_VERSIONS.align, 'stretch') };
	}

	static row(id, children = [], { justify = 'start', align = 'stretch' } = {}) {
		if (!children.length) throw new TypeError('row requires at least one child');
		return { id: requireId(id, 'row'), component: 'Row', children: children.map(String), justify: pick(justify, A2UI_VERSIONS.rowJustify, 'start'), align: pick(align, A2UI_VERSIONS.align, 'stretch') };
	}

	static list(id, children = [], { direction = 'vertical', align = 'stretch' } = {}) {
		if (!children.length) throw new TypeError('list requires at least one child');
		return { id: requireId(id, 'list'), component: 'List', children: children.map(String), direction: pick(direction, A2UI_VERSIONS.listDir, 'vertical'), align: pick(align, A2UI_VERSIONS.align, 'stretch') };
	}

	static card(id, child) {
		if (!child) throw new TypeError('card requires a child id');
		return { id: requireId(id, 'card'), component: 'Card', child: String(child) };
	}

	static tabs(id, tabs = []) {
		if (!tabs.length) throw new TypeError('tabs requires at least one tab');
		return {
			id: requireId(id, 'tabs'),
			component: 'Tabs',
			tabs: tabs.map((t, i) => ({ title: String(t.title ?? t.label ?? `Tab ${i + 1}`), child: String(t.child) }))
		};
	}

	static modal(id, trigger, content) {
		if (!trigger) throw new TypeError('modal requires a trigger id');
		if (!content) throw new TypeError('modal requires a content id');
		return { id: requireId(id, 'modal'), component: 'Modal', trigger: String(trigger), content: String(content) };
	}

	static divider(id, { axis = 'horizontal' } = {}) {
		return { id: requireId(id, 'divider'), component: 'Divider', axis: pick(axis, A2UI_VERSIONS.divAxis, 'horizontal') };
	}

	static button(id, child, action, { variant = 'default' } = {}) {
		if (!child) throw new TypeError('button requires a child id');
		if (!action) throw new TypeError('button requires an action');
		return { id: requireId(id, 'button'), component: 'Button', child: String(child), action, variant: pick(variant, A2UI_VERSIONS.btnVariant, 'default') };
	}

	static textField(id, label, { value = '', variant = 'shortText', validationRegexp = '' } = {}) {
		if (!label) throw new TypeError('textField requires a label');
		return {
			id: requireId(id, 'textField'),
			component: 'TextField',
			label: String(label),
			value: String(value),
			variant: pick(variant, A2UI_VERSIONS.tfVariant, 'shortText'),
			...(validationRegexp ? { validationRegexp: String(validationRegexp) } : {})
		};
	}

	static checkBox(id, label, value = false) {
		if (!label) throw new TypeError('checkBox requires a label');
		return { id: requireId(id, 'checkBox'), component: 'CheckBox', label: String(label), value: Boolean(value) };
	}

	static choicePicker(id, options = [], value = [], { label = '', variant = 'mutuallyExclusive', displayStyle = 'checkbox', filterable = false } = {}) {
		if (!options.length) throw new TypeError('choicePicker requires at least one option');
		return {
			id: requireId(id, 'choicePicker'),
			component: 'ChoicePicker',
			options: options.map(o => (typeof o === 'string' ? { label: o, value: o } : { label: String(o.label), value: String(o.value) })),
			value: (Array.isArray(value) ? value : [value]).map(String),
			...(label ? { label: String(label) } : {}),
			variant: pick(variant, A2UI_VERSIONS.cpVariant, 'mutuallyExclusive'),
			displayStyle: pick(displayStyle, A2UI_VERSIONS.cpDisplay, 'checkbox'),
			filterable: Boolean(filterable)
		};
	}

	static slider(id, value, max, { label = '', min = 0 } = {}) {
		if (max == null) throw new TypeError('slider requires a max');
		return { id: requireId(id, 'slider'), component: 'Slider', value: Number(value), max: Number(max), min: Number(min), ...(label ? { label: String(label) } : {}) };
	}

	static dateTimeInput(id, value = '', { label = '', enableDate = false, enableTime = false, min = '', max = '' } = {}) {
		return {
			id: requireId(id, 'dateTimeInput'),
			component: 'DateTimeInput',
			value: String(value),
			enableDate: Boolean(enableDate),
			enableTime: Boolean(enableTime),
			...(label ? { label: String(label) } : {}),
			...(min ? { min: String(min) } : {}),
			...(max ? { max: String(max) } : {})
		};
	}

	static surface(components, { surfaceId, catalogId = A2UI.CATALOG, version = A2UI.VERSION } = {}) {
		const id = surfaceId ?? `a2ui-${crypto.randomUUID()}`;
		return Buffer.from(
			JSON.stringify({ version, createSurface: { surfaceId: id, catalogId, sendDataModel: false, components } }),
			'utf8'
		);
	}

	static async resolveImage(input, upload) {
		if (Buffer.isBuffer(input)) {
			const prepared = await prepareWAMessageMedia({ image: input }, { upload });
			return { url: prepared.imageMessage?.url ?? '' };
		}
		if (typeof input === 'string' && !input.startsWith('http')) {
			const { readFile } = await import('fs/promises');
			const prepared = await prepareWAMessageMedia({ image: await readFile(input) }, { upload });
			return { url: prepared.imageMessage?.url ?? '' };
		}
		if (typeof input === 'string') return { url: input };
		if (input?.url) return { url: input.url };
		if (input?.image) {
			const prepared = await prepareWAMessageMedia({ image: input.image }, { upload });
			return { url: prepared.imageMessage?.url ?? '' };
		}
		throw new TypeError('invalid image input');
	}

	#components = [];
	#buttons = [];
	#surfaceId = `a2ui-${crypto.randomUUID()}`;
	#fallback = '';
	#data = {};

	constructor(client) {
		if (!client) throw new Error('Socket client is required');
		this.client = client;
	}

	from(data) {
		this.#data = data && typeof data === 'object' ? { ...data } : {};
		return this;
	}

	addComponent(obj) {
		if (!obj?.id) throw new TypeError('addComponent requires an object with an id');
		this.#components.push(obj);
		return this;
	}

	addComponents(arr) {
		if (!Array.isArray(arr)) throw new TypeError('addComponents requires an array');
		for (const component of arr) this.addComponent(component);
		return this;
	}

	addText(id, text, opts) { return this.addComponent(A2UI.text(id, text, opts)); }
	addImage(id, input, opts) { return this.addComponent(A2UI.image(id, input, opts)); }
	addIcon(id, name) { return this.addComponent(A2UI.icon(id, name)); }
	addVideo(id, url) { return this.addComponent(A2UI.video(id, url)); }
	addAudio(id, url, opts) { return this.addComponent(A2UI.audio(id, url, opts)); }
	addColumn(id, children, opts) { return this.addComponent(A2UI.column(id, children, opts)); }
	addRow(id, children, opts) { return this.addComponent(A2UI.row(id, children, opts)); }
	addList(id, children, opts) { return this.addComponent(A2UI.list(id, children, opts)); }
	addCard(id, child) { return this.addComponent(A2UI.card(id, child)); }
	addTabs(id, tabs) { return this.addComponent(A2UI.tabs(id, tabs)); }
	addModal(id, trigger, content) { return this.addComponent(A2UI.modal(id, trigger, content)); }
	addDivider(id, opts) { return this.addComponent(A2UI.divider(id, opts)); }
	addButtonComponent(id, child, action, opts) { return this.addComponent(A2UI.button(id, child, action, opts)); }
	addTextField(id, label, opts) { return this.addComponent(A2UI.textField(id, label, opts)); }
	addCheckBox(id, label, value) { return this.addComponent(A2UI.checkBox(id, label, value)); }
	addChoicePicker(id, options, value, opts) { return this.addComponent(A2UI.choicePicker(id, options, value, opts)); }
	addSlider(id, value, max, opts) { return this.addComponent(A2UI.slider(id, value, max, opts)); }
	addDateTimeInput(id, value, opts) { return this.addComponent(A2UI.dateTimeInput(id, value, opts)); }

	addButton(nameOrShorthand, params = {}) {
		if (!nameOrShorthand) throw new TypeError('addButton requires a name or shorthand object');
		if (typeof nameOrShorthand === 'object') {
			const [resolved] = resolveNativeFlowButtons([nameOrShorthand]);
			this.#buttons.push(resolved);
		} else {
			this.#buttons.push({ name: nameOrShorthand, buttonParamsJson: typeof params === 'string' ? params : JSON.stringify(params) });
		}
		return this;
	}

	setFallback(text) { this.#fallback = String(text); return this; }
	setSurfaceId(id) { this.#surfaceId = String(id); return this; }

	async #resolveComponents() {
		const upload = this.client.waUploadToServer;
		return Promise.all(this.#components.map(async component => {
			if (component.component !== 'Image' || !component._raw) return component;
			const { _raw, ...rest } = component;
			const { url } = await A2UI.resolveImage(_raw, upload);
			return { ...rest, url };
		}));
	}

	async send(jid, opts = {}) {
		const data = this.#data;
		if (data.components?.length) {
			this.addComponents(data.components);
			if (data.buttons?.length) for (const button of data.buttons) this.#buttons.push(button);
		}

		const upload = this.client.waUploadToServer;
		let content;

		if (this.#components.length) {
			if (!this.#components.some(c => c.id === 'root')) throw new Error('A2UI components must include one with id "root"');
			const components = await this.#resolveComponents();
			let header = { hasMediaAttachment: false };
			if (data.imageMessage) header = { imageMessage: data.imageMessage, hasMediaAttachment: true };
			else if (data.image) {
				const { url } = await A2UI.resolveImage(data.image, upload);
				header = { imageMessage: { url }, hasMediaAttachment: true };
			}
			const buttons = [...this.#buttons, ...(opts.buttons ?? [])];
			content = {
				interactiveMessage: {
					header,
					body: { text: data.body ?? data.text ?? '\u200b' },
					bloksWidget: {
						uuid: this.#surfaceId,
						type: 'im_a2ui',
						data: A2UI.surface(components, { surfaceId: this.#surfaceId }),
						fallback: this.#fallback
					},
					...(buttons.length ? {
						nativeFlowMessage: {
							messageParamsJson: JSON.stringify(opts.nativeFlowParams ?? {}),
							buttons,
							messageVersion: 1
						}
					} : {})
				}
			};
		} else {
			const { imageMessage, image, bloksWidget = {}, nativeFlowMessage, fallback = '', ...rest } = data;
			let header = { hasMediaAttachment: false };
			if (imageMessage) header = { imageMessage, hasMediaAttachment: true };
			else if (image) {
				const { url } = await A2UI.resolveImage(image, upload);
				header = { imageMessage: { url }, hasMediaAttachment: true };
			}
			content = {
				interactiveMessage: {
					...rest,
					header,
					body: { text: data.body ?? data.text ?? '\u200b' },
					bloksWidget: {
						uuid: bloksWidget.uuid ?? crypto.randomUUID(),
						type: bloksWidget.type ?? 'im_a2ui',
						data: Buffer.isBuffer(bloksWidget.data)
							? bloksWidget.data
							: Buffer.from(typeof bloksWidget.data === 'string' ? bloksWidget.data : JSON.stringify(bloksWidget.data ?? {}), 'utf8'),
						...(bloksWidget.fallback || fallback ? { fallback: String(bloksWidget.fallback ?? fallback) } : {})
					},
					...(nativeFlowMessage ? { nativeFlowMessage: { ...nativeFlowMessage, messageVersion: nativeFlowMessage.messageVersion ?? 1 } } : {})
				}
			};
		}

		const msg = generateWAMessageFromContent(jid, content, {
			userJid: this.client.user?.id,
			upload
		});
		await this.client.relayMessage(jid, msg.message, {
			messageId: msg.key.id,
			additionalNodes: bizNodeFor(msg.message)
		});
		return msg;
	}
}

/** Send an A2UI surface built from component objects. */
export const sendA2UI = (sock, jid, components, opts = {}) => new A2UI(sock).addComponents(components).send(jid, opts);

/** Send an A2UI message from a raw data object. */
export const sendA2UIMessage = (sock, jid, data, opts = {}) => new A2UI(sock).from(data).send(jid, opts);
