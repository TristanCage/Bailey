import { randomUUID } from 'crypto';
import { sendInteractive } from '../Buttons/index.js';

/**
 * WhatsApp Flows helpers: build flow buttons, parse flow/native-flow
 * responses, and send a flow.
 */

const parseJsonObject = value => {
	if (!value) return {};
	if (typeof value === 'object') return value;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
};

/** Parse any native-flow response (including WhatsApp Flow submissions). */
export const parseNativeFlowResponse = message => {
	const content = message?.message || message;
	const response = content?.interactiveResponseMessage?.nativeFlowResponseMessage || content?.nativeFlowResponseMessage;
	if (!response) return null;
	const params = parseJsonObject(response.paramsJson);
	const actionPayload = params.flow_action_payload || params.flowActionPayload || {};
	const data = params.data || params.response || params.form_data || params.formData || actionPayload.data || {};
	return {
		name: response.name || '',
		version: response.version,
		paramsJson: response.paramsJson || '',
		params,
		isFlow: response.name === 'galaxy_message' || response.name === 'flow' || !!(params.flow_id || params.flow_token || params.flow_message_version),
		flowId: params.flow_id || params.flowId,
		flowToken: params.flow_token || params.flowToken,
		screen: params.screen || actionPayload.screen,
		action: params.flow_action || params.flowAction || actionPayload.action,
		actionPayload,
		data,
		buttonId: params.id || params.button_id || params.buttonId,
		displayText: params.display_text || params.displayText,
		raw: response
	};
};

/** Parse a response only when it came from a WhatsApp Flow. */
export const parseWhatsAppFlowResponse = message => {
	const response = parseNativeFlowResponse(message);
	return response?.isFlow ? response : null;
};

/** Build the button params object for a WhatsApp Flow. */
export const buildWhatsAppFlowButton = ({
	flowId,
	flowToken,
	cta = 'Open form',
	action = 'navigate',
	actionPayload,
	mode = 'published',
	flowMessageVersion = '3',
	metadata,
	name = 'galaxy_message'
} = {}) => {
	if (!flowId) throw new TypeError('flowId is required');
	if (!flowToken) throw new TypeError('flowToken is required');
	return {
		name,
		flow_message_version: String(flowMessageVersion),
		flow_token: String(flowToken),
		flow_id: String(flowId),
		flow_cta: String(cta),
		flow_action: action,
		...(mode ? { mode } : {}),
		...(actionPayload ? { flow_action_payload: actionPayload } : {}),
		...(metadata ? { flow_metadata: metadata } : {})
	};
};

/** Wrap flow params into a native-flow button. */
export const makeWhatsAppFlowButton = flow => ({
	name: flow?.nativeFlowName || 'galaxy_message',
	buttonParamsJson: JSON.stringify(buildWhatsAppFlowButton(flow))
});

/**
 * Normalize a mixed array of friendly button definitions into native-flow
 * button objects. Already-formatted `{ name, buttonParamsJson }` pass through.
 */
export const resolveNativeFlowButtons = rawButtons => {
	const buttons = Array.isArray(rawButtons) ? rawButtons : [rawButtons];
	return buttons.map(b => {
		if (b.name && b.buttonParamsJson) return b;
		const text = b.text ?? b.display_text ?? '';
		if (b.sections) return { name: 'single_select', buttonParamsJson: JSON.stringify({ title: text, sections: b.sections }) };
		if (b.url && b.useWebview) return { name: 'cta_open_webview', buttonParamsJson: JSON.stringify({ display_text: text, url: b.url }) };
		if (b.url) return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url: b.url, merchant_url: b.merchantUrl ?? b.url }) };
		if (b.call) return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: text, phone_number: b.call }) };
		if (b.copy) return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: text, copy_code: b.copy }) };
		if (b.flow_id ?? b.flowId) {
			return {
				name: 'flow',
				buttonParamsJson: JSON.stringify({
					display_text: text,
					flow_id: b.flow_id ?? b.flowId,
					flow_token: b.flow_token ?? b.flowToken ?? randomUUID()
				})
			};
		}
		if (b.remind) return { name: 'cta_reminder', buttonParamsJson: JSON.stringify({ display_text: text, ...b.remind }) };
		if (b.cancelReminder) return { name: 'cta_cancel_reminder', buttonParamsJson: JSON.stringify({ display_text: text }) };
		if (b.location) return { name: 'send_location', buttonParamsJson: JSON.stringify({ display_text: text }) };
		if (b.address) return { name: 'address_message', buttonParamsJson: JSON.stringify({ display_text: text }) };
		if (b.catalog) return { name: 'catalog_message', buttonParamsJson: JSON.stringify({ display_text: text, ...b.catalog }) };
		if (b.reviewAndPay) return { name: 'review_and_pay', buttonParamsJson: JSON.stringify({ display_text: text, ...b.reviewAndPay }) };
		if (b.reviewOrder) return { name: 'review_order', buttonParamsJson: JSON.stringify({ display_text: text, ...b.reviewOrder }) };
		if (b.orderDetails) return { name: 'order_details', buttonParamsJson: JSON.stringify({ display_text: text, ...b.orderDetails }) };
		if (b.paymentStatus) return { name: 'payment_status', buttonParamsJson: JSON.stringify({ display_text: text, ...b.paymentStatus }) };
		if (b.transactionDetails) return { name: 'transaction_details', buttonParamsJson: JSON.stringify({ display_text: text, ...b.transactionDetails }) };
		return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id: b.id ?? text }) };
	});
};

/**
 * Send a WhatsApp Flow as an interactive message.
 * @param {object} sock socket instance
 * @param {string} jid target JID
 * @param {object} flow { flowId, flowToken, cta, action, actionPayload, text, footer, mentions, quoted }
 * @param {object} [options]
 */
export const sendWhatsAppFlow = async (sock, jid, flow, options = {}) => {
	const button = makeWhatsAppFlowButton(flow);
	return sendInteractive(sock, jid, {
		text: flow.text || flow.body || flow.cta || 'Open form',
		footer: flow.footer || '',
		buttons: [button],
		mentions: flow.mentions || options.mentions || [],
		quoted: flow.quoted || options.quoted,
		ai: flow.ai ?? options.ai ?? false
	});
};
