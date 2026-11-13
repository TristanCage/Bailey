import { createHash } from 'crypto';

/**
 * Opt-in anti-ban toolkit: rate limiting, warmup, group-operation guards,
 * 463 timelock handling, reconnect throttling and human-like entropy.
 *
 * Nothing here runs unless `wrapSocket()` is called or a class is instantiated,
 * so there is zero overhead for existing bots. Concepts ported from
 * baileys-antiban (MIT, kobie3717) with attribution.
 */

// ─── helpers ────────────────────────────────────────────────────────────────

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Box-Muller Gaussian sample, clamped to [min, max]. */
const gaussian = (min, max) => {
	const u = Math.random() || Number.MIN_VALUE;
	const v = Math.random();
	const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	const mean = (min + max) / 2;
	const std = (max - min) / 4;
	return clamp(mean + z * std, min, max);
};

const contentKey = content => {
	const parts = [];
	if (typeof content === 'string') parts.push(content);
	else if (content && typeof content === 'object') {
		for (const key of ['text', 'caption', 'name', 'fileName']) {
			if (typeof content[key] === 'string') parts.push(content[key]);
		}
	}
	return parts.length
		? createHash('sha1').update(parts.join('|')).digest('hex')
		: `media:${Object.keys(content || {}).sort().join(',')}`;
};

// ─── Rate limiter ───────────────────────────────────────────────────────────

export class RateLimiter {
	constructor(config = {}) {
		this.config = {
			maxPerMinute: config.maxPerMinute ?? 8,
			maxPerHour: config.maxPerHour ?? 200,
			maxPerDay: config.maxPerDay ?? 1500,
			minDelayMs: config.minDelayMs ?? 1500,
			maxDelayMs: config.maxDelayMs ?? 5000,
			newChatDelayMs: config.newChatDelayMs ?? 3000,
			maxIdenticalMessages: config.maxIdenticalMessages ?? 3,
			identicalMessageWindowMs: config.identicalMessageWindowMs ?? 3600000
		};
		this.sent = [];
		this.identical = new Map();
		this.seenChats = new Set();
		this.chain = Promise.resolve();
	}

	_prune(now) {
		const dayAgo = now - 86400000;
		this.sent = this.sent.filter(timestamp => timestamp > dayAgo);
		for (const [key, timestamps] of this.identical) {
			const fresh = timestamps.filter(timestamp => now - timestamp <= this.config.identicalMessageWindowMs);
			if (fresh.length) this.identical.set(key, fresh);
			else this.identical.delete(key);
		}
	}

	_canSend(now) {
		const minute = this.sent.filter(timestamp => now - timestamp < 60000).length;
		const hour = this.sent.filter(timestamp => now - timestamp < 3600000).length;
		const day = this.sent.length;
		return minute < this.config.maxPerMinute && hour < this.config.maxPerHour && day < this.config.maxPerDay;
	}

	async schedule(task, content) {
		const run = this.chain.then(() => this._execute(task, content));
		this.chain = run.catch(() => {});
		return run;
	}

	async _execute(task, content) {
		const now = Date.now();
		this._prune(now);
		while (!this._canSend(Date.now())) {
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		const key = content === undefined ? undefined : contentKey(content);
		if (key) {
			const repeated = (this.identical.get(key) || []).length;
			if (repeated >= this.config.maxIdenticalMessages) {
				await new Promise(resolve => setTimeout(resolve, gaussian(this.config.minDelayMs, this.config.maxDelayMs) * 2));
			}
		}
		const delay = gaussian(this.config.minDelayMs, this.config.maxDelayMs);
		await new Promise(resolve => setTimeout(resolve, delay));
		this.sent.push(Date.now());
		if (key) this.identical.set(key, [...(this.identical.get(key) || []), Date.now()]);
		return task();
	}

	markChatSeen(jid) {
		this.seenChats.add(jid);
	}

	stats() {
		const now = Date.now();
		this._prune(now);
		return {
			perMinute: this.sent.filter(timestamp => now - timestamp < 60000).length,
			perHour: this.sent.filter(timestamp => now - timestamp < 3600000).length,
			perDay: this.sent.length,
			limits: this.config
		};
	}
}

// ─── Warmup ─────────────────────────────────────────────────────────────────

export class WarmUp {
	constructor(config = {}) {
		this.config = {
			dayOneLimit: config.dayOneLimit ?? 20,
			growthPerDay: config.growthPerDay ?? 20,
			maxPerDay: config.maxPerDay ?? 1500,
			days: config.days ?? 7
		};
		this.startDate = config.startDate ? new Date(config.startDate) : new Date();
		this.counters = config.counters ? { ...config.counters } : {};
	}

