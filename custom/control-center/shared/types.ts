export interface SystemStatus {
  node: string;
  /** `approved`: sessions may run on this version; `problem` says why not when claude runs but is not approved. */
  claude: { bin: string; version: string | null; error: string | null; approved: boolean; problem: string | null };
  roots: { code: string; data: string };
  keychainTokenPresent: boolean;
  anthropicApiKeySet: boolean;
  careerOps: { version: string | null };
}
