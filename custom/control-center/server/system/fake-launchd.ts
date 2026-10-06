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

/**
 * What `launchctl print` shows for a loaded job, in the real shape (tests/fixtures/launchctl): a job that never fired
 * reads "not running", runs 0 and "(never exited)"; after it fires, its run count and last exit code.
 */
function printJob(label: string, history: { runs: number; lastExit: number } | undefined): string {
  const runs = history?.runs ?? 0;
  const exit = history ? String(history.lastExit) : '(never exited)';
  return `gui/501/${label} = {\n\tactive count = 0\n\ttype = LaunchAgent\n\tstate = not running\n\n\truns = ${runs}\n\tlast exit code = ${exit}\n}\n`;
}

export function fakeLaunchdExec(fallback: Exec = execNoShell): {
  exec: Exec;
  calls: LaunchdCall[];
  loaded: Set<string>;
  disabled: Set<string>;
  login: (agentsDir: string) => void;
  /** launchd firing a loaded job once, which exits with `code`. */
  fire: (label: string, code: number) => void;
} {
  const calls: LaunchdCall[] = [];
  const loaded = new Set<string>();
  // Per label, as launchd keeps it while the job stays loaded: a bootout or a fresh bootstrap starts it over.
  const history = new Map<string, { runs: number; lastExit: number }>();
  const fire = (label: string, code: number) => {
    if (!loaded.has(label)) throw new Error(`fake launchd: ${label} is not loaded`);
    history.set(label, { runs: (history.get(label)?.runs ?? 0) + 1, lastExit: code });
  };
  // launchctl disable/enable state: it outlives bootout and is what launchd consults at login.
  const disabled = new Set<string>();
  /** What launchd does at login: load every plist in the agents dir whose label is not disabled. */
  const login = (agentsDir: string) => {
    loaded.clear();
    history.clear();
    for (const name of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
      const label = path.basename(name, '.plist');
      if (name.endsWith('.plist') && !disabled.has(label)) loaded.add(label);
    }
  };
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
      return loaded.has(label) ? { code: 0, stdout: printJob(label, history.get(label)), stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service in domain for port' };
    }
    if (sub === 'bootout') {
      const label = (args[1] ?? '').split('/').pop() ?? '';
      history.delete(label);
      return loaded.delete(label) ? { code: 0, stdout: '', stderr: '' } : { code: 113, stdout: '', stderr: 'Boot-out failed: 113: Could not find specified service' };
    }
    if (sub === 'bootstrap') {
      const label = path.basename(args[2] ?? '', '.plist');
      if (disabled.has(label)) return { code: 119, stdout: '', stderr: 'Bootstrap failed: 119: Service is disabled' };
      loaded.add(label);
      history.delete(label);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'disable' || sub === 'enable') {
      const label = (args[1] ?? '').split('/').pop() ?? '';
      if (sub === 'disable') disabled.add(label);
      else disabled.delete(label);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'print-disabled') {
      return { code: 0, stdout: `disabled services = {\n${[...disabled].map((l) => `\t"${l}" => disabled\n`).join('')}}\n`, stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `fake launchctl: unsupported subcommand ${sub}` };
  };
  return { exec, calls, loaded, disabled, login, fire };
}

/** Test builds only: swap the real launchctl/plutil for the fake when asked. */
export function maybeFakeLaunchd(cfg: ServerConfig, exec: Exec): Exec {
  if (process.env.CC_FAKE_LAUNCHD === '1') {
    if (cfg.nodeEnv !== 'test') throw new Error('CC_FAKE_LAUNCHD is only honored under NODE_ENV=test');
    return fakeLaunchdExec(exec).exec;
  }
  return exec;
}
