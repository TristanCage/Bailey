import assert from 'node:assert/strict';
import test from 'node:test';
import { Boom } from '@hapi/boom';
import { decodeArgoForDataPath, decodeArgoSelfDescribing } from '../lib/Utils/argo.js';
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
