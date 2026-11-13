/**
 * Minimal ordered keyed collection (KeyedDB-compatible subset) used by the
 * in-memory store. Items are kept sorted by key (descending by default, like
 * WhatsApp chats) and indexed by id.
 */
export class KeyedDB {
	constructor(keySpec, idGetter) {
		this.keySpec = typeof keySpec === 'function' ? { key: keySpec } : keySpec;
		this.idGetter = idGetter;
		this._items = [];
		this._byId = new Map();
	}

	get array() {
		return this._items;
	}

	get length() {
		return this._items.length;
	}

	_key(item) {
		return this.keySpec?.key ? String(this.keySpec.key(item)) : '';
	}

	_sort() {
		const compare = this.keySpec?.compare;
		this._items.sort((a, b) => (compare ? compare(this._key(a), this._key(b)) : this._key(b).localeCompare(this._key(a))));
	}

	get(id) {
		return this._byId.get(id);
	}

	all() {
		return [...this._items];
	}

	upsert(...items) {
		for (const item of items) {
			if (!item) continue;
			const id = this.idGetter(item);
			if (this._byId.has(id)) {
				const index = this._items.findIndex(existing => this.idGetter(existing) === id);
				if (index >= 0) this._items[index] = item;
			} else {
				this._items.push(item);
			}
			this._byId.set(id, item);
		}
		this._sort();
	}

	insertIfAbsent(...items) {
		const inserted = [];
		for (const item of items) {
			if (!item) continue;
			const id = this.idGetter(item);
			if (this._byId.has(id)) continue;
			this._items.push(item);
			this._byId.set(id, item);
			inserted.push(item);
		}
		if (inserted.length) this._sort();
		return inserted;
	}

	update(id, updateFn) {
		const item = this._byId.get(id);
		if (!item) return undefined;
		updateFn(item);
		this._byId.set(this.idGetter(item), item);
		this._sort();
		return item;
	}

	deleteById(id) {
		const item = this._byId.get(id);
		if (!item) return false;
		this._byId.delete(id);
		const index = this._items.indexOf(item);
		if (index >= 0) this._items.splice(index, 1);
		return true;
	}

	delete(item) {
		return this.deleteById(this.idGetter(item));
	}

	filter(predicate) {
		this._items = this._items.filter(predicate);
		this._byId = new Map(this._items.map(item => [this.idGetter(item), item]));
		return this;
	}

	clear() {
		this._items = [];
		this._byId.clear();
	}

	count() {
		return this._items.length;
	}

	toJSON() {
		return this.all();
	}

	fromJSON(items) {
		this.clear();
		this.upsert(...items);
	}
}
