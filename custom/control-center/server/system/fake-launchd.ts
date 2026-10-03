// In-memory stand-in for launchctl and plutil. Used by the API tests directly
// and by the e2e server when CC_FAKE_LAUNCHD=1 under NODE_ENV=test, so no
// test ever registers or removes a real launchd job.
import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '../config.js';
import { execNoShell, type Exec } from '../routes/system.js';

export interface LaunchdCall {
  cmd: string;
  args: string[];
}

export function plistToJson(xml: string): Record<string, unknown> {
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
  const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? '';
  const programArguments = [...argsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
  const sci: Record<string, number> = {};
  for (const key of ['Hour', 'Minute', 'Weekday']) {
    const m = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(xml);
    if (m) sci[key] = Number(m[1]);
  }
  return { Label: label, ProgramArguments: programArguments, StartCalendarInterval: sci };
}

export function fakeLaunchdExec(fallback: Exec = execNoShell): { exec: Exec; calls: LaunchdCall[]; loaded: Set<string> } {
  const calls: LaunchdCall[] = [];
  const loaded = new Set<string>();
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd !== 'launchctl' && cmd !== 'plutil') return fallback(cmd, args, opts);
    calls.push({ cmd, args: [...args] });
    if (cmd === 'plutil') {
      const file = args[args.length - 1]!;
      let xml: string;
      try {
        xml = fs.readFileSync(file, 'utf8');
      } catch {
        return { code: 1, stdout: '', stderr: `${file}: file does not exist or is not readable` };
      }
      if (args[0] === '-lint') return xml.includes('<plist') ? { code: 0, stdout: `${file}: OK\n`, stderr: '' } : { code: 1, stdout: '', stderr: `${file}: not a property list` };
      return { code: 0, stdout: JSON.stringify(plistToJson(xml)), stderr: '' };
    }
    const sub = args[0];
    if (sub === 'print') {
      const label = (args[1] ?? '').split('/').pop() ?? '';
      return loaded.has(label) ? { code: 0, stdout: `gui/501/${label} = {\n\tstate = waiting\n\tlast exit code = 0\n}\n`, stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service in domain for port' };
    }
    if (sub === 'bootout') {
      const label = (args[1] ?? '').split('/').pop() ?? '';
      return loaded.delete(label) ? { code: 0, stdout: '', stderr: '' } : { code: 113, stdout: '', stderr: 'Boot-out failed: 113: Could not find specified service' };
    }
    if (sub === 'bootstrap') {
      loaded.add(path.basename(args[2] ?? '', '.plist'));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `fake launchctl: unsupported subcommand ${sub}` };
  };
  return { exec, calls, loaded };
}

/** Test builds only: swap the real launchctl/plutil for the fake when asked. */
export function maybeFakeLaunchd(cfg: ServerConfig, exec: Exec): Exec {
  if (process.env.CC_FAKE_LAUNCHD === '1') {
    if (cfg.nodeEnv !== 'test') throw new Error('CC_FAKE_LAUNCHD is only honored under NODE_ENV=test');
    return fakeLaunchdExec(exec).exec;
  }
  return exec;
}
