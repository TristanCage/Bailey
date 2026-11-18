/**
 * Minimal Argo (GraphQL binary serialization) decoder for WhatsApp MEX responses.
 *
 * WhatsApp can answer `<result format="argo">` with an Argo-encoded GraphQL
 * response instead of JSON. Argo is normally not self-describing — it needs the
 * wire schema generated from the query and GraphQL schema. WhatsApp's MEX
 * responses, however, are encoded with the `SelfDescribing` flag set, which
 * means the Core is written as a `DESC` value and can be decoded without any
 * wire schema. This module implements just that mode.
 *
 * Spec: https://github.com/msolomon/argo/blob/main/spec.md (v1.2.0).
 *
 * The decoder never trusts the payload: every read is bounds checked and any
 * malformed input throws a descriptive error (mex.js wraps it in a Boom with a
 * base64 preview of the payload).
 */

const HEADER_FLAG = {
    InlineEverything: 0,
    SelfDescribing: 1,
    OutOfBandFieldErrors: 2,
    SelfDescribingErrors: 3,
    NullTerminatedStrings: 4,
    NoDeduplication: 5,
    HasUserFlags: 6
};

const TYPE_MARKER = {
    Null: -1n,
    False: 0n,
    True: 1n,
    Object: 2n,
    List: 3n,
    String: 4n,
    Bytes: 5n,
    Int: 6n,
    Float: 7n
};

const toBuffer = (value) => {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === 'string') {
        return Buffer.from(value, 'utf-8');
    }
    throw new Error(`unsupported Argo payload type: ${typeof value}`);
};

class Cursor {
    constructor(buffer, label) {
        this.buffer = buffer;
        this.label = label;
        this.position = 0;
    }

    get remaining() {
        return this.buffer.length - this.position;
    }

    byte() {
        if (this.position >= this.buffer.length) {
            throw new Error(`unexpected end of Argo payload while reading ${this.label}`);
        }
        return this.buffer[this.position++];
    }

    read(length) {
        if (length < 0 || length > this.remaining) {
            throw new Error(`Argo ${this.label} read of ${length} bytes exceeds ${this.remaining} remaining bytes`);
        }
        const start = this.position;
        this.position += length;
        return this.buffer.subarray(start, this.position);
    }
}

/** Unsigned LEB128, as used by Argo's zig-zag Label/VarInt encoding. */
const readUnsignedVarint = (cursor) => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
        const octet = cursor.byte();
        result |= BigInt(octet & 0x7f) << shift;
        if ((octet & 0x80) === 0) {
            return result;
        }
        shift += 7n;
        if (shift > 63n) {
            throw new Error('Argo integer encoding exceeds 64 bits');
        }
    }
};

const fromZigZag = (value) => (value & 0x1n) ? ((value >> 1n) ^ ~0n) : (value >> 1n);
const readLabel = (cursor) => fromZigZag(readUnsignedVarint(cursor));

/** Variable-length bitset: (byte >> 1) contributes 7 bits, low bit means "more". */
const readBitSet = (cursor) => {
    let bits = 0n;
    let bitPosition = 0n;
    let octet;
    do {
        octet = cursor.byte();
        bits |= BigInt((octet >> 1) & 0x7f) << bitPosition;
        bitPosition += 7n;
    } while ((octet & 0x01) === 1);
    return bits;
};

const hasFlag = (bits, flag) => (bits & (1n << BigInt(flag))) !== 0n;

/**
 * Decode an Argo message that was written in SelfDescribing mode.
 * Returns the GraphQL execution result as a plain JS object.
 */
