import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
import logger from './logger.js';

/**
 * Keyv-backed auth state (Redis, SQLite, Mongo, Postgres, memory, …).
 *
 * Requires the optional `keyv` package and an adapter for persistent backends:
 *   npm i keyv @keyv/redis
 *
 * Pass either a Keyv-compatible store adapter or an already-constructed Keyv
 * instance as `backend`.
 */

const loadKeyv = async () => {
	try {
		return (await import('keyv')).Keyv;
	} catch (cause) {
		throw new Error('useKeyvAuthState requires the optional "keyv" package: npm i keyv', { cause });
	}
};

const makeKeyv = (Keyv, backend, namespace) => {
	if (backend instanceof Keyv) return backend;
	if (backend && typeof backend === 'object' && typeof backend.get === 'function' && typeof backend.set === 'function') {
		return new Keyv({ store: backend, namespace });
	}
	throw new Error('useKeyvAuthState: backend must be a Keyv instance or a Keyv store adapter');
};

export const useKeyvAuthState = async (sessionId, backend, options = {}) => {
	const { namespace = sessionId } = options;
	const Keyv = await loadKeyv();
	const keyv = makeKeyv(Keyv, backend, namespace);
	keyv.on?.('error', err => logger.warn({ err: err?.message, namespace }, '[Auth] keyv store error'));

	const key = (type, id) => `${type}:${id}`;
	const credsKey = 'creds';

	const storedCreds = await keyv.get(credsKey).catch(() => undefined);
	const creds = storedCreds ? JSON.parse(storedCreds, BufferJSON.reviver) : initAuthCreds();

	const state = {
		creds,
		keys: {
			get: async (type, ids) => {
				if (!ids.length) return {};
				const raws = await Promise.all(ids.map(id => keyv.get(key(type, id)).catch(() => undefined)));
				const data = {};
				for (let i = 0; i < ids.length; i++) {
					if (raws[i] == null) continue;
					const value = JSON.parse(raws[i], BufferJSON.reviver);
					data[ids[i]] = type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(value) : value;
				}
				return data;
			},
			set: async data => {
				const jobs = [];
				for (const type in data) {
					for (const id in data[type]) {
						const value = data[type][id];
						const k = key(type, id);
						if (value == null) jobs.push(keyv.delete(k));
						else jobs.push(keyv.set(k, JSON.stringify(value, BufferJSON.replacer)));
					}
				}
				await Promise.all(jobs);
			}
		}
	};

	const saveCreds = async () => {
		await keyv.set(credsKey, JSON.stringify(creds, BufferJSON.replacer));
	};

	const clearSession = async () => {
		await keyv.clear().catch(err => logger.warn({ err: err?.message }, '[Auth] keyv clear failed'));
	};

	return { state, saveCreds, clearSession };
};

/** Lightweight check: reads only the creds key. */
export const hasKeyvAuth = async (sessionId, backend, options = {}) => {
	try {
		const Keyv = await loadKeyv();
		const keyv = makeKeyv(Keyv, backend, options.namespace ?? sessionId);
		const stored = await keyv.get('creds');
		if (!stored) return false;
		const parsed = JSON.parse(stored, BufferJSON.reviver);
		return !!(parsed?.noiseKey && parsed?.signedIdentityKey);
	} catch {
		return false;
	}
};
