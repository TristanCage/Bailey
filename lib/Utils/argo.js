/**
 * Argo (GraphQL binary serialization) decoder for WhatsApp MEX responses.
 *
 * WhatsApp answers `<result format="argo">` even though the header advertises
 * SelfDescribing mode. The Core is still written against the query's wire
 * schema, so it has to be read field by field in query order. SCHEMAS below
 * mirror WAWebMexFetchNewsletterJobQuery (and the related newsletter jobs).
 *
 * Spec: https://github.com/msolomon/argo/blob/main/spec.md (v1.2.0).
 * Every read is bounds checked; malformed payloads throw a descriptive Error.
 */

const FLAG = {
    InlineEverything: 0,
    SelfDescribing: 1,
    OutOfBandFieldErrors: 2,
    SelfDescribingErrors: 3,
    NullTerminatedStrings: 4,
    NoDeduplication: 5,
    HasUserFlags: 6
};

const ABSENT = Symbol('argo.absent');
const errorMessages = {
    end: 'unexpected end of Argo payload',
    truncated: 'Argo value exceeds its block'
};

const hasFlag = (bits, flag) => (bits & (1n << BigInt(flag))) !== 0n;

class Cursor {
    constructor(buffer, label) {
        this.buffer = buffer;
        this.position = 0;
        this.label = label;
    }

    get remaining() {
        return this.buffer.length - this.position;
    }