	dayIndex(now = Date.now()) {
		return Math.max(1, Math.floor((now - this.startDate.getTime()) / 86400000) + 1);
	}

	limitForDay(day = this.dayIndex()) {
		if (day > this.config.days) return this.config.maxPerDay;
		return Math.min(this.config.dayOneLimit + (day - 1) * this.config.growthPerDay, this.config.maxPerDay);
	}

	allows(now = Date.now()) {
		const day = this.dayIndex(now);
		return (this.counters[day] || 0) < this.limitForDay(day);
	}

	record(now = Date.now()) {
		const day = this.dayIndex(now);
		this.counters[day] = (this.counters[day] || 0) + 1;
	}

	status(now = Date.now()) {
		const day = this.dayIndex(now);
		return {
			day,
			used: this.counters[day] || 0,
			limit: this.limitForDay(day),
			warmedUp: day > this.config.days
		};
	}

	toJSON() {
		return { startDate: this.startDate.toISOString(), counters: this.counters };
	}

	static fromJSON(json, config) {
		return new WarmUp({ ...config, startDate: json.startDate, counters: json.counters });
	}
}

// ─── Group operation guard ──────────────────────────────────────────────────

export const GROUP_OP_ERRORS = {
	REACHOUT_RESTRICTED: 'reachout_restricted',
	RATE_OVERLIMIT: 'rate_overlimit',
	PRIVACY_BLOCK: 'privacy_block',
	NOT_AUTHORIZED: 'not_authorized',
	UNKNOWN: 'unknown'
};

export function classifyGroupOpError(error) {
	const code = error?.output?.statusCode ?? error?.statusCode ?? error?.data;
	if (code === 463) return GROUP_OP_ERRORS.REACHOUT_RESTRICTED;
	if (code === 429) return GROUP_OP_ERRORS.RATE_OVERLIMIT;
	if (code === 403) return GROUP_OP_ERRORS.PRIVACY_BLOCK;
	if (code === 401 || code === 406) return GROUP_OP_ERRORS.NOT_AUTHORIZED;
	return GROUP_OP_ERRORS.UNKNOWN;
}

export class GroupOperationGuard {
	constructor(config = {}) {
		this.limits = {
			add: { max: 3, windowMs: 600000 },
			create: { max: 2, windowMs: 600000 },
			remove: { max: 5, windowMs: 600000 },
			promote: { max: 10, windowMs: 600000 },
			demote: { max: 10, windowMs: 600000 },
			...config.limits
		};
		this.history = new Map();
	}

	_can(action) {
		const limit = this.limits[action] || { max: 5, windowMs: 600000 };
		const now = Date.now();
		const recent = (this.history.get(action) || []).filter(timestamp => now - timestamp < limit.windowMs);
		this.history.set(action, recent);
		return recent.length < limit.max;
	}

	record(action) {
		const list = this.history.get(action) || [];
		list.push(Date.now());
		this.history.set(action, list);
	}

	async run(action, task) {
		if (!this._can(action)) {
			const error = new Error(`Group operation "${action}" rate limit reached`);
			error.code = GROUP_OP_ERRORS.RATE_OVERLIMIT;
			throw error;
		}
		this.record(action);
		return task();
	}
}

// ─── 463 timelock guard ─────────────────────────────────────────────────────

export class TimelockGuard {
	constructor(config = {}) {
		this.baseMs = config.baseMs ?? 15 * 60 * 1000;
		this.maxMs = config.maxMs ?? 24 * 60 * 60 * 1000;
		this.strikes = 0;
		this.until = 0;
	}

	isBlocked(now = Date.now()) {
		return now < this.until;
	}

	remainingMs(now = Date.now()) {
		return Math.max(0, this.until - now);
	}

	recordRestriction(now = Date.now()) {
		this.strikes++;
		const duration = Math.min(this.baseMs * 2 ** (this.strikes - 1), this.maxMs);
		this.until = now + duration;
		return duration;
	}

	reset() {
		this.strikes = 0;
		this.until = 0;
	}

	status(now = Date.now()) {
		return { blocked: this.isBlocked(now), remainingMs: this.remainingMs(now), strikes: this.strikes };
	}
}

// ─── Reconnect throttle ─────────────────────────────────────────────────────

export class ReconnectThrottle {
	constructor(config = {}) {
		this.baseMs = config.baseMs ?? 2000;
		this.factor = config.factor ?? 2;
		this.maxMs = config.maxMs ?? 5 * 60 * 1000;
		this.jitter = config.jitter ?? 0.2;
		this.attempts = 0;
	}

	nextDelay() {
		const raw = Math.min(this.baseMs * this.factor ** this.attempts, this.maxMs);
		this.attempts++;
		const jitter = 1 + (Math.random() * 2 - 1) * this.jitter;
		return Math.round(raw * jitter);
	}

