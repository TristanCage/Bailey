/**
 * In-process message scheduler (local queue). Complements server-side
 * scheduled messages in lib/ScheduledMessages.
 * Ported from @innovatorssoft/baileys (MIT, innovatorssoft) with attribution.
 */

export class MessageScheduler {
	constructor(sendMessage, options = {}) {
		this.queue = new Map();
		this.timer = null;
		this.sendMessage = sendMessage;
		this.options = {
			maxQueue: options.maxQueue ?? 1000,
			checkInterval: options.checkInterval ?? 1000,
			onSent: options.onSent ?? (() => {}),
			onFailed: options.onFailed ?? (() => {})
		};
	}

	generateId() {
		return `sched_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	schedule(jid, content, scheduledTime, options = {}) {
		if (this.queue.size >= this.options.maxQueue) throw new Error(`Maximum queue size (${this.options.maxQueue}) reached`);
		if (scheduledTime.getTime() <= Date.now()) throw new Error('Scheduled time must be in the future');
		const scheduled = {
			id: this.generateId(),
			jid,
			content,
			options,
			scheduledTime,
			createdAt: new Date(),
			status: 'pending'
		};
		this.queue.set(scheduled.id, scheduled);
		this.ensureTimerRunning();
		return scheduled;
	}

	scheduleDelay(jid, content, delayMs, options = {}) {
		return this.schedule(jid, content, new Date(Date.now() + delayMs), options);
	}

	cancel(id) {
		const scheduled = this.queue.get(id);
		if (scheduled?.status === 'pending') {
			scheduled.status = 'cancelled';
			this.queue.delete(id);
			return true;
		}
		return false;
	}

	cancelForJid(jid) {
		let cancelled = 0;
		for (const [id, scheduled] of this.queue) {
			if (scheduled.jid === jid && scheduled.status === 'pending') {
				scheduled.status = 'cancelled';
				this.queue.delete(id);
				cancelled++;
			}
		}
		return cancelled;
	}

	getPending() {
		return [...this.queue.values()].filter(scheduled => scheduled.status === 'pending');
	}

	get(id) {
		return this.queue.get(id);
	}

	clearAll() {
		const count = this.queue.size;
		this.queue.clear();
		this.stopTimer();
		return count;
	}

	async processQueue() {
		const now = Date.now();
		for (const [id, scheduled] of [...this.queue]) {
			if (scheduled.status !== 'pending' || scheduled.scheduledTime.getTime() > now) continue;
			try {
				const message = await this.sendMessage(scheduled.jid, scheduled.content, scheduled.options);
				scheduled.status = 'sent';
				scheduled.messageId = message?.key?.id;
				this.options.onSent(scheduled, message);
			} catch (error) {
				scheduled.status = 'failed';
				scheduled.error = error.message;
				this.options.onFailed(scheduled, error);
			}
			this.queue.delete(id);
		}
		if (this.queue.size === 0) this.stopTimer();
	}

	ensureTimerRunning() {
		if (!this.timer) {
			this.timer = setInterval(() => this.processQueue().catch(() => {}), this.options.checkInterval);
			this.timer.unref?.();
		}
	}

	stopTimer() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	stop() {
		this.stopTimer();
	}

	start() {
		if (this.queue.size > 0) this.ensureTimerRunning();
	}
}

export const createMessageScheduler = (sendMessage, options) => new MessageScheduler(sendMessage, options);