    byte() {
        if (this.position >= this.buffer.length) {
            throw new Error(`${errorMessages.end} while reading ${this.label}`);
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

const splitMessage = (payload) => {
    const bytes = toBuffer(payload);
    if (!bytes.length) {
        throw new Error('empty Argo payload');
    }
    const cursor = new Cursor(bytes, 'header');
    const flags = readBitSet(cursor);
    if (hasFlag(flags, FLAG.HasUserFlags)) {
        readBitSet(cursor);
    }
    const nullTerminatedStrings = hasFlag(flags, FLAG.NullTerminatedStrings);
    if (hasFlag(flags, FLAG.InlineEverything)) {
        return { flags, blocks: [], core: new Cursor(cursor.read(cursor.remaining), 'core'), nullTerminatedStrings };
    }
    const blocks = [];
    while (cursor.remaining > 0) {
        const length = readLabel(cursor);
        if (length < 0n) {
            throw new Error(`invalid Argo block length: ${length}`);
        }
        blocks.push(cursor.read(Number(length)));
    }
    if (!blocks.length) {
        throw new Error('Argo payload has no Core block');
    }
    return { flags, blocks: blocks.slice(0, -1), core: new Cursor(blocks[blocks.length - 1], 'core'), nullTerminatedStrings };
};

class Reader {
    constructor(parts) {
        this.blocks = parts.blocks.slice();
        this.core = parts.core;
        this.nullTerminatedStrings = parts.nullTerminatedStrings;
        this.readers = new Map();
        this.text = new TextDecoder('utf-8', { fatal: false });
    }

    block(key) {
        let reader = this.readers.get(key);
        if (!reader) {
            if (!this.blocks.length) {
                throw new Error(`Argo payload is missing the ${key} block`);
            }
            reader = { buffer: this.blocks.shift(), position: 0, seen: [] };
            this.readers.set(key, reader);
        }
        return reader;
    }

    take(key, length) {
        const reader = this.block(key);
        if (length < 0 || reader.position + length > reader.buffer.length) {
            throw new Error(`Argo ${key} value of ${length} bytes exceeds its ${reader.buffer.length}-byte block`);
        }
        const bytes = reader.buffer.subarray(reader.position, reader.position + length);
        reader.position += length;
        return bytes;
    }

    string(label, key = 'String') {
        const reader = this.block(key);
        if (label >= 0n) {
            const value = this.text.decode(this.take(key, Number(label)));
            if (this.nullTerminatedStrings) {
                reader.position += 1;
            }
            reader.seen.push(value);
            return value;
        }
        const value = reader.seen[Number(-label - 4n)];
        if (value === undefined) {
            throw new Error(`invalid Argo ${key} backreference: ${label}`);
        }
        return value;
    }

    bytes(label, key = 'Bytes') {
        const reader = this.block(key);
        if (label >= 0n) {
            const value = Buffer.from(this.take(key, Number(label)));
            reader.seen.push(value);
            return value;
        }
        const value = reader.seen[Number(-label - 4n)];
        if (value === undefined) {
            throw new Error(`invalid Argo ${key} backreference: ${label}`);
        }
        return value;
    }

    int(key) {
        const reader = this.block(key);
        const cursor = new Cursor(reader.buffer, key);
        cursor.position = reader.position;
        const value = Number(readLabel(cursor));
        reader.position = cursor.position;
        return value;
    }

    float(key) {
        const bytes = this.take(key, 8);
        return bytes.readDoubleLE(0);
    }

    record(node) {
        const result = {};
        for (const field of node.fields) {
            const value = this.field(field);
            if (value !== ABSENT) {
                result[field.name] = value;
            }
        }
        return result;
    }

    decode(node) {
        if (node.k === 'record') {
            return this.record(node);
        }
        return this.labeled(node, readLabel(this.core));
    }

    field(field) {
        const node = field.node;
        if (field.omittable) {
            const label = readLabel(this.core);
            if (label === -2n) {
                return ABSENT;
            }
            if (node.nullable) {
                if (label === -1n) {
                    return null;
                }
                return this.labeled(node, label);
            }
            if (label === -1n) {
                return null;
            }
            if (isLabeled(node)) {
                return this.labeled(node, label);
            }
            if (label !== 0n) {
                throw new Error(`expected Argo non-null marker for ${field.name}, got ${label}`);
            }
            return this.value(node);
        }
        if (node.nullable) {
            const label = readLabel(this.core);
            if (label === -1n) {
                return null;
            }
            if (label === -2n) {
                throw new Error(`unexpected Argo absent label for ${field.name}`);
            }
            if (isLabeled(node)) {
                return this.labeled(node, label);
            }
            if (label !== 0n) {
                throw new Error(`expected Argo non-null marker for ${field.name}, got ${label}`);
            }
            return this.value(node);
        }
        if (isLabeled(node)) {
            return this.labeled(node, readLabel(this.core));
        }
        return this.value(node);
    }

    labeled(node, label) {
        if (node.k === 'list') {
            if (label < 0n || label > 100000n) {
                throw new Error(`invalid Argo list length: ${label}`);
            }
            const items = [];
            for (let i = 0; i < Number(label); i++) {
                items.push(node.item.nullable ? this.labeled(node.item, readLabel(this.core)) : this.value(node.item));
            }
            return items;
        }
        if (node.k === 'path') {
            if (label < 0n || label > 100000n) {
                throw new Error(`invalid Argo path length: ${label}`);
            }
            const segments = [];
            for (let i = 0; i < Number(label); i++) {
                segments.push(Number(readLabel(this.core)));
            }
            return segments;
        }
        if (node.k === 'record') {
            if (label === -1n) {
                return null;
            }
            if (label !== 0n) {
                throw new Error(`expected Argo non-null marker for record, got ${label}`);
            }
            return this.value(node);
        }
        if (node.k === 'desc') {
            return this.desc(label);
        }
        if (node.k !== 'scalar') {
            throw new Error(`Argo ${node.k} cannot be read as a labeled value`);
        }
        if (node.type === 'STRING') {
            return this.string(label, node.block);
        }
        if (node.type === 'BYTES') {
            return this.bytes(label, node.block);
        }
        if (node.type === 'BOOLEAN') {
            return label === 1n;
        }
        throw new Error(`Argo ${node.type} is not a labeled type`);
    }

    value(node) {
        if (node.k === 'record') {
            return this.record(node);
        }
        if (node.k === 'path') {
            const length = readLabel(this.core);
            if (length < 0n || length > 100000n) {
                throw new Error(`invalid Argo path length: ${length}`);
            }
            const segments = [];
            for (let i = 0; i < Number(length); i++) {
                segments.push(Number(readLabel(this.core)));
            }
            return segments;
        }
        if (node.k !== 'scalar') {
            throw new Error(`Argo ${node.k} cannot be read as an unlabeled value`);
        }
        if (node.type === 'VARINT') {
            return this.int(node.block);
        }
        if (node.type === 'FLOAT64') {
            return this.float(node.block);
        }
        throw new Error(`Argo ${node.type} is not an unlabeled type`);
    }

    desc(marker = readLabel(this.core)) {
        switch (marker) {
            case -1n:
                return null;
            case 0n:
                return false;
            case 1n:
                return true;
            case 2n: {
                const length = readLabel(this.core);
                if (length < 0n || length > 100000n) {
                    throw new Error(`invalid Argo object field count: ${length}`);
                }
                const result = {};
                for (let i = 0; i < Number(length); i++) {
                    result[this.string(readLabel(this.core))] = this.desc();
                }
                return result;
            }
            case 3n: {
                const length = readLabel(this.core);
                if (length < 0n || length > 100000n) {
                    throw new Error(`invalid Argo list length: ${length}`);
                }
                const result = [];
                for (let i = 0; i < Number(length); i++) {
                    result.push(this.desc());
                }
                return result;
            }
            case 4n:
                return this.string(readLabel(this.core));
            case 5n:
                return this.bytes(readLabel(this.core));
            case 6n:
                return this.int('Int');
            case 7n:
                return this.float('Float');
            default:
                throw new Error(`invalid Argo self-describing type marker: ${marker}`);
        }
    }
}

const isLabeled = (node) => node.k === 'list' || node.k === 'desc' || node.k === 'path' ||
    (node.k === 'scalar' && (node.type === 'STRING' || node.type === 'BYTES' || node.type === 'BOOLEAN'));

const record = (fields, options = {}) => ({ k: 'record', fields, nullable: !(options && options.nonNull) });
const pathNode = () => ({ k: 'path', nullable: false });
const string = (block = 'String') => ({ k: 'scalar', type: 'STRING', block, nullable: true });
const identifier = () => string('ID');
const integer = (block = 'Int') => ({ k: 'scalar', type: 'VARINT', block, nullable: true });
const enumeration = (block) => string(block);
const list = (item) => ({ k: 'list', item, nullable: true });
const desc = () => ({ k: 'desc', nullable: true });
const field = (name, node, options = {}) => ({
    name,
    node: options.nonNull ? { ...node, nullable: false } : node,
    omittable: !!options.omittable
});

const threadedSettings = record([
    field('reaction_codes', record([field('value', enumeration('XWA2NewsletterReactionCodesSettingValue'))]))
]);

const threadMetadata = record([
    field('creation_time', string(), { omittable: true }),
    field('name', record([
        field('id', identifier()),
        field('text', string()),
        field('update_time', string())
    ])),
    field('picture', record([
        field('id', identifier()),
        field('type', enumeration('XWA2PictureType')),
        field('direct_path', string())
    ]), { omittable: true }),
    field('preview', record([
        field('id', identifier()),
        field('type', enumeration('XWA2PictureType')),
        field('direct_path', string())
    ])),
    field('description', record([
        field('id', identifier()),
        field('text', string()),
        field('update_time', string())
    ])),
    field('invite', string()),
    field('handle', string()),
    field('subscribers_count', string()),
    field('verification', enumeration('XWA2NewsletterVerification')),
    field('settings', threadedSettings),
    field('wamo_sub', record([field('plan_id', string())]), { omittable: true }),
    field('pinned_messages', list(record([
        field('message_id', string()),
        field('expiry_ts', integer())
    ], { nonNull: true })), { omittable: true })
]);

const viewerSetting = record([
    field('type', enumeration('XWA2NewsletterUserSettingType')),
    field('value', string('XWA2NewsletterUserSettingValue'))
], { nonNull: true });

const viewerMetadata = record([
    field('settings', list(viewerSetting)),
    field('role', enumeration('XWA2NewsletterViewRole')),
    field('wamo_sub_status', string(), { omittable: true })
]);

const statusMetadata = record([
    field('last_status_server_id', string()),
    field('last_status_sent_time', integer())
]);

const newsletter = record([
    field('id', identifier()),
    field('state', record([field('type', enumeration('XWA2NewsletterStateType'))])),
    field('thread_metadata', threadMetadata),
    field('viewer_metadata', viewerMetadata, { omittable: true }),
    field('status_metadata', statusMetadata, { omittable: true })
]);

const newsletterSimple = record([
    field('id', identifier()),
    field('state', record([field('type', enumeration('XWA2NewsletterStateType'))]))
]);

const errorLocation = record([
    field('line', integer(), { nonNull: true }),
    field('column', integer(), { nonNull: true })
], { nonNull: true });

const errorItem = record([
    field('message', string(), { nonNull: true }),
    field('location', list(errorLocation), { omittable: true }),
    field('path', pathNode(), { omittable: true }),
    field('extensions', desc(), { omittable: true })
], { nonNull: true });

const errorNode = errorItem;

const schemaFor = (dataPath) => {
    switch (dataPath) {
        case 'xwa2_newsletter':
            return newsletter;
        case 'xwa2_newsletter_join_v2':
        case 'xwa2_newsletter_leave_v2':
            return newsletterSimple;
        case 'xwa2_newsletter_update':
        case 'xwa2_newsletter_create':
            return newsletter;
        case 'xwa2_newsletter_subscribed':
            return { ...list(newsletter), nullable: false };
        default:
            return null;
    }
};

const decodeWithSchema = (payload, schema) => {
    const parts = splitMessage(payload);
    if (hasFlag(parts.flags, FLAG.InlineEverything)) {
        throw new Error('Argo InlineEverything mode is not supported');
    }
    const reader = new Reader(parts);
    return reader.decode(schema);
};

export const hasArgoWireSchema = (dataPath) => schemaFor(dataPath) !== null;

export const recordNode = record;
export const fieldNode = field;
export const listNode = list;
export const stringNode = string;
export const integerNode = integer;
export const decodeArgoWithSchema = decodeWithSchema;

const rootSchemaFor = (dataPath) => {
    const inner = schemaFor(dataPath);
    if (!inner) {
        return null;
    }
    return record([
        field('data', record([field(dataPath, inner)])),
        field('errors', list(errorNode), { omittable: true }),
        field('extensions', desc(), { omittable: true })
    ]);
};

export const decodeArgoForDataPath = (payload, dataPath) => {
    const root = rootSchemaFor(dataPath);
    if (!root) {
        throw new Error(`no Argo wire schema for ${dataPath || 'unknown data path'}`);
    }
    return decodeWithSchema(payload, root);
};

export const decodeArgoSelfDescribing = (payload) => {
    const parts = splitMessage(payload);
    const reader = new Reader(parts);
    return reader.desc();
};

export default decodeArgoForDataPath;