	recordSuccess() {
		this.attempts = 0;
	}
}

// ─── Human entropy (opt-in background behaviour) ────────────────────────────

export class HumanEntropy {
	constructor(sock, config = {}) {
		this.sock = sock;
		this.config = {
			typingProbability: config.typingProbability ?? 0.3,
			presenceIntervalMs: config.presenceIntervalMs ?? 60000,
			readDelay: config.readDelay ?? [1000, 4000],
			jids: config.jids ?? []
		};
		this.timer = null;
	}

	async simulateTyping(jid, durationMs) {
		const duration = durationMs ?? gaussian(1200, 4500);
		try {
			await this.sock.sendPresenceUpdate?.('composing', jid);
			await new Promise(resolve => setTimeout(resolve, duration));
			await this.sock.sendPresenceUpdate?.('paused', jid);
		} catch {}
	}

	async simulateRead(key) {
		const [min, max] = this.config.readDelay;
		await new Promise(resolve => setTimeout(resolve, gaussian(min, max)));
		try {
			await this.sock.readMessages?.([key]);
		} catch {}
	}

	start() {
		if (this.timer) return;
		this.timer = setInterval(async () => {
			if (!this.config.jids.length) return;
			const jid = this.config.jids[Math.floor(Math.random() * this.config.jids.length)];
			if (Math.random() < this.config.typingProbability) await this.simulateTyping(jid);
			else {
				try {
					await this.sock.sendPresenceUpdate?.('available');
				} catch {}
			}
		}, this.config.presenceIntervalMs);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

// ─── wrapSocket ─────────────────────────────────────────────────────────────

const WRAPPED = Symbol.for('baileys.antiban.wrapped');

/**
 * Wrap a socket with the opt-in anti-ban layers. Returns the same socket.
 * @param {object} sock live socket
 * @param {object} [options] { rateLimiter, warmup, groupGuard, timelockGuard, reconnectThrottle, humanEntropy }
 */
export const wrapSocket = (sock, options = {}) => {
	if (sock[WRAPPED]) return sock;
	sock[WRAPPED] = true;

	const rateLimiter = options.rateLimiter === false ? null : new RateLimiter(options.rateLimiter || {});
	const warmup = options.warmup === false ? null : new WarmUp(options.warmup || {});
	const groupGuard = options.groupGuard === false ? null : new GroupOperationGuard(options.groupGuard || {});
	const timelockGuard = options.timelockGuard === false ? null : new TimelockGuard(options.timelockGuard || {});
	const reconnectThrottle = options.reconnectThrottle === false ? null : new ReconnectThrottle(options.reconnectThrottle || {});
	const humanEntropy = options.humanEntropy ? new HumanEntropy(sock, options.humanEntropy) : null;

	const originalSendMessage = sock.sendMessage?.bind(sock);
	if (originalSendMessage) {
		sock.sendMessage = async (jid, content, sendOptions = {}) => {
			if (timelockGuard?.isBlocked()) {
				throw new Error(`Timelock active: ${timelockGuard.remainingMs()}ms remaining`);
			}
			if (warmup && !warmup.allows()) {
				throw new Error(`Warmup daily limit reached (${warmup.status().limit}/day)`);
			}
			try {
				const send = () => originalSendMessage(jid, content, sendOptions);
				const result = rateLimiter ? await rateLimiter.schedule(send, content) : await send();
				warmup?.record();
				rateLimiter?.markChatSeen(jid);
				if (humanEntropy) {
					void humanEntropy.simulateRead({ remoteJid: jid, id: result?.key?.id, fromMe: true });
				}
				return result;
			} catch (error) {
				const code = error?.output?.statusCode ?? error?.statusCode ?? error?.data;
				if (code === 463) timelockGuard?.recordRestriction();
				throw error;
			}
		};
	}

	for (const method of ['groupParticipantsUpdate', 'groupCreate', 'groupLeave', 'groupUpdateSubject', 'groupUpdateDescription']) {
		const original = sock[method]?.bind(sock);
		if (!original) continue;
		sock[method] = async (...args) => {
			const action = method === 'groupParticipantsUpdate' ? args[2] || 'update' : 'create';
			return groupGuard ? groupGuard.run(action, () => original(...args)) : original(...args);
		};
	}

	sock.antiban = {
		rateLimiter,
		warmup,
		groupGuard,
		timelockGuard,
		reconnectThrottle,
		humanEntropy,
		unwire: () => {
			if (originalSendMessage) sock.sendMessage = originalSendMessage;
			sock[WRAPPED] = false;
			humanEntropy?.stop();
		}
	};

	return sock;
};
