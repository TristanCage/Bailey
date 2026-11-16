import { LRUCache } from 'lru-cache';
import { jidDecode } from '../WABinary/index.js';


export class UsernameMappingStore {
	constructor(keys, logger) {
		this.mappingCache = new LRUCache({
			ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
			ttlAutopurge: true,
			updateAgeOnGet: true
		});
		this.keys = keys;
		this.logger = logger;
	}

	
	async storeUsernameMappings(pairs) {
		if (!pairs?.length) return;
		const validated = [];
		for (const { username, jid } of pairs) {
			if (!username || !jid) continue;
			const decoded = jidDecode(jid);
			if (!decoded?.user) continue;
			validated.push({ username: username.toLowerCase(), jidUser: decoded.user, jid });
		}
		if (!validated.length) return;

		
		const toStore = {};
		for (const { username, jidUser, jid } of validated) {
			const existingJid = this.mappingCache.get(`user:${username}`);
			const existingUsername = this.mappingCache.get(`jid:${jidUser}`);
			if (existingJid === jid && existingUsername === username) continue;
			toStore[username] = jid;
			toStore[`${jidUser}_reverse`] = username;
		}
		if (!Object.keys(toStore).length) return;

		this.logger?.debug({ count: Object.keys(toStore).length }, 'storing username mappings');
		await this.keys.transaction(async () => {
			await this.keys.set({ 'username-mapping': toStore });
		}, 'username-mapping');

		
		for (const { username, jidUser, jid } of validated) {
			this.mappingCache.set(`user:${username}`, jid);
			this.mappingCache.set(`jid:${jidUser}`, username);
		}
	}

	
	async getJidForUsername(username) {
		if (!username) return null;
		const normalized = username.toLowerCase().replace(/^@/, '');
		let jid = this.mappingCache.get(`user:${normalized}`);
		if (jid) return jid;
		const stored = await this.keys.get('username-mapping', [normalized]);
		jid = stored[normalized];
		if (jid && typeof jid === 'string') {
			this.mappingCache.set(`user:${normalized}`, jid);
			const decoded = jidDecode(jid);
			if (decoded?.user) {
				this.mappingCache.set(`jid:${decoded.user}`, normalized);
			}
		}
		return jid || null;
	}

	
	async getUsernameForJid(jid) {
		if (!jid) return null;
		const decoded = jidDecode(jid);
		if (!decoded?.user) return null;
		let username = this.mappingCache.get(`jid:${decoded.user}`);
		if (username) return username;
		const stored = await this.keys.get('username-mapping', [`${decoded.user}_reverse`]);
		username = stored[`${decoded.user}_reverse`];
		if (username && typeof username === 'string') {
			this.mappingCache.set(`jid:${decoded.user}`, username);
			this.mappingCache.set(`user:${username}`, jid);
		}
		return username || null;
	}

	
	async removeUsernameMapping(jid) {
		if (!jid) return;
		const decoded = jidDecode(jid);
		if (!decoded?.user) return;
		const username = await this.getUsernameForJid(jid);
		if (!username) return;
		this.mappingCache.delete(`user:${username}`);
		this.mappingCache.delete(`jid:${decoded.user}`);
		await this.keys.transaction(async () => {
			await this.keys.set({
				'username-mapping': {
					[username]: null,
					[`${decoded.user}_reverse`]: null
				}
			});
		}, 'username-mapping');
	}

	
	async getJidsForUsernames(usernames) {
		const results = [];
		for (const username of usernames) {
			const jid = await this.getJidForUsername(username);
			results.push({ username: username.toLowerCase().replace(/^@/, ''), jid });
		}
		return results;
	}

	
	async getUsernamesForJids(jids) {
		const results = [];
		for (const jid of jids) {
			const username = await this.getUsernameForJid(jid);
			results.push({ jid, username });
		}
		return results;
	}
}
