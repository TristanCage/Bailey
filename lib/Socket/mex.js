import { Boom } from '@hapi/boom';
import { decodeArgoForDataPath, decodeArgoSelfDescribing, hasArgoWireSchema } from '../Utils/argo.js';
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary/index.js';

const wMexQuery = (variables, queryId, query, generateMessageTag) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	});
};

export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag) => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag);
	const child = getBinaryNodeChild(result, 'result');
	if (child?.content) {
		let data;
		if (child.attrs?.format === 'argo') {
			try {
				data = hasArgoWireSchema(dataPath)
					? decodeArgoForDataPath(child.content, dataPath)
					: decodeArgoSelfDescribing(child.content);
			}
			catch (error) {
				const preview = Buffer.from(child.content).toString('base64').slice(0, 256);
				throw new Boom(`Failed to decode Argo response for ${dataPath || 'mex query'}: ${error.message}`, {
					statusCode: 400,
					data: { queryId, dataPath, preview }
				});
			}
		}
		else {
			data = JSON.parse(child.content.toString());
		}
		if (data.errors && data.errors.length > 0) {
			const errorMessages = data.errors.map(err => err.message || 'Unknown error').join(', ');
			const firstError = data.errors[0];
			const errorCode = firstError.extensions?.error_code || 400;
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError });
		}
		const response = dataPath ? data?.data?.[dataPath] : data?.data;
		if (typeof response !== 'undefined') {
			return response;
		}
	}
	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ');
	throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result });
};
