import { readFile, rename, open } from 'fs/promises';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
import { makeMutex } from './make-mutex.js';

/**
 * Single-file auth state with debounced atomic flush and a shared mutex.
 * Ported from @itsliaaa/baileys (MIT, Lia Wynn) with attribution.
 */

const FLUSH_DELAY_MS = 3000;
const files = new Map();

export const useSingleFileAuthState = async fileName => {
	let shared = files.get(fileName);
	if (!shared) {
		files.set(fileName, (shared = { mutex: makeMutex(), flush: null }));
	}
	const { mutex } = shared;
	await shared.flush?.();

	const tempFile = fileName + '.temp';
	const store = Object.create(null);
	let ver = 0;
	let saved = 0;
	let timer = null;

	await mutex.mutex(async () => {
		try {
			Object.assign(store, JSON.parse(await readFile(fileName, 'utf-8'), BufferJSON.reviver));
		} catch (err) {
			if (err.code === 'EISDIR') {
				throw new Error(`found something that is not a file at ${fileName}, either delete it or specify a different location`);
			}
			if (err.code !== 'ENOENT') {
				await rename(fileName, fileName + '.corrupt').catch(() => {});
			}
		}
	});

	const flush = () => {
		clearTimeout(timer);
		timer = null;
		return mutex.mutex(async () => {
			if (ver === saved) return;
			const v = ver;
			try {
				const fh = await open(tempFile, 'w');
				try {
					await fh.writeFile(JSON.stringify(store, BufferJSON.replacer));
					// datasync is not implemented by some fs shims (e.g. Yarn PnP); durability is best-effort
					try {
						await fh.datasync();
					} catch {}
				} finally {
					await fh.close();
				}
				await rename(tempFile, fileName);
				saved = v;
			} catch (err) {
				schedule();
			}
		});
	};

	const schedule = () => {
		timer ??= setTimeout(flush, FLUSH_DELAY_MS);
	};

	shared.flush = flush;

	const creds = store.creds ?? (store.creds = initAuthCreds());

	return {
		state: {
			creds,
			keys: {
				get: (type, ids) => {
					const data = {};
					for (const id of ids) {
						const value = store[type + id];
						data[id] = value && type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(value) : value;
					}
					return data;
				},
				set: data => {
					for (const type in data) {
						const items = data[type];
						for (const id in items) {
							const value = items[id];
							if (value) store[type + id] = value;
							else delete store[type + id];
						}
					}
					ver++;
					schedule();
				}
			}
		},
		saveCreds: () => {
			ver++;
			return flush();
		},
		flush
	};
};
