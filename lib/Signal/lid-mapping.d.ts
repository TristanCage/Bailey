import type { LIDMapping, SignalKeyStoreWithTransaction } from '../Types/index.js';
import type { ILogger } from '../Utils/logger.js';
export declare class LIDMappingStore {
    private readonly mappingCache;
    private readonly keys;
    private readonly logger;
    private pnToLIDFunc?;
    private readonly inflightLIDLookups;
    private readonly inflightPNLookups;
    constructor(keys: SignalKeyStoreWithTransaction, logger: ILogger, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>);
    storeLIDPNMappings(pairs: LIDMapping[]): Promise<void>;
    getLIDForPN(pn: string): Promise<string | null>;
    getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null>;
    private _getLIDsForPNsImpl;
    /**
     * Get PNs for LIDs - USER LEVEL with device construction
     */
    getPNsForLIDs(lids: string[]): Promise<LIDMapping[]>;
    getPNForLID(lid: string): Promise<string | null>;
}
//# sourceMappingURL=lid-mapping.d.ts.map