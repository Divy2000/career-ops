// DNS for the guard hook subprocesses the tests start (loaded with --import): a name CC_TEST_DNS maps answers with
// those addresses, any other name fails as unresolvable. Nothing reaches the machine's resolver, so a resolver that
// answers every name (NXDOMAIN hijacking, wildcard corporate DNS) cannot change a result.
import dns from 'node:dns';

const table = JSON.parse(process.env.CC_TEST_DNS ?? '{}');
dns.promises.lookup = async (host) => {
  const addresses = table[String(host).toLowerCase()];
  if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
