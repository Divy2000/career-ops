import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFetchUrl, checkFetchUrls, checkUrlLiteral, DNS_BUDGET_MS, httpUrlsIn, isPublicAddress, MAX_URL_DESTINATIONS, MAX_URL_HOSTS } from '../../server/claude/guard-policy.mjs';
import { HOOK_TIMEOUT_S } from '../../server/claude/invocation.js';

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const resolvesTo = (map: Record<string, string[]>): Lookup => async (host) => {
  const addrs = map[host];
  if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const publicDns = resolvesTo({ 'jobs.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });

describe('WebFetch guard: checkFetchUrl', () => {
  it('only http and https URLs are fetched', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)', 'ftp://jobs.example.com/x', 'view-source:https://jobs.example.com/', 'not a url'])
      expect(await checkFetchUrl(url, publicDns), url).toEqual(expect.any(String));
  });

  it('local names and literal private, loopback, link-local, metadata and mapped addresses are refused before any lookup', async () => {
    let lookups = 0;
    const counting: Lookup = async (host) => {
      lookups++;
      return publicDns(host);
    };
    for (const url of [
      'http://localhost/',
      'http://LOCALHOST:8080/',
      'http://foo.localhost/',
      'http://printer.local/',
      'http://intranet/',
      'http://127.0.0.1/',
      'http://127.1.2.3:4000/x',
      'http://[::1]/',
      'http://0x7f.1/',
      'http://2130706433/',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/',
      'http://172.16.4.2/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://224.0.0.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://[ff02::1]/',
      'http://[::]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[2002:7f00:1::1]/',
    ])
      expect(await checkFetchUrl(url, counting), url).toEqual(expect.any(String));
    expect(lookups).toBe(0);
  });

  it('a public name that resolves to a loopback or private address is refused', async () => {
    const rebinding = resolvesTo({ 'localtest.me': ['127.0.0.1'], 'mixed.example.com': ['93.184.216.34', '10.1.2.3'], 'v6.example.com': ['::1'] });
    expect(await checkFetchUrl('http://localtest.me:4000/', rebinding)).toMatch(/127\.0\.0\.1/);
    expect(await checkFetchUrl('https://mixed.example.com/', rebinding)).toMatch(/10\.1\.2\.3/);
    expect(await checkFetchUrl('https://v6.example.com/', rebinding)).toMatch(/::1/);
  });

  it('a lookup error, an empty answer or a lookup that never answers is refused', async () => {
    expect(await checkFetchUrl('https://nowhere.example.org/', publicDns)).toMatch(/could not resolve/);
    expect(await checkFetchUrl('https://empty.example.org/', async () => [])).toMatch(/could not resolve/);
    const hang: Lookup = () => new Promise(() => {});
    expect(await checkFetchUrl('https://slow.example.org/', hang, { timeoutMs: 50 })).toMatch(/could not resolve/);
  });

  it('a public name resolving to public addresses is allowed, and so is a literal public address', async () => {
    expect(await checkFetchUrl('https://jobs.example.com/x/1', publicDns)).toBeNull();
    expect(await checkFetchUrl('http://jobs.example.com:8443/x', publicDns)).toBeNull();
    expect(await checkFetchUrl('https://93.184.216.34/', publicDns)).toBeNull();
    expect(await checkFetchUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/', publicDns)).toBeNull();
  });
});

describe('address classification', () => {
  it('classifies IPv4 and IPv6 addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.127.0.1', '0.0.0.0', '255.255.255.255', '198.18.0.1', '192.0.2.1', '::1', '::', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', 'not-an-ip'])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('checkUrlLiteral needs no network and refuses what the URL itself shows to be local', () => {
    expect(checkUrlLiteral('https://jobs.example.com/x')).toBeNull();
    expect(checkUrlLiteral('http://127.0.0.1/')).toEqual(expect.any(String));
    expect(checkUrlLiteral('file:///etc/passwd')).toEqual(expect.any(String));
  });

  it('httpUrlsIn lists the http(s) arguments and inline flag values of a command', () => {
    expect(httpUrlsIn('node check-liveness.mjs https://a.example/1 --url=http://b.example/2 jds/x.md')).toEqual(['https://a.example/1', 'http://b.example/2']);
    expect(httpUrlsIn('node merge-tracker.mjs')).toEqual([]);
  });
});

describe('DNS budget: every lookup of one call shares one deadline, well inside the hook timeout', () => {
  // The budget is measured on fake timers, so a loaded machine that fires timers late cannot fail it (SW5-tests-15).
  afterEach(() => vi.useRealTimers());
  /** Starts the check and reports whether it has answered once `ms` of fake time has passed. */
  const answeredWithin = async (check: () => Promise<string | null>, ms: number) => {
    vi.useFakeTimers();
    let answer: { why: string | null } | null = null;
    void check().then((why) => (answer = { why }));
    await vi.advanceTimersByTimeAsync(ms);
    return answer as { why: string | null } | null;
  };
  // A hook still running at its timeout does not block (probe C14), so the DNS check must always answer first.
  it('the budget leaves the hook time to refuse before its own timeout, and the host cap fits the lookup pool', () => {
    expect(DNS_BUDGET_MS).toBeLessThanOrEqual((HOOK_TIMEOUT_S * 1000 * 2) / 3);
    expect(MAX_URL_HOSTS).toBe(4);
  });

  it('given 8 URLs whose lookups never answer, refuses within one budget, with every lookup started at once', async () => {
    const started: string[] = [];
    const hang: Lookup = (host) => {
      started.push(host);
      return new Promise(() => {});
    };
    const urls = ['a', 'b', 'c', 'd'].flatMap((h) => [`https://${h}.example.org/1`, `https://${h}.example.org/2`]);
    // One budget for the call, not one per host (one after another would take 4 budgets).
    const answer = await answeredWithin(() => checkFetchUrls(urls, hang, { label: 'Bash', budgetMs: 300 }), 300);
    expect(answer?.why).toMatch(/^Bash: could not resolve/);
    expect([...started].sort()).toEqual(['a.example.org', 'b.example.org', 'c.example.org', 'd.example.org']);
  });

  it('a host that hangs next to a host that resolves to the metadata address: refused within the budget', async () => {
    const lookup: Lookup = (host) => (host === 'meta.example.org' ? Promise.resolve([{ address: '169.254.169.254', family: 4 }]) : new Promise(() => {}));
    const answer = await answeredWithin(() => checkFetchUrls(['https://slow.example.org/x', 'https://meta.example.org/latest'], lookup, { budgetMs: 300 }), 300);
    expect(answer?.why).toEqual(expect.any(String));
  });

  it('more than 4 distinct hosts in one call are refused before any lookup; 4 public hosts pass', async () => {
    let lookups = 0;
    const counting: Lookup = async (host) => {
      lookups++;
      return [{ address: '93.184.216.34', family: 4 }].map((a) => ({ ...a, host }));
    };
    const five = ['a', 'b', 'c', 'd', 'e'].map((h) => `https://${h}.example.org/x`);
    expect(await checkFetchUrls(five, counting, { label: 'Bash' })).toMatch(/5 different hosts/);
    expect(lookups).toBe(0);
    // Several URLs on one host count once.
    expect(await checkFetchUrls([...five.slice(0, 4), 'https://a.example.org/other', 'https://A.EXAMPLE.ORG/again'], counting, { label: 'Bash' })).toBeNull();
    expect(lookups).toBe(4);
  });

  it('a literal problem in any URL is refused without a lookup', async () => {
    let lookups = 0;
    const counting: Lookup = async () => {
      lookups++;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    expect(await checkFetchUrls(['https://jobs.example.com/1', 'http://127.0.0.1/'], counting)).toMatch(/127\.0\.0\.1/);
    expect(lookups).toBe(0);
  });
});

describe('host caps: names that need DNS are capped tightly, literal addresses only by a generous total', () => {
  const ip = (n: number) => `https://93.184.216.${n}/x`;
  const counter = () => {
    const c = { lookups: 0 };
    const lookup: Lookup = async () => {
      c.lookups++;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    return { c, lookup };
  };

  it('given 5 public literal addresses, allows them without a lookup', async () => {
    const { c, lookup } = counter();
    expect(await checkFetchUrls([1, 2, 3, 4, 5].map(ip), lookup, { label: 'Bash' })).toBeNull();
    expect(c.lookups).toBe(0);
  });

  it('4 names plus 12 literal addresses (16 destinations) pass; a 17th destination is refused before any lookup', async () => {
    expect(MAX_URL_DESTINATIONS).toBe(16);
    const names = ['a', 'b', 'c', 'd'].map((h) => `https://${h}.example.org/x`);
    const twelve = Array.from({ length: 12 }, (_, i) => ip(i + 1));
    const ok = counter();
    expect(await checkFetchUrls([...names, ...twelve], ok.lookup, { label: 'Bash' })).toBeNull();
    expect(ok.c.lookups).toBe(4);
    const over = counter();
    expect(await checkFetchUrls([...names, ...twelve, ip(13)], over.lookup, { label: 'Bash' })).toMatch(/17 different destinations/);
    expect(over.c.lookups).toBe(0);
    const ips = counter();
    expect(await checkFetchUrls(Array.from({ length: 17 }, (_, i) => ip(i + 1)), ips.lookup, { label: 'Bash' })).toMatch(/17 different destinations/);
    expect(ips.c.lookups).toBe(0);
  });

  it('5 names are still refused before any lookup, however few literal addresses come with them', async () => {
    const { c, lookup } = counter();
    expect(await checkFetchUrls([...['a', 'b', 'c', 'd', 'e'].map((h) => `https://${h}.example.org/x`), ip(1)], lookup, { label: 'Bash' })).toMatch(/5 different hosts to resolve/);
    expect(c.lookups).toBe(0);
  });
});
