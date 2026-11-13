import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { LabelAssociationType } from '../Types/LabelAssociation.js';
import { toNumber, updateMessageWithReaction, updateMessageWithReceipt } from '../Utils/index.js';
import { jidDecode, jidNormalizedUser } from '../WABinary/index.js';
import { KeyedDB } from './keyed-db.js';
import { makeOrderedDictionary } from './make-ordered-dictionary.js';
import { ObjectRepository } from './object-repository.js';

/**
 * In-memory store for chats, messages, contacts, groups, presences and labels.
 * Ported from @zervonex/baileys (MIT, nexustechpro2) with the KeyedDB
 * dependency replaced by a local implementation.
 */

const md5 = data => createHash('md5').update(data).digest();

export const waChatKey = pin => ({
	key: chat =>
		(pin ? (chat.pinned ? '1' : '0') : '') +
		(chat.archived ? '0' : '1') +
		(chat.conversationTimestamp ? chat.conversationTimestamp.toString(16).padStart(8, '0') : '') +
		chat.id,
	compare: (k1, k2) => k2.localeCompare(k1)
});

export const waMessageID = message => message.key.id || '';

export const waLabelAssociationKey = {
	key: association =>
		association.type === LabelAssociationType.Chat
			? association.chatId + association.labelId
			: association.chatId + association.messageId + association.labelId,
	compare: (k1, k2) => k2.localeCompare(k1)
};

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID);

