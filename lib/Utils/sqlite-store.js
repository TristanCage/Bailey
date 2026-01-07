import { AsyncLocalStorage } from 'node:async_hooks';
import { DataTypes, Model, Op, Sequelize } from 'sequelize';
import { proto } from '../../WAProto/index.js';
import { BufferJSON } from './generics.js';
/**
 * A Sequelize-based SQLite store for Baileys.
 * This store persists both credentials and cryptographic keys in a single SQLite database.
 */
export const makeSequelizeAuthState = async (sequelize) => {
    class SignalKey extends Model {
    }
    SignalKey.init({
        type: {
            type: DataTypes.STRING,
            allowNull: false,
            primaryKey: true,
        },
        id: {
            type: DataTypes.STRING,
            allowNull: false,
            primaryKey: true,
        },
        value: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
    }, {
        sequelize,
        tableName: 'signal_keys',
        timestamps: false,
    });
    await SignalKey.sync();
    const txStorage = new AsyncLocalStorage();
    const readData = async (type, id) => {
        try {
            const transaction = txStorage.getStore();
            const data = await SignalKey.findOne({ where: { type, id }, transaction });
            if (data) {
                return JSON.parse(data.value, BufferJSON.reviver);
            }
            return null;
        }
        catch (error) {
            return null;
        }
    };
    const writeData = async (type, id, value) => {
        const transaction = txStorage.getStore();
        const str = JSON.stringify(value, BufferJSON.replacer);
        await SignalKey.upsert({ type, id, value: str }, { transaction });
    };
    const removeData = async (type, id) => {
        const transaction = txStorage.getStore();
        await SignalKey.destroy({ where: { type, id }, transaction });
    };
    const creds = await readData('creds', 'creds') || {};
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    const transaction = txStorage.getStore();
                    const results = await SignalKey.findAll({
                        where: {
                            type,
                            id: { [Op.in]: ids }
                        },
                        transaction
                    });
                    for (const result of results) {
                        let value = JSON.parse(result.value, BufferJSON.reviver);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[result.id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const itemsToUpsert = [];
                    const idsToDeleteByType = {};
                    for (const type in data) {
                        const values = data[type];
                        if (values) {
                            for (const id in values) {
                                const value = values[id];
                                if (value) {
                                    itemsToUpsert.push({
                                        type,
                                        id,
                                        value: JSON.stringify(value, BufferJSON.replacer)
                                    });
                                }
                                else {
                                    if (!idsToDeleteByType[type]) {
                                        idsToDeleteByType[type] = [];
                                    }
                                    idsToDeleteByType[type].push(id);
                                }
                            }
                        }
                    }
                    const transaction = txStorage.getStore();
                    const promises = [];
                    if (itemsToUpsert.length) {
                        promises.push(SignalKey.bulkCreate(itemsToUpsert, {
                            updateOnDuplicate: ['value'],
                            transaction
                        }));
                    }
                    for (const type in idsToDeleteByType) {
                        promises.push(SignalKey.destroy({
                            where: {
                                type,
                                id: { [Op.in]: idsToDeleteByType[type] }
                            },
                            transaction
                        }));
                    }
                    await Promise.all(promises);
                },
                transaction: async (exec) => {
                    return sequelize.transaction(async (t) => {
                        return txStorage.run(t, exec);
                    });
                }
            },
        },
        saveCreds: () => {
            return writeData('creds', 'creds', creds);
        }
    };
};
//# sourceMappingURL=sqlite-store.js.map