export const decodeArgoSelfDescribing = (payload) => {
    const bytes = toBuffer(payload);
    if (!bytes.length) {
        throw new Error('empty Argo payload');
    }
    const cursor = new Cursor(bytes, 'header');
    const flags = readBitSet(cursor);
    if (!hasFlag(flags, HEADER_FLAG.SelfDescribing)) {
        throw new Error('Argo payload is not in SelfDescribing mode (cannot decode without a wire schema)');
    }
    if (hasFlag(flags, HEADER_FLAG.HasUserFlags)) {
        readBitSet(cursor);
    }
    const inlineEverything = hasFlag(flags, HEADER_FLAG.InlineEverything);
    const nullTerminatedStrings = hasFlag(flags, HEADER_FLAG.NullTerminatedStrings);

    let blocks = [];
    let core;
    if (inlineEverything) {
        core = new Cursor(cursor.read(cursor.remaining), 'core');
    }
    else {
        while (cursor.remaining > 0) {
            const lengthLabel = readLabel(cursor);
            if (lengthLabel < 0n) {
                throw new Error(`invalid Argo block length: ${lengthLabel}`);
            }
            const length = Number(lengthLabel);
            blocks.push(cursor.read(length));
        }
        if (!blocks.length) {
            throw new Error('Argo payload has no Core block');
        }
        core = new Cursor(blocks.pop(), 'core');
    }

    // Blocks are assigned to their scalar type on first use, in message order.
    const readers = new Map();
    const getReader = (key) => {
        let reader = readers.get(key);
        if (!reader) {
            if (!blocks.length) {
                throw new Error(`Argo payload is missing the ${key} block`);
            }
            reader = { buffer: blocks.shift(), position: 0, seen: [] };
            readers.set(key, reader);
        }
        return reader;
    };

    const textDecoder = new TextDecoder('utf-8', { fatal: false });

    const readFromBlock = (key, length, decode) => {
        const reader = getReader(key);
        if (length < 0 || reader.position + length > reader.buffer.length) {
            throw new Error(`Argo ${key} value of ${length} bytes exceeds its ${reader.buffer.length}-byte block`);
        }
        const value = decode(reader.buffer.subarray(reader.position, reader.position + length), reader);
        reader.position += length;
        if (key === 'String' && nullTerminatedStrings) {
            reader.position += 1;
        }
        return value;
    };

    const readBackref = (key, label) => {
        const reader = getReader(key);
        const index = Number(-label - 4n);
        const value = reader.seen[index];
        if (value === undefined) {
            throw new Error(`invalid Argo ${key} backreference: ${label}`);
        }
        return value;
    };

    const readString = () => {
        const label = readLabel(core);
        if (label >= 0n) {
            const value = readFromBlock('String', Number(label), (bytes) => textDecoder.decode(bytes));
            getReader('String').seen.push(value);
            return value;
        }
        if (label >= -3n) {
            throw new Error(`unexpected Argo string label: ${label}`);
        }
        return readBackref('String', label);
    };

    const readBytes = () => {
        const label = readLabel(core);
        if (label >= 0n) {
            const value = readFromBlock('Bytes', Number(label), (bytes) => Buffer.from(bytes));
            getReader('Bytes').seen.push(value);
            return value;
        }
        if (label >= -3n) {
            throw new Error(`unexpected Argo bytes label: ${label}`);
        }
        return readBackref('Bytes', label);
    };

    const readInt = () => {
        const reader = getReader('Int');
        const blockCursor = new Cursor(reader.buffer, 'Int');
        blockCursor.position = reader.position;
        const value = Number(readLabel(blockCursor));
        reader.position = blockCursor.position;
        return value;
    };

    const readFloat = () => {
        const reader = getReader('Float');
        const bytes = readFromBlock('Float', 8, (chunk) => chunk);
        return bytes.readDoubleLE(0);
    };

    const readDesc = (depth) => {
        if (depth > 100) {
            throw new Error('Argo payload nesting is too deep');
        }
        const marker = readLabel(core);
        switch (marker) {
            case TYPE_MARKER.Null:
                return null;
            case TYPE_MARKER.False:
                return false;
            case TYPE_MARKER.True:
                return true;
            case TYPE_MARKER.Object: {
                const lengthLabel = readLabel(core);
                if (lengthLabel < 0n || lengthLabel > 100000n) {
                    throw new Error(`invalid Argo object field count: ${lengthLabel}`);
                }
                const result = {};
                for (let i = 0; i < Number(lengthLabel); i++) {
                    const name = readString();
                    result[name] = readDesc(depth + 1);
                }
                return result;
            }
            case TYPE_MARKER.List: {
                const lengthLabel = readLabel(core);
                if (lengthLabel < 0n || lengthLabel > 100000n) {
                    throw new Error(`invalid Argo list length: ${lengthLabel}`);
                }
                const result = [];
                for (let i = 0; i < Number(lengthLabel); i++) {
                    result.push(readDesc(depth + 1));
                }
                return result;
            }
            case TYPE_MARKER.String:
                return readString();
            case TYPE_MARKER.Bytes:
                return readBytes();
            case TYPE_MARKER.Int:
                return readInt();
            case TYPE_MARKER.Float:
                return readFloat();
            default:
                throw new Error(`invalid Argo self-describing type marker: ${marker}`);
        }
    };

    return readDesc(0);
};

export default decodeArgoSelfDescribing;
