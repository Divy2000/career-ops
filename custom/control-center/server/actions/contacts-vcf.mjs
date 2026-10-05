// Export contacts (vCard): contacts.mjs --vcf writes its file inside the code checkout (and refuses a data root outside
// it) and prints only a status line, so this prints the cards themselves, built by contacts.mjs's own parseContacts
// and buildVcf (contracted in server/core/contract.json) from CAREER_OPS_ROOT/data/contacts.tsv. Exit 3: no contacts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVcf, parseContacts } from '../../../../contacts.mjs';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--caller-id');
if (unknown.length) {
  console.error(`unrecognized argument(s): ${unknown.join(' ')}`);
  process.exit(2);
}
const file = join(getCareerOpsRoot(), 'data', 'contacts.tsv');
const { contacts } = parseContacts(existsSync(file) ? readFileSync(file, 'utf-8') : '');
const vcf = buildVcf(contacts, { callerId: args.includes('--caller-id') });
if (!vcf) {
  console.error('No contacts to export: data/contacts.tsv is empty or missing.');
  process.exit(3);
}
process.stdout.write(vcf);
