import { DataTypes, InferAttributes, InferCreationAttributes, Model, Op, Sequelize } from 'sequelize';
import { proto } from '../../WAProto';
import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, SignalKeyStore } from '../../src/Types';
import { BufferJSON } from './generics.js';
/**
 * A Sequelize-based auth state store for Baileys.
 * This store persists both credentials and cryptographic keys.
 */
export const makeSequelizeAuthState = async (sequelize, logger) => {
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
    // We keep this for internal usage if needed, but it will essentially be unused
    // if we don't expose the transaction method.
    await SignalKey.sync();
    const readData = async (type, id) => {
        try {
            const data = await SignalKey.findOne({ where: { type, id } });
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
        const str = JSON.stringify(value, BufferJSON.replacer);
        await SignalKey.upsert({ type, id, value: str });
    };
    const removeData = async (type, id) => {
        await SignalKey.destroy({ where: { type, id } });
    };
    const creds = await readData('creds', 'creds') || {};
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    const results = await SignalKey.findAll({
                        where: {
                            type,
                            id: { [Op.in]: ids }
                        }
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
                    const promises = [];
                    if (itemsToUpsert.length) {
                        promises.push(SignalKey.bulkCreate(itemsToUpsert, {
                            updateOnDuplicate: ['value']
                        }));
                    }
                    for (const type in idsToDeleteByType) {
                        promises.push(SignalKey.destroy({
                            where: {
                                type,
                                id: { [Op.in]: idsToDeleteByType[type] }
                            }
                        }));
                    }
                    await Promise.all(promises);
                }
            },
        },
        saveCreds: () => {
            return writeData('creds', 'creds', creds);
        }
    };
};
//# sourceMappingURL=sqlite-store.js.map