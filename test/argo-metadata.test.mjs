import assert from 'node:assert/strict';
import test from 'node:test';
import { Boom } from '@hapi/boom';
import { decodeArgoForDataPath, decodeArgoSelfDescribing, decodeArgoWithSchema, recordNode, fieldNode, listNode, stringNode } from '../lib/Utils/argo.js';
import { executeWMexQuery } from '../lib/Socket/mex.js';
import { buildNewsletterMetadataVariables, parseNewsletterMetadata } from '../lib/Socket/newsletter.js';

// Real 498-byte `<result format="argo">` captured from a live session for
// newsletterMetadata('invite', '0029Vb8tzN4BFLgPH89T4I1I').
const REAL_FIXTURE = Buffer.from(
    'BHoxMjAzNjM0MTMxNTY5MzY3NDRAbmV3c2xldHRlcjE3OTQ5OTA5Njg4MTQ2MDQxNzkxMjM5MTU3MzYzMzA1DEFDVElWRdwFMTc5MTIzOTE1N0N5cGhlclggU3BhY2UxNzk0OTkwOTY4ODE0NjA0L20xL3YvdDI0L0FRT1ltcG1pZjdLVGdSWGt5dS1PLVo0Q0RDNmdvRmtfM2ItanU4Q284RlNPVVhJSTBkaUN6a2ZSTHRCcVhVV1N3NVkwQk5YS0xscmtDSEJGQjZNU0FJaU0yRzhtT0tRbHI4MGxUQmpldnpMNWE5NWRraUNRS29NUTBMX1I4ODRJTDl1YXNULU9JUXNfWjFMSEZiVTNfekVKOFlRMS1xYz9zdHA9ZHN0LWpwZ19zMTkyeDE5Ml90dDYmY2NiPTEwLTUmb2g9MDFfUTVBYTZBSHNRd0dtOFlCdXBDZHdreS1CV0g5SEtXUENsbm5WcDNGeW1xeU1vbGlyRWcmb2U9NkIwMTQzNDYmX25jX3NpZD01ZTAzZTAmX25jX2NhdD0xMTAwMDI5VmI4dHpONEJGTGdQSDg5VDRJMUkzMjQ0DlBSRVZJRVcUVU5WRVJJRklFRApCQVNJQ0QAADoADAAUACAaIAEAIA7WBAAJAAswAQgUAAAKAwMBAwMD',
    'base64'
);

test('the captured fixture is the expected 498-byte Argo payload', () => {
    assert.equal(REAL_FIXTURE.length, 498);
    assert.equal(REAL_FIXTURE.subarray(0, 2).toString('hex'), '047a');
});

