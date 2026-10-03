export interface SystemStatus {
  node: string;
  claude: { bin: string; version: string | null; error: string | null };
  roots: { code: string; data: string };
  keychainTokenPresent: boolean;
  anthropicApiKeySet: boolean;
  careerOps: { version: string | null };
}
