// Test helpers: a made-up data root whose cv.md matches a payload, so the fact
// check and the section-order check have a real source to compare against.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..', '..');
export const loadFixture = () => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'payload-typical.json'), 'utf8'));

// cv.md headings in the fork template's section order.
export function cvMarkdownFor(payload) {
  const lines = [`# CV -- ${payload.candidate.name}`, '', '## Professional Summary', '', payload.summary, '', '## Work Experience', ''];
  for (const e of payload.experience) {
    lines.push(`### ${e.company} -- ${e.location}`, '', `**${e.role}** | ${e.dates}`, '', ...e.bullets.map((b) => `- ${b}`), '');
  }
  lines.push('## Projects', '');
  for (const p of payload.projects) {
    const text = [p.description, ...(p.bullets ?? [])].filter(Boolean).join(' ');
    lines.push(`- **${p.name}**${p.url ? ` (${p.url})` : ''} -- ${text}`);
  }
  lines.push('', '## Education', '');
  for (const e of payload.education) lines.push(`- ${e.title}, ${e.org}, ${e.location} (${e.year}) ${e.description ?? ''}`.trimEnd());
  lines.push('', '## Recent Achievements', '');
  for (const a of payload.awards) lines.push(`- **${a.title}** -- ${a.org}, ${a.year}`);
  lines.push('', '## Skills', '');
  for (const s of payload.skills) lines.push(`- **${s.category}:** ${s.items.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

export function dataRoot({ cv = null, library = null } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cv-root-')));
  if (cv !== null) fs.writeFileSync(path.join(d, 'cv.md'), cv);
  if (library !== null) fs.writeFileSync(path.join(d, 'article-digest.md'), library);
  fs.mkdirSync(path.join(d, 'output'));
  return d;
}

export function envFor(root) {
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  delete env.CAREER_OPS_DATA_DIR;
  return env;
}
