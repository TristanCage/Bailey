import { Sequelize } from 'sequelize';
import type { AuthenticationCreds, SignalKeyStore } from '../Types/index.js';
/**
 * A Sequelize-based SQLite store for Baileys.
 * This store persists both credentials and cryptographic keys in a single SQLite database.
 */
export declare const makeSequelizeAuthState: (sequelize: Sequelize) => Promise<{
    state: {
        creds: AuthenticationCreds;
        keys: SignalKeyStore;
    };
    saveCreds: () => Promise<void>;
}>;
//# sourceMappingURL=sqlite-store.d.ts.map