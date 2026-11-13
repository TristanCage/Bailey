import EventEmitter from 'events';
import { jidNormalizedUser } from '../WABinary/index.js';

/**
 * Live presence tracker: online/offline, typing, recording and last-seen
 * states per contact, with optional resubscription.
 */

const normalizeContactJid = jid => {
	if (!jid) return undefined;
	return jidNormalizedUser(jid);
};

const stateFor = jid => ({
	jid,
	status: 'unknown',
	lastSeen: undefined,
	isTyping: false,
	isRecording: false,
	lastMessageAt: undefined,
	updatedAt: Date.now()
});

export class PresenceTracker extends EventEmitter {
	constructor(sock, targetsOrOptions, options) {
		super();
		this.sock = sock;
		this.states = new Map();
		this.aliases = new Map();
		this.monitored = new Set();
		this.destroyed = false;

		let initialTargets;
		let resolvedOptions = {};
		if (typeof targetsOrOptions === 'string' || Array.isArray(targetsOrOptions)) {
			initialTargets = targetsOrOptions;
			resolvedOptions = options || {};
		} else if (targetsOrOptions) {
			resolvedOptions = targetsOrOptions;
		}

		this.options = {
			autoResubscribe: resolvedOptions.autoResubscribe !== false,
			resolveLid: resolvedOptions.resolveLid !== false,
			trackMessagesAsPresence: resolvedOptions.trackMessagesAsPresence !== false,
			resubscribeIntervalMs: resolvedOptions.resubscribeIntervalMs ?? 25000
		};

		this.onPresence = this.handlePresence.bind(this);
		this.onConnection = this.handleConnection.bind(this);
		this.onLidMapping = ({ lid, pn } = {}) => {
			if (lid && pn) this.linkAliases(pn, lid);
		};
		this.onMessages = ({ messages = [] } = {}) => {
			for (const msg of messages) {
				const jid = normalizeContactJid(msg.key?.participant || msg.key?.remoteJid);
				if (!jid) continue;
				const state = this.ensure(jid);
				state.lastMessageAt = Date.now();
				state.updatedAt = Date.now();
			}
		};

		sock.ev.on('presence.update', this.onPresence);
		sock.ev.on('connection.update', this.onConnection);
		sock.ev.on('lid-mapping.update', this.onLidMapping);
		if (this.options.trackMessagesAsPresence) sock.ev.on('messages.upsert', this.onMessages);

		if (this.options.autoResubscribe && this.options.resubscribeIntervalMs > 0) {
			this.timer = setInterval(() => this.resubscribeAll().catch(() => {}), this.options.resubscribeIntervalMs);
			this.timer.unref?.();
		}

		if (initialTargets) this.subscribe(initialTargets).catch(() => {});
	}

	ensure(jid) {
		let state = this.states.get(jid);
		if (!state) {
			state = stateFor(jid);
			this.states.set(jid, state);
		}
		return state;
	}

	linkAliases(pn, lid) {
		const normalizedPn = normalizeContactJid(pn);
		const normalizedLid = normalizeContactJid(lid);
		if (!normalizedPn || !normalizedLid || normalizedPn === normalizedLid) return;
		if (!(normalizedPn.endsWith('@s.whatsapp.net') && normalizedLid.endsWith('@lid'))) return;
		this.aliases.set(normalizedPn, normalizedLid);
		this.aliases.set(normalizedLid, normalizedPn);
		const state = this.ensure(normalizedPn);
		state.lid = normalizedLid;
		this.states.set(normalizedLid, state);
		if (this.monitored.has(normalizedPn)) this.monitored.add(normalizedLid);
	}

	resolveJid(jid) {
		const normalized = normalizeContactJid(jid);
		if (!normalized) return undefined;
		const alias = this.aliases.get(normalized);
		return alias && this.states.has(alias) ? alias : normalized;
	}

	async subscribe(jids) {
		if (this.destroyed) return;
		const list = Array.isArray(jids) ? jids : [jids];
		try {
			await this.sock.sendPresenceUpdate?.('available');
		} catch {}
		for (const raw of list) {
			const jid = normalizeContactJid(raw);
			if (!jid) continue;
			this.monitored.add(jid);
			this.ensure(jid);
			if (this.options.resolveLid && typeof this.sock.signalRepository?.lidMapping?.getLIDForPN === 'function') {
				try {
					const lid = await this.sock.signalRepository.lidMapping.getLIDForPN(jid);
					if (lid) this.linkAliases(jid, lid);
				} catch {}
			}
			try {
				await this.sock.presenceSubscribe?.(jid);
			} catch (err) {
				this.emit('error', err);
			}
			const state = this.states.get(jid);
			if (state?.lid && state.lid !== jid) {
				try {
					await this.sock.presenceSubscribe?.(state.lid);
				} catch {}
			}
		}
	}

	async unsubscribe(jids) {
		const list = Array.isArray(jids) ? jids : [jids];
		for (const raw of list) {
			const jid = normalizeContactJid(raw);
			if (!jid) continue;
			this.monitored.delete(jid);
			try {
				await this.sock.presenceSubscribe?.(jid, 'unavailable');
			} catch {}
		}
	}

	async resubscribeAll() {
		for (const jid of this.monitored) {
			try {
				await this.sock.presenceSubscribe?.(jid);
			} catch {}
		}
	}

	handlePresence({ id, presences = {} } = {}) {
		const jid = this.resolveJid(id);
		if (!jid) return;
		const state = this.ensure(jid);
		const update = presences[id] ?? presences[Object.keys(presences)[0]] ?? {};
		const previousStatus = state.status;
		if (update.lastKnownPresence) state.status = update.lastKnownPresence;
		if (update.lastSeen) state.lastSeen = update.lastSeen;
		state.isTyping = state.status === 'composing';
		state.isRecording = state.status === 'recording';
		state.updatedAt = Date.now();
		const payload = { jid, ...state, presence: update };
		this.emit('presence.update', payload);
		if (previousStatus !== state.status) {
			if (state.status === 'available') this.emit('online', payload);
			else if (state.status === 'unavailable') this.emit('offline', payload);
			if (state.isTyping) this.emit('typing', payload);
			if (state.isRecording) this.emit('recording', payload);
		}
		if (update.lastSeen) this.emit('lastSeen', { jid, lastSeen: update.lastSeen });
	}

	handleConnection({ connection } = {}) {
		if (connection === 'open' && this.options.autoResubscribe) {
			this.resubscribeAll().catch(() => {});
		}
	}

	getPresence(jid) {
		const resolved = this.resolveJid(jid);
		return resolved ? this.states.get(resolved) : undefined;
	}

	getAllPresence() {
		return [...new Set(this.states.values())];
	}

	isOnline(jid) {
		return this.getPresence(jid)?.status === 'available';
	}

	destroy() {
		this.destroyed = true;
		if (this.timer) clearInterval(this.timer);
		this.sock.ev.off?.('presence.update', this.onPresence);
		this.sock.ev.off?.('connection.update', this.onConnection);
		this.sock.ev.off?.('lid-mapping.update', this.onLidMapping);
		if (this.options.trackMessagesAsPresence) this.sock.ev.off?.('messages.upsert', this.onMessages);
		this.removeAllListeners();
	}
}

/** Convenience factory: monitor one or more contacts. */
export const createPresenceTracker = (sock, jid, options) => new PresenceTracker(sock, jid, options);
export const PresenceMonitor = PresenceTracker;
