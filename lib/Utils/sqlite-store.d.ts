import { Sequelize } from 'sequelize';
import { AuthenticationState } from '../../src/Types';
/**
 * A Sequelize-based auth state store for Baileys.
 * This store persists both credentials and cryptographic keys.
 */
export declare const makeSequelizeAuthState: (sequelize: Sequelize, logger?: any) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
}>;
//# sourceMappingURL=sqlite-store.d.ts.map