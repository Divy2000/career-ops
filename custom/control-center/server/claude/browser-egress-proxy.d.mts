// Types for browser-egress-proxy.mjs.
export interface EgressProxy {
  port: number;
  close(): Promise<void>;
}
export function startEgressProxy(options?: {
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  allow?: (address: string) => boolean;
  timeoutMs?: number;
}): Promise<EgressProxy>;
