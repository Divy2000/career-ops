export type KeychainTokenStatus = { state: 'present' | 'missing'; reason: null } | { state: 'unreadable'; reason: string };

export interface SystemStatus {
  node: string;
  /** `approved`: sessions may run on this version; `problem` says why not when claude runs but is not approved. */
  claude: { bin: string; version: string | null; error: string | null; approved: boolean; problem: string | null };
  roots: { code: string; data: string };
  keychainTokenPresent: boolean;
  /** `unreadable`: the reader failed for a reason other than an absent token (a locked keychain, a timeout), given in `reason`. */
  keychainToken: KeychainTokenStatus;
  anthropicApiKeySet: boolean;
  careerOps: { version: string | null };
}
