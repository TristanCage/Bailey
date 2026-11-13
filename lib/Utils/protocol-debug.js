import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Dump protocol frames and startup context to disk for debugging.
 * Ported from @ubedsockets/baileys (MIT).
 *
 * Usage:
 *   const debug = new ProtocolDebug({ protocolDebug: true, protocolDebugDir: './logs/protocol' });
 *   debug.startup(config);
 *   debug.append('frames.jsonl', { direction: 'in', node });
 */
export class ProtocolDebug {
	constructor(config) {
		this.enabled = !!config?.protocolDebug;
		this.dir = config?.protocolDebugDir || './logs/protocol';
		this.init();
	}

	init() {
		if (!this.enabled) return;
		if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
	}

	startup(config) {
		if (!this.enabled) return;
		this.write('startup.json', {
			timestamp: this.timestamp(),
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			pid: process.pid,
			browser: config.browser,
			version: config.version,
			waWebSocketUrl:
				config.waWebSocketUrl instanceof URL ? config.waWebSocketUrl.toString() : config.waWebSocketUrl
		});
	}

	getPath(file) {
		return join(this.dir, file);
	}

	timestamp() {
		return new Date().toISOString();
	}

	write(file, data) {
		if (!this.enabled) return;
		writeFileSync(this.getPath(file), JSON.stringify(data, this.replacer, 2));
	}

	append(file, data) {
		if (!this.enabled) return;
		appendFileSync(
			this.getPath(file),
			JSON.stringify(Object.assign({ timestamp: this.timestamp() }, data), this.replacer, 2) + '\n'
		);
	}

	text(file, message) {
		if (!this.enabled) return;
		appendFileSync(this.getPath(file), `[${this.timestamp()}] ${message}\n`);
	}

	replacer(_key, value) {
		if (Buffer.isBuffer(value)) {
			return { type: 'Buffer', length: value.length, data: value.toString('base64') };
		}
		if (value instanceof Uint8Array) {
			return { type: 'Uint8Array', length: value.length, data: Buffer.from(value).toString('base64') };
		}
		if (typeof value === 'bigint') return value.toString();
		return value;
	}
}
