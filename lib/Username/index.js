import { randomUUID } from 'crypto';
import { USyncQuery, USyncUser } from '../WAUSync/index.js';
import { executeWMexQuery } from '../Socket/mex.js';

// WhatsApp rotates these GraphQL query_ids server-side, so they can go stale.
// Patch them at runtime with setUsernameQueryIds instead of waiting for a release.
export const USERNAME_QUERY_IDS = {
	CHECK: '26124072630599518',
	CHECK_MULTI: '27134626522840286',
	SET: '27108705368767936',
	GET: '32618050064506055',
	GET_RECOMMENDATIONS: '26077456248616957',
	PIN_SET: '25529696019976770'
};

export const USERNAME_CHECK_RESULT = {
	SUCCESS: 'SUCCESS',
	INVALID: 'INVALID'
};

export const USERNAME_SOURCE = {
	FB: 'FB',
	IG: 'IG',
	USER_INPUT: 'USER_INPUT',
	SUGGESTION: 'SUGGESTION'
};


export const setUsernameQueryIds = (ids) => {
	Object.assign(USERNAME_QUERY_IDS, ids);
	return USERNAME_QUERY_IDS;
};

const mexQuery = (variables, queryId, dataPath, deps) =>
	executeWMexQuery(variables, queryId, dataPath, deps.query, deps.generateMessageTag);


export const checkUsername = async (username, deps, includeSuggestions = true, sessionId) => {
	const session_id = sessionId || randomUUID();
	const data = await mexQuery(
		{
			username,
			include_suggestions: includeSuggestions,
			session_id,
			source: USERNAME_SOURCE.USER_INPUT
		},
		USERNAME_QUERY_IDS.CHECK,
		'xwa2_username_check',
		deps
	);

	if (data?.result === USERNAME_CHECK_RESULT.SUCCESS) {
		return { available: true, username, session_id };
	}

	return {
		available: false,
		username,
		session_id,
		suggestions: data?.suggestions ?? [],
		rejectionReasons: data?.rejection_reasons ?? [],
		suggestionsEligible: data?.suggestions_eligible ?? true
	};
};


export const checkUsernameMulti = async (usernames, deps) =>
	mexQuery({ usernames }, USERNAME_QUERY_IDS.CHECK_MULTI, 'xwa2_username_check_multi', deps);


export const setUsername = async (username, deps, options = {}) => {
	const { source = USERNAME_SOURCE.USER_INPUT, sessionId, pin } = options;
	const session_id = sessionId || randomUUID();
	const variables = {
		username,
		reserved: true,
		source,
		session_id,
		...(pin ? { pin } : {})
	};
	return mexQuery(variables, USERNAME_QUERY_IDS.SET, 'xwa2_username_set', deps);
};


export const deleteUsername = async (deps) =>
	mexQuery({ username: null }, USERNAME_QUERY_IDS.SET, 'xwa2_username_delete', deps);


export const getMyUsername = async (deps) => {
	const data = await mexQuery({}, USERNAME_QUERY_IDS.GET, 'xwa2_username_get', deps);
	return data?.username ?? null;
};


export const getUsernameRecommendations = async (deps, source = null) => {
	const variables = {};
	if (source) {
		variables.source = source;
	}
	return mexQuery(variables, USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, 'xwa2_username_get_recommendations', deps);
};


export const setUsernamePin = async (pin, deps) => {
	const variables = pin !== null ? { pin } : {};
	return mexQuery(variables, USERNAME_QUERY_IDS.PIN_SET, 'xwa2_username_pin_set', deps);
};


export const findUserByUsername = async (username, deps, pin) => {
	const usyncQuery = new USyncQuery().withContactProtocol();
	const user = new USyncUser().withUsername(username);
	if (pin) {
		user.withUsernameKey(pin);
	}
	usyncQuery.withUser(user);
	const result = await deps.executeUSyncQuery(usyncQuery);
	if (!result?.list?.length) {
		return null;
	}
	const entry = result.list[0];
	return {
		jid: entry.id,
		contact: entry.contact ?? false,
		username
	};
};


export const fetchContactUsernames = async (jids, deps) => {
	const usyncQuery = new USyncQuery().withUsernameProtocol();
	for (const jid of jids) {
		usyncQuery.withUser(new USyncUser().withId(jid));
	}
	const result = await deps.executeUSyncQuery(usyncQuery);
	return result?.list ?? [];
};
