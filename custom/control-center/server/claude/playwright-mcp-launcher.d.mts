// Types for playwright-mcp-launcher.mjs.
export const PLAYWRIGHT_MCP_PACKAGE: string;
export function playwrightMcpArgs(proxyPort: number, extra?: string[]): string[];
export function playwrightMcpEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function launch(extra?: string[]): Promise<void>;
