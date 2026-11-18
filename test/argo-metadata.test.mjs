import assert from 'node:assert/strict';
import test from 'node:test';
import { Boom } from '@hapi/boom';
import { decodeArgoSelfDescribing } from '../lib/Utils/argo.js';
import { executeWMexQuery } from '../lib/Socket/mex.js';

// --- tiny Argo SelfDescribing encoder, used only to build test fixtures ---
const zigzag = (n) => {
    const v = BigInt(n);
    return v >= 0n ? v << 1n : (v << 1n) ^ ~0n;
};
const varint = (n) => {
    let v = BigInt(n);
    const out = [];
    do {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v) byte |= 0x80;
        out.push(byte);
    } while (v);
    return Buffer.from(out);
};
const label = (n) => varint(zigzag(n));

const encodeFixture = (value) => {
    const strings = [];
    const string = (s, marker = true) => {
        const bytes = Buffer.from(s, 'utf-8');
        strings.push(bytes);
        return Buffer.concat([...(marker ? [label(4n)] : []), label(bytes.length)]);
    };
    const desc = (v) => {
        if (v === null) return label(-1n);
        if (v === false) return label(0n);
        if (v === true) return label(1n);
        if (typeof v === 'string') return string(v);
        if (Array.isArray(v)) {
            return Buffer.concat([label(3n), label(v.length), ...v.map(desc)]);
        }
        const entries = Object.entries(v);
        const parts = [label(2n), label(entries.length)];
        for (const [key, child] of entries) {
            parts.push(string(key, false), desc(child));
        }
        return Buffer.concat(parts);
    };

    const core = desc(value);
    const stringBlock = Buffer.concat(strings);
    return Buffer.concat([
        Buffer.from([0x04]), // header bitset: SelfDescribing
        label(stringBlock.length),
        stringBlock,
        label(core.length),
        core
    ]);
};

const groundTruth = {
    id: '120363413156936744@newsletter',
    state: { type: 'ACTIVE' },
    thread_metadata: {
        name: { text: 'Cypherx Space' },
        invite: '0029Vb8tzN4BFLgPH89T4I1I',
        verification: 'UNVERIFIED',
        picture: { direct_path: '/m1/v/t24/AQOYmpmif7KTgRXkyu-0-Z4CDC6goFK_3b', type: 'PREVIEW' }
    },
    viewer_metadata: { role: 'BASIC' }
};
const fixture = encodeFixture({ data: { xwa2_newsletter: groundTruth } });

test('decodes a SelfDescribing Argo newsletter metadata response', () => {
    const result = decodeArgoSelfDescribing(fixture);
    const meta = result.data.xwa2_newsletter;
    assert.equal(meta.id, '120363413156936744@newsletter');
    assert.equal(meta.state.type, 'ACTIVE');
    assert.equal(meta.thread_metadata.name.text, 'Cypherx Space');
    assert.equal(meta.thread_metadata.invite, '0029Vb8tzN4BFLgPH89T4I1I');
    assert.equal(meta.thread_metadata.verification, 'UNVERIFIED');
    assert.equal(meta.thread_metadata.picture.type, 'PREVIEW');
    assert.match(meta.thread_metadata.picture.direct_path, /^\/m1\/v\/t24\//);
    assert.equal(meta.viewer_metadata.role, 'BASIC');
});

test('malformed Argo payload throws a descriptive error, never a raw SyntaxError', () => {
    assert.throws(
        () => decodeArgoSelfDescribing(Buffer.from([0x04, 0xff, 0xff])),
        /Argo|end of Argo/
    );
});

test('executeWMexQuery routes format=argo through the decoder and preserves JSON behavior', async () => {
    const makeQuery = (content, attrs = {}) => async () => ({
        tag: 'iq',
        content: [{ tag: 'result', attrs, content }]
    });

    const argoResult = await executeWMexQuery({}, '27456920720571478', 'xwa2_newsletter', makeQuery(fixture, { format: 'argo' }), () => 'tag');
    assert.equal(argoResult.id, '120363413156936744@newsletter');
    assert.equal(argoResult.thread_metadata.name.text, 'Cypherx Space');

    const json = Buffer.from(JSON.stringify({ data: { xwa2_newsletter: groundTruth } }), 'utf-8');
    const jsonResult = await executeWMexQuery({}, 'qid', 'xwa2_newsletter', makeQuery(json), () => 'tag');
    assert.deepEqual(jsonResult, groundTruth);
});

test('executeWMexQuery wraps decoder failures in a Boom with a payload preview', async () => {
    const bad = Buffer.from([0x04, 0xff, 0xff]);
    const query = async () => ({ tag: 'iq', content: [{ tag: 'result', attrs: { format: 'argo' }, content: bad }] });
    await assert.rejects(
        () => executeWMexQuery({}, 'qid', 'xwa2_newsletter', query, () => 'tag'),
        (err) => err instanceof Boom && /Failed to decode Argo response/.test(err.message) && !!err.data?.preview
    );
});