export const makeInMemoryStore = config => {
	config = config || {};
	const socket = config.socket;
	const chatKey = config.chatKey || waChatKey(true);
	const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey;
	const logger = config.logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' });
	const chats = new KeyedDB(chatKey, chat => chat.id);
	const messages = {};
	const contacts = {};
	const groupMetadata = {};
	const presences = {};
	const state = { connection: 'close' };
	const labels = new ObjectRepository();
	const labelAssociations = new KeyedDB(labelAssociationKey, labelAssociationKey.key);

	const assertMessageList = jid => {
		if (!messages[jid]) messages[jid] = makeMessagesDictionary();
		return messages[jid];
	};

	const contactsUpsert = newContacts => {
		const oldContacts = new Set(Object.keys(contacts));
		for (const contact of newContacts) {
			if (!contact || typeof contact.id !== 'string') continue;
			oldContacts.delete(contact.id);
			contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact);
		}
		return oldContacts;
	};

	const labelsUpsert = newLabels => {
		for (const label of newLabels) labels.upsertById(label.id, label);
	};

	/**
	 * Bind to a Baileys event emitter to keep the store in sync.
	 * @param {object} ev socket event emitter
	 */
	const bind = ev => {
		ev.on('connection.update', update => {
			Object.assign(state, update);
		});

		ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest, syncType }) => {
			if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) return;
			if (isLatest) {
				chats.clear();
				for (const id in messages) delete messages[id];
			}
			const chatsAdded = chats.insertIfAbsent(...newChats).length;
			logger.debug({ chatsAdded }, 'synced chats');
			const oldContacts = contactsUpsert(newContacts);
			if (isLatest) {
				for (const jid of oldContacts) delete contacts[jid];
			}
			logger.debug({ deletedContacts: isLatest ? oldContacts.size : 0, newContacts }, 'synced contacts');
			for (const msg of newMessages) {
				const jid = msg.key.remoteJid;
				assertMessageList(jid).upsert(msg, 'prepend');
			}
			logger.debug({ messages: newMessages.length }, 'synced messages');
		});

		ev.on('contacts.upsert', contacts => {
			contactsUpsert(contacts);
		});

		ev.on('contacts.update', async updates => {
			for (const update of updates) {
				let contact;
				if (contacts[update.id]) {
					contact = contacts[update.id];
				} else {
					const contactHashes = await Promise.all(
						Object.keys(contacts).map(async contactId => {
							const { user } = jidDecode(contactId);
							return [contactId, md5(Buffer.from(user + 'WA_ADD_NOTIF', 'utf8')).toString('base64').slice(0, 3)];
						})
					);
					contact = contacts[contactHashes.find(([, b]) => b === update.id?.[0])?.[0] || ''];
				}
				if (!contact) {
					if (update.notify || update.verifiedName || update.name) {
						contacts[update.id] = { id: update.id };
						contact = contacts[update.id];
					} else {
						logger.debug({ update }, 'got update for non-existent contact');
						continue;
					}
				}
				if (update.imgUrl === 'changed') {
					contact.imgUrl = socket ? await socket.profilePictureUrl(contact.id) : undefined;
				} else if (update.imgUrl === 'removed') {
					delete contact.imgUrl;
				}
				if (update.notify) contact.notify = update.notify;
				if (update.verifiedName) contact.verifiedName = update.verifiedName;
				if (update.name) contact.name = update.name;
				Object.assign(contacts[contact.id], contact);
			}
		});

		ev.on('chats.upsert', newChats => {
			chats.upsert(...newChats);
		});

		ev.on('chats.update', updates => {
			for (let update of updates) {
				const result = chats.update(update.id, chat => {
					if (update.unreadCount > 0) {
						update = { ...update };
						update.unreadCount = (chat.unreadCount || 0) + update.unreadCount;
					}
					Object.assign(chat, update);
				});
				if (!result) logger.debug({ update }, 'got update for non-existent chat');
			}
		});

		ev.on('labels.edit', label => {
			if (label.deleted) return labels.deleteById(label.id);
			if (labels.count() < 20) return labels.upsertById(label.id, label);
			logger.error('Labels count exceed');
		});

		ev.on('labels.association', ({ type, association }) => {
			switch (type) {
				case 'add':
					labelAssociations.upsert(association);
					break;
				case 'remove':
					labelAssociations.delete(association);
					break;
				default:
					console.error(`unknown operation type [${type}]`);
			}
		});

		ev.on('presence.update', ({ id, presences: update }) => {
			presences[id] = presences[id] || {};
			Object.assign(presences[id], update);
		});

		ev.on('chats.delete', deletions => {
			for (const item of deletions) {
				if (chats.get(item)) chats.deleteById(item);
			}
		});

		ev.on('messages.upsert', ({ messages: newMessages, type }) => {
			switch (type) {
				case 'append':
				case 'notify':
					for (const msg of newMessages) {
						const jid = jidNormalizedUser(msg.key.remoteJid);
						const list = assertMessageList(jid);
						list.upsert(msg, 'append');
						if (type === 'notify' && !chats.get(jid)) {
							ev.emit('chats.upsert', [
								{
									id: jid,
									conversationTimestamp: toNumber(msg.messageTimestamp),
									unreadCount: 1
								}
							]);
						}
					}
					break;
			}
		});

		ev.on('messages.update', updates => {
			for (const { update, key } of updates) {
				const list = assertMessageList(jidNormalizedUser(key.remoteJid));
				if (update?.status) {
					const listStatus = list.get(key.id)?.status;
					if (listStatus && update.status <= listStatus) {
						delete update.status;
					}
				}
				const result = list.updateAssign(key.id, update);
				if (!result) logger.debug({ update }, 'got update for non-existent message');
			}
		});

		ev.on('messages.delete', item => {
			if ('all' in item) {
				messages[item.jid]?.clear();
			} else {
				const jid = item.keys[0].remoteJid;
				const list = messages[jid];
				if (list) {
					const idSet = new Set(item.keys.map(k => k.id));
					list.filter(m => !idSet.has(m.key.id));
				}
			}
		});

		ev.on('groups.update', updates => {
			for (const update of updates) {
				const id = update.id;
				if (groupMetadata[id]) Object.assign(groupMetadata[id], update);
				else logger.debug({ update }, 'got update for non-existent group metadata');
			}
		});

		ev.on('group-participants.update', ({ id, participants, action }) => {
			const metadata = groupMetadata[id];
			if (!metadata) return;
			switch (action) {
				case 'add':
					metadata.participants.push(...participants.map(participantId => ({ id: participantId, isAdmin: false, isSuperAdmin: false })));
					break;
				case 'demote':
				case 'promote':
					for (const participant of metadata.participants) {
						if (participants.includes(participant.id)) participant.isAdmin = action === 'promote';
					}
					break;
				case 'remove':
					metadata.participants = metadata.participants.filter(participant => !participants.includes(participant.id));
					break;
			}
		});

		ev.on('message-receipt.update', updates => {
			for (const { key, receipt } of updates) {
				const msg = messages[key.remoteJid]?.get(key.id);
				if (msg) updateMessageWithReceipt(msg, receipt);
			}
		});

		ev.on('messages.reaction', reactions => {
			for (const { key, reaction } of reactions) {
				const msg = messages[key.remoteJid]?.get(key.id);
				if (msg) updateMessageWithReaction(msg, reaction);
			}
		});
	};

	const toJSON = () => ({ chats, contacts, messages, labels, labelAssociations });

	const fromJSON = json => {
		chats.upsert(...json.chats);
		labelAssociations.upsert(...(json.labelAssociations || []));
		contactsUpsert(Object.values(json.contacts));
		labelsUpsert(Object.values(json.labels || {}));
		for (const jid in json.messages) {
			const list = assertMessageList(jid);
			for (const msg of json.messages[jid]) {
				list.upsert(proto.WebMessageInfo.fromObject(msg), 'append');
			}
		}
	};

	return {
		chats,
		contacts,
		messages,
		groupMetadata,
		state,
		presences,
		labels,
		labelAssociations,
		bind,
		loadMessages: async (jid, count, cursor) => {
			const list = assertMessageList(jid);
			const mode = !cursor || 'before' in cursor ? 'before' : 'after';
			const cursorKey = cursor ? ('before' in cursor ? cursor.before : cursor.after) : undefined;
			const cursorValue = cursorKey ? list.get(cursorKey.id) : undefined;
			let result;
			if (list && mode === 'before' && (!cursorKey || cursorValue)) {
				if (cursorValue) {
					const msgIdx = list.array.findIndex(m => m.key.id === cursorKey?.id);
					result = list.array.slice(0, msgIdx);
				} else {
					result = list.array;
				}
				const diff = count - result.length;
				if (diff < 0) result = result.slice(-count);
			} else {
				result = [];
			}
			return result;
		},
		getLabels: () => labels,
		getChatLabels: chatId => labelAssociations.filter(association => association.chatId === chatId).all(),
		getMessageLabels: messageId =>
			labelAssociations.filter(association => association.messageId === messageId).all().map(({ labelId }) => labelId),
		loadMessage: async (jid, id) => messages[jid]?.get(id),
		mostRecentMessage: async jid => messages[jid]?.array.slice(-1)[0],
		fetchImageUrl: async (jid, sock) => {
			const contact = contacts[jid];
			if (!contact) return sock?.profilePictureUrl(jid);
			if (typeof contact.imgUrl === 'undefined') contact.imgUrl = await sock?.profilePictureUrl(jid);
			return contact.imgUrl;
		},
		fetchGroupMetadata: async (jid, sock) => {
			if (!groupMetadata[jid]) {
				const metadata = await sock?.groupMetadata(jid);
				if (metadata) groupMetadata[jid] = metadata;
			}
			return groupMetadata[jid];
		},
		fetchMessageReceipts: async ({ remoteJid, id }) => messages[remoteJid]?.get(id)?.userReceipt,
		toJSON,
		fromJSON,
		writeToFile: path => {
			writeFileSync(path, JSON.stringify(toJSON()));
		},
		readFromFile: path => {
			if (existsSync(path)) {
				logger.debug({ path }, 'reading from file');
				fromJSON(JSON.parse(readFileSync(path, { encoding: 'utf-8' })));
			}
		}
	};
};
