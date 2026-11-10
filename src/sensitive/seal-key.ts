/** A data key for `Remember.Sealed` records: 32 bytes (AES-256). */
export interface SealKey {
  id: string;
  key: Uint8Array;
}

export interface SealKeyProvider {
  /** Key for new records. Implementations cache; Estela calls it once per sealed write. */
  current(): Promise<SealKey>;
  /** Key of an existing record; undefined when retired. */
  byId(id: string): Promise<SealKey | undefined>;
}
