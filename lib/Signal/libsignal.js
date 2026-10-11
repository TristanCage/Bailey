// @ts-ignore
import * as libsignal from 'libsignal';
// @ts-ignore
import { PreKeyWhisperMessage } from 'libsignal/src/protobufs.js';
import { LRUCache } from 'lru-cache';
import { BufferJSON, generateSignalPubKey } from '../Utils/index.js';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, transferDevice, WAJIDDomains } from '../WABinary/index.js';
import { SenderKeyName } from './Group/sender-key-name.js';
import { SenderKeyRecord } from './Group/sender-key-record.js';
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group/index.js';
import { LIDMappingStore } from './lid-mapping.js';
import { UsernameMappingStore } from '../Utils/username-map.js';
/** Extract identity key from PreKeyWhisperMessage for identity change detection */
function extractIdentityFromPkmsg(ciphertext) {
    try {
        if (!ciphertext || ciphertext.length < 2) {
            return undefined;
        }
        // Version byte check (version 3)
        const version = ciphertext[0];
        if ((version & 0xf) !== 3) {
            return undefined;
        }
        // Parse protobuf (skip version byte)
        const preKeyProto = PreKeyWhisperMessage.decode(ciphertext.slice(1));
        if (preKeyProto.identityKey?.length === 33) {
            return new Uint8Array(preKeyProto.identityKey);
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
    const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc);
    const usernameMapping = new UsernameMappingStore(auth.keys, logger);
    const storage = signalStorage(auth, lidMapping, logger);
    const parsedKeys = auth.keys;
    const migratedSessionCache = new LRUCache({
        ttl: 3 * 24 * 60 * 60 * 1000, // 7 days
        ttlAutopurge: true,
        updateAgeOnGet: true
    });
    const ensureSenderKeyAndCreateSkdm = async (group, meId) => {
        const senderName = jidToSignalSenderKeyName(group, meId);
        const senderNameStr = senderName.toString();
        const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
        if (!senderKey) {
            await storage.storeSenderKey(senderName, new SenderKeyRecord());
        }
        const skdm = await new GroupSessionBuilder(storage).create(senderName);
        return { senderName, skdm };
    };
    const repository = {
        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            const cipher = new GroupCipher(storage, senderName);
            // Use transaction to ensure atomicity
            return parsedKeys.transaction(async () => {
                return await cipher.decrypt(msg);
            }, group);
        },
        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const senderMsg = new SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            const senderNameStr = senderName.toString();
            const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(senderName, new SenderKeyRecord());
            }
            return parsedKeys.transaction(async () => {
                const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
                if (!senderKey) {
                    await storage.storeSenderKey(senderName, new SenderKeyRecord());
                }
                await builder.process(senderName, senderMsg);
            }, item.groupId);
        },
        async decryptMessage({ jid, type, ciphertext, stateless }) {
            const addr = jidToSignalProtocolAddress(jid);
            // whatsmeow f376da26 / WA Web isStateless: the prekey is consumed and the identity saved,
            // but the new session is not stored, so the session we encrypt with stays unchanged
            const cipherStorage = stateless && type === 'pkmsg' ? { ...storage, storeSession: async () => { } } : storage;
            const session = new libsignal.SessionCipher(cipherStorage, addr);
            // Extract and save sender's identity key before decryption for identity change detection
            if (type === 'pkmsg') {
                const identityKey = extractIdentityFromPkmsg(ciphertext);
                if (identityKey) {
                    const addrStr = addr.toString();
                    const identityChanged = await storage.saveIdentity(addrStr, identityKey);
                    if (identityChanged) {
                        logger.info({ jid, addr: addrStr }, 'identity key changed or new contact, session will be re-established');
                    }
                }
            }
            async function doDecrypt() {
                let result;
                switch (type) {
                    case 'pkmsg':
                        result = await session.decryptPreKeyWhisperMessage(ciphertext);
                        break;
                    case 'msg':
                        result = await session.decryptWhisperMessage(ciphertext);
                        break;
                }
                return result;
            }
            // If it's not a sync message, we need to ensure atomicity
            // For regular messages, we use a transaction to ensure atomicity
            return parsedKeys.transaction(async () => {
                return await doDecrypt();
            }, jid);
        },
        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            const cipher = new libsignal.SessionCipher(storage, addr);
            // Use transaction to ensure atomicity
            return parsedKeys.transaction(async () => {
                const { type: sigType, body } = await cipher.encrypt(data);
                const type = sigType === 3 ? 'pkmsg' : 'msg';
                return { type, ciphertext: Buffer.from(body, 'binary') };
            }, jid);
        },
        async encryptGroupMessage({ group, meId, data }) {
            return parsedKeys.transaction(async () => {
                const { senderName, skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                const ciphertext = await new GroupCipher(storage, senderName).encrypt(data);
                return { ciphertext, senderKeyDistributionMessage: skdm.serialize() };
            }, group);
        },
        async getSenderKeyDistributionMessage({ group, meId }) {
            return parsedKeys.transaction(async () => {
                const { skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                return skdm.serialize();
            }, group);
        },
        async hasSenderKey({ group, meId }) {
            const senderName = jidToSignalSenderKeyName(group, meId).toString();
            const { [senderName]: key } = await auth.keys.get('sender-key', [senderName]);
            return !!key;
        },
        async getSessionInfo(jid) {
            const addr = jidToSignalProtocolAddress(jid).toString();
            const session = (await storage.loadSession(addr));
            if (!session) {
                return null;
            }
            const open = session.getOpenSession?.();
            const baseKey = open?.indexInfo?.baseKey;
            const registrationId = open?.registrationId;
            if (!baseKey || typeof registrationId !== 'number') {
                return null;
            }
            return { baseKey: new Uint8Array(baseKey), registrationId };
        },
        async injectE2ESession({ jid, session }) {
            logger.trace({ jid }, 'injecting E2EE session');
            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));
            return parsedKeys.transaction(async () => {
                // libsignal runtime accepts an absent prekey (initOutgoing checks `device.preKey && ...`)
                // but the bundled .d.ts marks it required.
                await cipher.initOutgoing(session);
            }, jid);
        },
        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        },
        // Optimized direct access to LID mapping store
        lidMapping,
        // Username ↔ JID mapping store
        usernameMapping,
        async validateSession(jid) {
            try {
                const addr = jidToSignalProtocolAddress(jid);
                const session = await storage.loadSession(addr.toString());
                if (!session) {
                    return { exists: false, reason: 'no session' };
                }
                if (!session.haveOpenSession()) {
                    return { exists: false, reason: 'no open session' };
                }
                return { exists: true };
            }
            catch (error) {
                return { exists: false, reason: 'validation error' };
            }
        },
        async validateSessions(jids) {
            if (!jids.length)
                return {};
            const uniqueJids = [...new Set(jids)];
            const addrStrings = [];
            const jidToAddr = {};
            for (const jid of uniqueJids) {
                const addr = jidToSignalProtocolAddress(jid).toString();
                addrStrings.push(addr);
                jidToAddr[jid] = addr;
            }
            // Shared resolution logic from signalStorage to get wire JIDs
            const resolveAddr = async (id) => {
                if (id.includes('.') && !id.includes('-')) {
                    const [deviceId, device] = id.split('.');
                    const [user, domainType_] = deviceId.split('_');
                    const domainType = parseInt(domainType_ || '0');
                    if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID)
                        return id;
                    const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`;
                    const lidForPN = await lidMapping.getLIDForPN(pnJid);
                    if (lidForPN) {
                        const lidAddr = jidToSignalProtocolAddress(lidForPN);
                        return lidAddr.toString();
                    }
                }
                return id;
            };
            const wireAddrStrings = await Promise.all(addrStrings.map(resolveAddr));
            const sessions = await parsedKeys.get('session', wireAddrStrings);
            const results = {};
            for (let i = 0; i < uniqueJids.length; i++) {
                const jid = uniqueJids[i];
                const wireAddr = wireAddrStrings[i];
                const sessionData = sessions[wireAddr];
                if (!sessionData) {
                    results[jid] = { exists: false, reason: 'no session' };
                }
                else {
                    try {
                        const session = libsignal.SessionRecord.deserialize(sessionData);
                        if (!session.haveOpenSession()) {
                            results[jid] = { exists: false, reason: 'no open session' };
                        }
                        else {
                            results[jid] = { exists: true };
                        }
                    }
                    catch (error) {
                        results[jid] = { exists: false, reason: 'deserialization error' };
                    }
                }
            }
            return results;
        },
        async deleteSession(jids) {
            if (!jids.length)
                return;
            // Convert JIDs to signal addresses and prepare for bulk deletion
            const sessionUpdates = {};
            for (const jid of jids) {
                const addr = jidToSignalProtocolAddress(jid).toString();
                sessionUpdates[addr] = null;
                // Also try to resolve LID if it's a PN
                if (isPnUser(jid)) {
                    const lid = await lidMapping.getLIDForPN(jid);
                    if (lid) {
                        // Preserve device part if present
                        const decoded = jidDecode(jid);
                        const lidWithDevice = decoded?.device
                            ? `${lid.split('@')[0]}:${decoded.device}@${lid.split('@')[1]}`
                            : lid;
                        const lidAddr = jidToSignalProtocolAddress(lidWithDevice).toString();
                        sessionUpdates[lidAddr] = null;
                    }
                }
            }
            // Single transaction for all deletions
            return parsedKeys.transaction(async () => {
                await auth.keys.set({ session: sessionUpdates });
            }, `delete-${jids.length}-sessions`);
        },
        async deleteIdentity(jids) {
            if (!jids.length)
                return;
            // Convert JIDs to signal addresses and prepare for bulk deletion
            const identityUpdates = {};
            for (const jid of jids) {
                const addr = jidToSignalProtocolAddress(jid).toString();
                identityUpdates[addr] = null;
                // Also try to resolve LID if it's a PN
                if (isPnUser(jid)) {
                    const lid = await lidMapping.getLIDForPN(jid);
                    if (lid) {
                        // Preserve device part if present
                        const decoded = jidDecode(jid);
                        const lidWithDevice = decoded?.device
                            ? `${lid.split('@')[0]}:${decoded.device}@${lid.split('@')[1]}`
                            : lid;
                        const lidAddr = jidToSignalProtocolAddress(lidWithDevice).toString();
                        identityUpdates[lidAddr] = null;
                    }
                }
            }
            // Single transaction for all deletions
            return parsedKeys.transaction(async () => {
                await auth.keys.set({ 'identity-key': identityUpdates });
            }, `delete-${jids.length}-identities`);
        },
        async migrateSession(fromJid, toJid) {
            // TODO: use usync to handle this entire mess
            if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid)))
                return { migrated: 0, skipped: 0, total: 0 };
            // Only support PN to LID migration
            if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) {
                return { migrated: 0, skipped: 0, total: 1 };
            }
            const { user } = jidDecode(fromJid);
            logger.debug({ fromJid }, 'bulk device migration - loading all user devices');
            // Get user's device list from storage
            const { [user]: userDevices } = await parsedKeys.get('device-list', [user]);
            if (!userDevices) {
                return { migrated: 0, skipped: 0, total: 0 };
            }
            const { device: fromDevice } = jidDecode(fromJid);
            const fromDeviceStr = fromDevice?.toString() || '0';
            if (!userDevices.includes(fromDeviceStr)) {
                userDevices.push(fromDeviceStr);
            }
            // Filter out cached devices before database fetch
            const uncachedDevices = userDevices.filter(device => {
                const deviceKey = `${user}.${device}`;
                return !migratedSessionCache.has(deviceKey);
            });
            // Bulk check session existence only for uncached devices
            const deviceSessionKeys = uncachedDevices.map(device => `${user}.${device}`);
            const existingSessions = await parsedKeys.get('session', deviceSessionKeys);
            // Step 3: Convert existing sessions to JIDs (only migrate sessions that exist)
            const deviceJids = [];
            for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
                if (sessionData) {
                    // Session exists in storage
                    const deviceStr = sessionKey.split('.')[1];
                    if (!deviceStr)
                        continue;
                    const deviceNum = parseInt(deviceStr);
                    let jid = deviceNum === 0 ? `${user}@s.whatsapp.net` : `${user}:${deviceNum}@s.whatsapp.net`;
                    if (deviceNum === 99) {
                        jid = `${user}:99@hosted`;
                    }
                    deviceJids.push(jid);
                }
            }
            logger.debug({
                fromJid,
                totalDevices: userDevices.length,
                devicesWithSessions: deviceJids.length,
                devices: deviceJids
            }, 'bulk device migration complete - all user devices processed');
            // Single transaction for all migrations
            return parsedKeys.transaction(async () => {
                const migrationOps = deviceJids.map(jid => {
                    const lidWithDevice = transferDevice(jid, toJid);
                    const fromDecoded = jidDecode(jid);
                    const toDecoded = jidDecode(lidWithDevice);
                    return {
                        fromJid: jid,
                        toJid: lidWithDevice,
                        pnUser: fromDecoded.user,
                        lidUser: toDecoded.user,
                        deviceId: fromDecoded.device || 0,
                        fromAddr: jidToSignalProtocolAddress(jid),
                        toAddr: jidToSignalProtocolAddress(lidWithDevice)
                    };
                });
                const totalOps = migrationOps.length;
                let migratedCount = 0;
                // Bulk fetch PN sessions - already exist (verified during device discovery)
                const pnAddrStrings = Array.from(new Set(migrationOps.map(op => op.fromAddr.toString())));
                const pnSessions = await parsedKeys.get('session', pnAddrStrings);
                // Prepare bulk session updates (PN → LID migration + deletion)
                const sessionUpdates = {};
                for (const op of migrationOps) {
                    const pnAddrStr = op.fromAddr.toString();
                    const lidAddrStr = op.toAddr.toString();
                    const pnSession = pnSessions[pnAddrStr];
                    if (pnSession) {
                        // Session exists (guaranteed from device discovery)
                        const fromSession = libsignal.SessionRecord.deserialize(pnSession);
                        if (fromSession.haveOpenSession()) {
                            // Queue for bulk update: copy to LID, delete from PN
                            sessionUpdates[lidAddrStr] = fromSession.serialize();
                            sessionUpdates[pnAddrStr] = null;
                            migratedCount++;
                            // Also migrate sender keys for common broadcats/groups if we have them
                            // This is an optimization to prevent decryption failures in groups after migration
                            // We prioritize status@broadcast but could expand to all groups if we knew them
                            const groupsToMigrate = ['status@broadcast'];
                            // If we have a target groupId (e.g. from context, though not passed here currently), we could add it
                            for (const groupId of groupsToMigrate) {
                                const pnSenderKeyName = new SenderKeyName(groupId, op.fromAddr).toString();
                                const lidSenderKeyName = new SenderKeyName(groupId, op.toAddr).toString();
                                const { [pnSenderKeyName]: senderKey } = await parsedKeys.get('sender-key', [
                                    pnSenderKeyName
                                ]);
                                if (senderKey) {
                                    sessionUpdates[`sender-key:${lidSenderKeyName}`] = senderKey;
                                    sessionUpdates[`sender-key:${pnSenderKeyName}`] = null;
                                }
                            }
                        }
                    }
                }
                // Single bulk session update for all migrations
                if (Object.keys(sessionUpdates).length > 0) {
                    const finalUpdates = { session: {}, 'sender-key': {}, 'identity-key': {} };
                    for (const [key, value] of Object.entries(sessionUpdates)) {
                        if (key.startsWith('sender-key:')) {
                            finalUpdates['sender-key'][key.split('sender-key:')[1]] = value;
                        }
                        else if (key.startsWith('identity-key:')) {
                            finalUpdates['identity-key'][key.split('identity-key:')[1]] = value;
                        }
                        else {
                            finalUpdates.session[key] = value;
                        }
                    }
                    await parsedKeys.set(finalUpdates);
                    logger.debug({ migratedSessions: migratedCount }, 'bulk session migration complete');
                    // Cache device-level migrations
                    for (const op of migrationOps) {
                        if (sessionUpdates[op.toAddr.toString()]) {
                            const deviceKey = `${op.pnUser}.${op.deviceId}`;
                            migratedSessionCache.set(deviceKey, true);
                        }
                    }
                }
                const skippedCount = totalOps - migratedCount;
                return { migrated: migratedCount, skipped: skippedCount, total: totalOps };
            }, `migrate-${deviceJids.length}-sessions-${jidDecode(toJid)?.user}`);
        }
    };
    return repository;
}
const jidToSignalProtocolAddress = (jid) => {
    const decoded = jidDecode(jid);
    const { user, device, server, domainType } = decoded;
    if (!user) {
        throw new Error(`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`);
    }
    const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
    const finalDevice = device || 0;
    if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
        throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid);
    }
    return new libsignal.ProtocolAddress(signalUser, finalDevice);
};
const jidToSignalSenderKeyName = (group, user) => {
    return new SenderKeyName(group, jidToSignalProtocolAddress(user));
};
/**
 * Inverse of the PN→LID address resolution: given a LID signal-address string
 * (`user_domainType.device`), return the PN signal-address string if a mapping
 * exists, else null. Used for lazy PN→LID migration on read — when a record is
 * looked up under the LID address but was persisted under the PN address before
 * the mapping was learned. Store-agnostic (no device-list / SQL LIKE needed).
 */
export const resolvePNForLIDAddress = async (lidAddrStr, getPNForLID) => {
    if (!lidAddrStr.includes('.') || lidAddrStr.includes('-'))
        return null;
    const [deviceId, device] = lidAddrStr.split('.');
    const [user, domainType_] = deviceId.split('_');
    const domainType = parseInt(domainType_ || '0');
    if (domainType !== WAJIDDomains.LID && domainType !== WAJIDDomains.HOSTED_LID)
        return null;
    const server = domainType === WAJIDDomains.HOSTED_LID ? 'hosted.lid' : 'lid';
    const lidJid = `${user}${device && device !== '0' ? `:${device}` : ''}@${server}`;
    const pn = await getPNForLID(lidJid);
    if (!pn)
        return null;
    return jidToSignalProtocolAddress(pn).toString();
};
/**
 * Inverse resolver for sender-key names: given a LID-keyed name
 * (`group::user_domainType::device`), return the PN-keyed name if a mapping
 * exists, else null. Used for lazy group/status sender-key migration on read.
 */
export const resolvePNForLIDSenderKey = async (lidKeyId, getPNForLID) => {
    const parts = lidKeyId.split('::');
    if (parts.length !== 3)
        return null;
    const [groupId, user, device] = parts;
    if (!user.includes('_'))
        return null; // already a PN-keyed name
    const [lidUser, domainType_] = user.split('_');
    const domainType = parseInt(domainType_ || '0');
    if (domainType !== WAJIDDomains.LID && domainType !== WAJIDDomains.HOSTED_LID)
        return null;
    const server = domainType === WAJIDDomains.HOSTED_LID ? 'hosted.lid' : 'lid';
    const lidJid = `${lidUser}${device && device !== '0' ? `:${device}` : ''}@${server}`;
    const pn = await getPNForLID(lidJid);
    if (!pn)
        return null;
    const pnAddr = jidToSignalProtocolAddress(pn).toString();
    return `${groupId}::${pnAddr.replace('.', '::')}`;
};
function signalStorage({ creds, keys }, lidMapping, logger) {
    // Shared function to resolve PN signal address to LID if mapping exists
    const resolveLIDSignalAddress = async (id) => {
        if (id.includes('.') && !id.includes('-')) {
            const [deviceId, device] = id.split('.');
            const [user, domainType_] = deviceId.split('_');
            const domainType = parseInt(domainType_ || '0');
            if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID)
                return id;
            const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`;
            const lidForPN = await lidMapping.getLIDForPN(pnJid);
            if (lidForPN) {
                const lidAddr = jidToSignalProtocolAddress(lidForPN);
                return lidAddr.toString();
            }
        }
        return id;
    };
    return {
        loadSession: async (id) => {
            try {
                const wireJid = await resolveLIDSignalAddress(id);
                let { [wireJid]: sess } = await keys.get('session', [wireJid]);
                // Lazy PN→LID migration: after a mapping is learned the lookup resolves to
                // the LID address, but the 1:1 session may still be persisted under the PN
                // address (e.g. a receive-only contact never covered by eager migration).
                // Move it forward on first access. Store-agnostic — no device-list needed.
                if (!sess) {
                    const pnAddr = await resolvePNForLIDAddress(wireJid, jid => lidMapping.getPNForLID(jid));
                    if (pnAddr && pnAddr !== wireJid) {
                        const { [pnAddr]: pnSess } = await keys.get('session', [pnAddr]);
                        if (pnSess) {
                            await keys.set({ session: { [wireJid]: pnSess, [pnAddr]: null } });
                            logger.debug({ from: pnAddr, to: wireJid }, 'migrated 1:1 session PN→LID on read');
                            sess = pnSess;
                        }
                    }
                }
                if (sess) {
                    return libsignal.SessionRecord.deserialize(sess);
                }
            }
            catch (e) {
                return null;
            }
            return null;
        },
        storeSession: async (id, session) => {
            const wireJid = await resolveLIDSignalAddress(id);
            await keys.set({ session: { [wireJid]: session.serialize() } });
        },
        // TOFU - Trust On First Use, exactly like WhatsApp Web / upstream Baileys.
        // libsignal calls this with the DEVICE-LESS address (session_cipher and session_builder
        // both pass addr.id), so it cannot tell device 0 from device 40 - and each companion
        // device has its OWN identity key. Comparing stored-vs-incoming here (device-less id)
        // collapses every device into one slot and flip-flops it on each alternating-device op
        // (the "identity changed" churn). Per-device change detection lives in saveIdentity,
        // which IS called with the device-ful address.
        isTrustedIdentity: () => {
            return true;
        },
        loadIdentityKey: async (id) => {
            const wireJid = await resolveLIDSignalAddress(id);
            const { [wireJid]: key } = await keys.get('identity-key', [wireJid]);
            return key || undefined;
        },
        // Called from the pkmsg path with the DEVICE-FUL address (decryptMessage passes
        // addr.toString()), so identity is stored/compared PER-DEVICE - matching whatsmeow
        // (address.String()) and upstream Baileys. Clears only that device's session on a
        // genuine key change.
        saveIdentity: async (id, identityKey) => {
            const wireJid = await resolveLIDSignalAddress(id);
            const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid]);
            const keysMatch = existingKey?.length === identityKey.length && existingKey.every((byte, i) => byte === identityKey[i]);
            if (existingKey && !keysMatch) {
                // Identity changed - clear this device's session and update its key
                await keys.set({
                    session: { [wireJid]: null },
                    'identity-key': { [wireJid]: identityKey }
                });
                return true;
            }
            if (!existingKey) {
                // New device - Trust on First Use (TOFU)
                await keys.set({ 'identity-key': { [wireJid]: identityKey } });
                return true;
            }
            return false;
        },
        loadPreKey: async (id) => {
            const keyId = id.toString();
            const { [keyId]: key } = await keys.get('pre-key', [keyId]);
            if (key) {
                return {
                    privKey: Buffer.from(key.private),
                    pubKey: Buffer.from(key.public)
                };
            }
        },
        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),
        loadSignedPreKey: () => {
            const key = creds.signedPreKey;
            return {
                privKey: Buffer.from(key.keyPair.private),
                pubKey: Buffer.from(key.keyPair.public)
            };
        },
        loadSenderKey: async (senderKeyName) => {
            const keyId = senderKeyName.toString();
            const lidKeyId = await resolveLIDSenderKeyName(keyId);
            const { [lidKeyId]: key } = await keys.get('sender-key', [lidKeyId]);
            if (key) {
                return SenderKeyRecord.deserialize(key);
            }
            // Lazy PN→LID migration for group + status@broadcast sender keys: the lookup
            // is already LID-normalized, so if it misses, the record may still be under
            // the PN-keyed name from before the mapping was learned. Resolve PN←LID and
            // migrate it forward. This replaces the old `lidKeyId !== keyId` fallback,
            // which was dead for the decrypt path (input was already LID → guard false).
            const pnKeyId = await resolvePNForLIDSenderKey(lidKeyId, jid => lidMapping.getPNForLID(jid));
            if (pnKeyId && pnKeyId !== lidKeyId) {
                const { [pnKeyId]: pnKey } = await keys.get('sender-key', [pnKeyId]);
                if (pnKey) {
                    await keys.set({ 'sender-key': { [lidKeyId]: pnKey, [pnKeyId]: null } });
                    logger.debug({ from: pnKeyId, to: lidKeyId }, 'migrated sender-key PN→LID on read');
                    return SenderKeyRecord.deserialize(pnKey);
                }
            }
            // Original-name fallback (PN-input edge case where nothing was LID-normalized).
            if (lidKeyId !== keyId) {
                const { [keyId]: originalKey } = await keys.get('sender-key', [keyId]);
                if (originalKey) {
                    return SenderKeyRecord.deserialize(originalKey);
                }
            }
            return new SenderKeyRecord();
        },
        storeSenderKey: async (senderKeyName, key) => {
            const keyId = senderKeyName.toString();
            const lidKeyId = await resolveLIDSenderKeyName(keyId);
            const serialized = JSON.stringify(key.serialize(), BufferJSON.replacer);
            await keys.set({ 'sender-key': { [lidKeyId]: Buffer.from(serialized, 'utf-8') } });
        },
        getOurRegistrationId: () => creds.registrationId,
        getOurIdentity: () => {
            const { signedIdentityKey } = creds;
            return {
                privKey: Buffer.from(signedIdentityKey.private),
                pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public))
            };
        }
    };
    async function resolveLIDSenderKeyName(id) {
        const parts = id.split('::');
        if (parts.length === 3) {
            const [groupId, user, device] = parts;
            if (user && !user.includes('_')) {
                const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@s.whatsapp.net`;
                const lidForPN = await lidMapping.getLIDForPN(pnJid);
                if (lidForPN) {
                    const lidAddr = jidToSignalProtocolAddress(lidForPN);
                    return `${groupId}::${lidAddr.toString().replace('.', '::')}`;
                }
            }
        }
        return id;
    }
}
//# sourceMappingURL=libsignal.js.map