// Runs a release build with the app's build secrets added to its environment.
// actions/release-mac and actions/release-windows call it when the caller
// passes build-env (or the deprecated build-secrets with the secrets JSON):
//
//   node scripts/common/with-build-secrets.mjs <command> [args...]
//
// Env:
//   APPS_BUILD_ENV       NAME=value lines, or NAME<<DELIMITER blocks for values
//                        with several lines (see build-env.mjs)
//   APPS_BUILD_SECRETS   deprecated: secret names, separated by spaces, commas
//                        or newlines, looked up in
//   APPS_SECRETS_JSON    deprecated: the workflow's secrets as JSON
// The command gets each variable under its own name and none of those three,
// so the build never sees anything else. Values are never printed.
import { spawn } from 'node:child_process';
import { NAME_RE, parseBuildEnv, selectSecrets } from './build-env.mjs';

const CONTROL = ['APPS_BUILD_ENV', 'APPS_BUILD_SECRETS', 'APPS_SECRETS_JSON'];
const fail = (message) => { console.error(`error: build-secrets: ${message}`); process.exit(1); };

const [command, ...args] = process.argv.slice(2);
if (!command) fail('no command to run');

// Environment variables are case-insensitive on Windows, so compare that way everywhere.
const taken = Object.keys(process.env).filter((k) => !CONTROL.includes(k.toUpperCase())).map((k) => k.toUpperCase());
const clash = (name) => `${name} would replace a variable the build step already sets`;

const fromEnv = parseBuildEnv(process.env.APPS_BUILD_ENV);
const problems = [...fromEnv.problems];
// A name that clashes is reported as that, not looked up.
const legacyNames = (process.env.APPS_BUILD_SECRETS ?? '').split(/[\s,]+/).filter(Boolean);
for (const name of legacyNames) if (NAME_RE.test(name) && taken.includes(name.toUpperCase())) problems.push(clash(name));
const lookUp = legacyNames.filter((name) => !(NAME_RE.test(name) && taken.includes(name.toUpperCase())));
const fromSecrets = lookUp.length ? selectSecrets(lookUp.join(' '), process.env.APPS_SECRETS_JSON) : { entries: [], problems: [] };
problems.push(...fromSecrets.problems);
const added = {};
for (const [name, value] of [...fromEnv.entries, ...fromSecrets.entries]) {
  if (!NAME_RE.test(name)) {
    problems.push(`"${name}" isn't a valid secret name`);
  } else if (taken.includes(name.toUpperCase())) {
    problems.push(clash(name));
  } else if (Object.keys(added).some((k) => k.toUpperCase() === name.toUpperCase())) {
    problems.push(`${name} comes from both build-env and build-secrets`);
  } else {
    added[name] = value;
  }
}
if (problems.length) fail(problems.join('\n  '));

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!CONTROL.includes(key.toUpperCase())) env[key] = value;
}
Object.assign(env, added);
console.error(`==> Build secrets: ${Object.keys(added).join(', ') || 'none'}`);

const child = spawn(command, args, { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => fail(`couldn't run ${command}: ${error.message}`));
child.on('exit', (code) => process.exit(code ?? 1));
