// Minimal ZIP archive writer (STORE method, no compression) and CRC-32.
//
// WhatsApp sticker packs are WebP files, already compressed, so storing
// them uncompressed costs nothing — and it keeps this dependency-free
// (Node has no built-in ZIP writer).

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

export const crc32 = (data) => {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
};

const dosDateTime = (date) => {
	const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
	const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
	return { time, date: dosDate };
};

/**
 * Build a ZIP archive with STORE (uncompressed) entries.
 * The result is a standard ZIP readable by any unzip implementation.
 *
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer}
 */
export const createZip = (entries) => {
	const now = dosDateTime(new Date());
	const localParts = [];
	const centralParts = [];
	let offset = 0;

	for (const { name, data } of entries) {
		const nameBuf = Buffer.from(name, 'utf-8');
		const crc = crc32(data);
		const size = data.length;

		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
		localHeader.writeUInt16LE(20, 4); // version needed to extract
		localHeader.writeUInt16LE(0, 6); // flags
		localHeader.writeUInt16LE(0, 8); // method: STORE
		localHeader.writeUInt16LE(now.time, 10);
		localHeader.writeUInt16LE(now.date, 12);
		localHeader.writeUInt32LE(crc, 14);
		localHeader.writeUInt32LE(size, 18); // compressed size (= size for STORE)
		localHeader.writeUInt32LE(size, 22); // uncompressed size
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28); // extra field length

		localParts.push(localHeader, nameBuf, data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
		centralHeader.writeUInt16LE(20, 4); // version made by
		centralHeader.writeUInt16LE(20, 6); // version needed to extract
		centralHeader.writeUInt16LE(0, 8); // flags
		centralHeader.writeUInt16LE(0, 10); // method: STORE
		centralHeader.writeUInt16LE(now.time, 12);
		centralHeader.writeUInt16LE(now.date, 14);
		centralHeader.writeUInt32LE(crc, 16);
		centralHeader.writeUInt32LE(size, 20);
		centralHeader.writeUInt32LE(size, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30); // extra field length
		centralHeader.writeUInt16LE(0, 32); // comment length
		centralHeader.writeUInt16LE(0, 34); // disk number
		centralHeader.writeUInt16LE(0, 36); // internal attributes
		centralHeader.writeUInt32LE(0, 38); // external attributes
		centralHeader.writeUInt32LE(offset, 42); // offset of local header

		centralParts.push(centralHeader, nameBuf);

		offset += localHeader.length + nameBuf.length + data.length;
	}

	const centralDir = Buffer.concat(centralParts);
	const endRecord = Buffer.alloc(22);
	endRecord.writeUInt32LE(0x06054b50, 0); // end of central directory signature
	endRecord.writeUInt16LE(0, 4); // disk number
	endRecord.writeUInt16LE(0, 6); // disk of central directory
	endRecord.writeUInt16LE(entries.length, 8); // entries on this disk
	endRecord.writeUInt16LE(entries.length, 10); // total entries
	endRecord.writeUInt32LE(centralDir.length, 12);
	endRecord.writeUInt32LE(offset, 16); // offset of central directory
	endRecord.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...localParts, centralDir, endRecord]);
};