test('schema-driven decode reproduces the known channel record', () => {
    const response = decodeArgoForDataPath(REAL_FIXTURE, 'xwa2_newsletter');
    const meta = parseNewsletterMetadata(response.data.xwa2_newsletter);
    assert.equal(meta.id, '120363413156936744@newsletter');
    assert.equal(meta.state.type, 'ACTIVE');
    assert.equal(meta.thread_metadata.creation_time, '1791239157');
    assert.equal(meta.thread_metadata.name.id, '1794990968814604');
    assert.equal(meta.thread_metadata.name.text, 'CypherX Space');
    assert.equal(meta.thread_metadata.name.update_time, '1794990968814604');
    assert.equal(meta.thread_metadata.picture, null);
    assert.equal(meta.thread_metadata.preview.id, '1791239157363305');
    assert.equal(meta.thread_metadata.preview.type, 'PREVIEW');
    assert.match(meta.thread_metadata.preview.direct_path, /^\/m1\/v\/t24\//);
    assert.equal(meta.thread_metadata.description.text, '');
    assert.equal(meta.thread_metadata.invite, '0029Vb8tzN4BFLgPH89T4I1I');
    assert.equal(meta.thread_metadata.handle, null);
    assert.equal(meta.thread_metadata.subscribers_count, '3244');
    assert.equal(meta.thread_metadata.verification, 'UNVERIFIED');
    // The captured invite lookup carries "BASIC" as the reaction-codes setting;
    // the server returned viewer_metadata as null for this lookup.
    assert.equal(meta.thread_metadata.settings.reaction_codes.value, 'BASIC');
    assert.equal(meta.viewer_metadata, null);
});

test('decoder rejects a non-schema payload instead of returning a boolean', () => {
    assert.throws(
        () => decodeArgoForDataPath(Buffer.from([0x04, 0x00, 0x00]), 'xwa2_newsletter'),
        /Argo|end of Argo|block|marker/
    );
});

test('a genuine SelfDescribing payload still decodes', () => {
    // header 0x04 (SelfDescribing), one 6-byte String block ("A" + "hello"),
    // core: object(2), 1 field, name len 1, String marker(4), value len 5.
    const payload = Buffer.concat([
        Buffer.from([0x04, 0x0c]), // header, block length 6 (zigzag 12)
        Buffer.from('Ahello', 'utf-8'),
        Buffer.from([0x0a]), // core length 5 (zigzag 10)
        Buffer.from([0x04, 0x02, 0x02, 0x08, 0x0a])
    ]);
    const result = decodeArgoSelfDescribing(payload);
    assert.deepEqual(result, { A: 'hello' });
});

test('executeWMexQuery routes format=argo through the schema decoder', async () => {
    const makeQuery = (content, attrs = {}) => async () => ({
        tag: 'iq',
        content: [{ tag: 'result', attrs, content }]
    });
    const result = await executeWMexQuery({}, '27456920720571478', 'xwa2_newsletter', makeQuery(REAL_FIXTURE, { format: 'argo' }), () => 'tag');
    assert.equal(result.id, '120363413156936744@newsletter');
    assert.equal(result.thread_metadata.name.text, 'CypherX Space');
    assert.equal(result.thread_metadata.invite, '0029Vb8tzN4BFLgPH89T4I1I');
    assert.equal(result.thread_metadata.verification, 'UNVERIFIED');
});

test('executeWMexQuery keeps the JSON path unchanged', async () => {
    const expected = { id: '120363413156936744@newsletter', state: { type: 'ACTIVE' } };
    const json = Buffer.from(JSON.stringify({ data: { xwa2_newsletter: expected } }), 'utf-8');
    const query = async () => ({ tag: 'iq', content: [{ tag: 'result', attrs: {}, content: json }] });
    const result = await executeWMexQuery({}, 'qid', 'xwa2_newsletter', query, () => 'tag');
    assert.deepEqual(result, expected);
});

test('executeWMexQuery wraps decoder failures in a Boom with a payload preview', async () => {
    const bad = Buffer.from([0x04, 0xff, 0xff]);
    const query = async () => ({ tag: 'iq', content: [{ tag: 'result', attrs: { format: 'argo' }, content: bad }] });
    await assert.rejects(
        () => executeWMexQuery({}, 'qid', 'xwa2_newsletter', query, () => 'tag'),
        (err) => err instanceof Boom && /Failed to decode Argo response/.test(err.message) && !!err.data?.preview
    );
});

test('73-byte errors-only payload decodes to Not Allowed with extensions', () => {
    const payload = Buffer.from('BGJOb3QgQWxsb3dlZGVycm9yX2NvZGVpc19yZXRyeWFibGVzZXZlcml0eUNSSVRJQ0FMBgCqBiIAAQIWAwIABAYUDBgAEAgQAw==', 'base64');
    assert.equal(payload.length, 73);
    const response = decodeArgoForDataPath(payload, 'xwa2_newsletter');
    assert.equal(response.data.xwa2_newsletter, null);
    assert.equal(response.errors.length, 1);
    assert.equal(response.errors[0].message, 'Not Allowed');
    assert.deepEqual(response.errors[0].path, [0]);
    assert.equal(response.errors[0].extensions.is_retryable, false);
    assert.equal(response.errors[0].extensions.severity, 'CRITICAL');
    assert.equal(typeof response.errors[0].extensions.error_code, 'number');
});

test('executeWMexQuery surfaces Argo GraphQL errors as Not Allowed', async () => {
    const payload = Buffer.from('BGJOb3QgQWxsb3dlZGVycm9yX2NvZGVpc19yZXRyeWFibGVzZXZlcml0eUNSSVRJQ0FMBgCqBiIAAQIWAwIABAYUDBgAEAgQAw==', 'base64');
    const query = async () => ({ tag: 'iq', content: [{ tag: 'result', attrs: { format: 'argo' }, content: payload }] });
    await assert.rejects(
        () => executeWMexQuery({}, '27456920720571478', 'xwa2_newsletter', query, () => 'tag'),
        (err) => err instanceof Boom && /GraphQL server error: Not Allowed/.test(err.message) && !!err.data?.extensions
    );
});

test('inline argo_real fixture matches /tmp/opencode/argo_real.bin', async () => {
    const { readFile } = await import('node:fs/promises');
    const bin = await readFile('/tmp/opencode/argo_real.bin');
    assert.equal(bin.length, 498);
    assert.equal(Buffer.from(bin).toString('base64'), REAL_FIXTURE.toString('base64'));
});

test('newsletterMetadata variables match the current query exactly (INVITE)', () => {
    assert.deepEqual(buildNewsletterMetadataVariables('invite', '0029Vb8tzN4BFLgPH89T4I1I'), {
        fetch_creation_time: true,
        fetch_full_image: true,
        fetch_pinned_messages: false,
        fetch_status_metadata: false,
        fetch_viewer_metadata: true,
        fetch_wamo_sub: false,
        input: {
            key: '0029Vb8tzN4BFLgPH89T4I1I',
            type: 'INVITE',
            view_role: 'GUEST'
        }
    });
});

test('newsletterMetadata variables match the current query exactly (JID)', () => {
    assert.deepEqual(buildNewsletterMetadataVariables('jid', '120363413156936744@newsletter'), {
        fetch_creation_time: true,
        fetch_full_image: true,
        fetch_pinned_messages: false,
        fetch_status_metadata: false,
        fetch_viewer_metadata: true,
        fetch_wamo_sub: false,
        input: {
            key: '120363413156936744@newsletter',
            type: 'JID',
            view_role: 'GUEST'
        }
    });
});

test('nullable list of records decodes (nullable item) — covers labeled record', () => {
    const inner = recordNode([fieldNode('id', stringNode())]);
    const schema = recordNode([fieldNode('items', listNode(inner))]);
    // String block: 'A' (1 byte); Core: items length 1, item non-null marker 0, id length 1.
    const payload = Buffer.concat([
        Buffer.from([0x04, 0x02]), // header, block length 1
        Buffer.from('A', 'utf-8'),
        Buffer.from([0x06]), // core length 3
        Buffer.from([0x02, 0x00, 0x02]) // items len 1; item non-null marker; id len 1
    ]);
    const result = decodeArgoWithSchema(payload, schema);
    assert.deepEqual(result, { items: [{ id: 'A' }] });
});

test('nullable list of records with null item decodes', () => {
    const inner = recordNode([fieldNode('id', stringNode())]);
    const schema = recordNode([fieldNode('items', listNode(inner))]);
    // String block empty; Core: items len 1, item null (-1).
    const payload = Buffer.concat([
        Buffer.from([0x04, 0x00]), // header, block length 0
        Buffer.from([0x04]), // core length 2
        Buffer.from([0x02, 0x01]) // items len 1; item null (-1 as zigzag 1)
    ]);
    const result = decodeArgoWithSchema(payload, schema);
    assert.deepEqual(result, { items: [null] });
});

test('non-null record list decodes without markers, separate value pool (viewer settings shape)', () => {
    const item = recordNode([
        fieldNode('type', { k: 'scalar', type: 'STRING', block: 'T', nullable: true }),
        fieldNode('value', { k: 'scalar', type: 'STRING', block: 'V', nullable: true })
    ], { nonNull: true });
    const schema = recordNode([fieldNode('settings', listNode(item))]);
    // T block: 'AA'(2) + 'B'(1); V block: 'OFF'(3). Core: len 2, item1 {len 2, len 3}, item2 {len 1, backref 0}.
    const payload = Buffer.concat([
        Buffer.from([0x04, 0x06]), // header, T block length 3
        Buffer.from('AAB', 'utf-8'),
        Buffer.from([0x06]), // V block length 3
        Buffer.from('OFF', 'utf-8'),
        Buffer.from([0x0a]), // core length 5
        Buffer.from([0x04, 0x04, 0x06, 0x02, 0x07]) // len 2; 'AA'; 'OFF'; 'B'; backref OFF
    ]);
    const result = decodeArgoWithSchema(payload, schema);
    assert.deepEqual(result, { settings: [{ type: 'AA', value: 'OFF' }, { type: 'B', value: 'OFF' }] });
});

test('invite URLs are stripped but raw invite codes are untouched', () => {
    assert.equal(
        buildNewsletterMetadataVariables('invite', 'https://whatsapp.com/channel/0029Vb8tzN4BFLgPH89T4I1I?foo=bar').input.key,
        '0029Vb8tzN4BFLgPH89T4I1I'
    );
    assert.equal(
        buildNewsletterMetadataVariables('invite', '0029Vb8tzN4BFLgPH89T4I1I').input.key,
        '0029Vb8tzN4BFLgPH89T4I1I'
    );
});
