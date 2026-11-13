export function makeOrderedDictionary(idGetter) {
	const array = [];
	const dict = {};

	const get = id => dict[id];

	const update = item => {
		const id = idGetter(item);
		const index = array.findIndex(existing => idGetter(existing) === id);
		if (index >= 0) {
			array[index] = item;
			dict[id] = item;
		}
	};

	const upsert = (item, mode) => {
		const id = idGetter(item);
		if (get(id)) {
			update(item);
		} else {
			if (mode === 'append') array.push(item);
			else array.splice(0, 0, item);
			dict[id] = item;
		}
	};

	const remove = item => {
		const id = idGetter(item);
		const index = array.findIndex(existing => idGetter(existing) === id);
		if (index >= 0) {
			array.splice(index, 1);
			delete dict[id];
			return true;
		}
		return false;
	};

	return {
		array,
		get,
		upsert,
		update,
		remove,
		updateAssign: (id, changes) => {
			const item = get(id);
			if (item) {
				Object.assign(item, changes);
				delete dict[id];
				dict[idGetter(item)] = item;
				return true;
			}
			return false;
		},
		clear: () => {
			array.splice(0, array.length);
			for (const key of Object.keys(dict)) delete dict[key];
		},
		filter: contains => {
			let i = 0;
			while (i < array.length) {
				if (!contains(array[i])) {
					delete dict[idGetter(array[i])];
					array.splice(i, 1);
				} else {
					i += 1;
				}
			}
		},
		toJSON: () => array,
		fromJSON: newItems => {
			array.splice(0, array.length, ...newItems);
		}
	};
}
