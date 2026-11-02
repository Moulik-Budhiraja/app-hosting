// Runs a release build with the app's build secrets added to its environment.
// release-mac.yml and release-windows.yml call it when the caller passes the
// build-secrets input (see DESIGN.md):
//
//   node scripts/common/with-build-secrets.mjs <command> [args...]
//
// Env: APPS_BUILD_SECRETS, the secret names from the input, separated by
// spaces, commas or newlines; APPS_SECRETS_JSON, the workflow's
// toJSON(secrets). The command gets each listed secret as an environment
// variable of the same name, and gets neither of those two variables, so the
// build never sees the other secrets. Secret values are never printed.
import { spawn } from 'node:child_process';

const CONTROL = ['APPS_BUILD_SECRETS', 'APPS_SECRETS_JSON'];
const fail = (message) => { console.error(`error: build-secrets: ${message}`); process.exit(1); };

const [command, ...args] = process.argv.slice(2);
if (!command) fail('no command to run');

const names = [...new Set((process.env.APPS_BUILD_SECRETS ?? '').split(/[\s,]+/).filter(Boolean))];
let secrets;
try {
  secrets = JSON.parse(process.env.APPS_SECRETS_JSON || '{}');
} catch {
  // The parser's message can quote part of the input, so it isn't shown.
  fail("couldn't parse the workflow's secrets");
}
if (!secrets || typeof secrets !== 'object') fail("couldn't parse the workflow's secrets");

// Secret names are case-insensitive on GitHub, and so are environment
// variables on Windows.
const lookup = (object, name) => {
  const key = Object.keys(object).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : object[key];
};
const taken = Object.keys(process.env).filter((k) => !CONTROL.includes(k.toUpperCase()));

const added = {};
const problems = [];
for (const name of names) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    problems.push(`"${name}" isn't a valid secret name`);
  } else if (taken.some((k) => k.toUpperCase() === name.toUpperCase())) {
    problems.push(`${name} would replace a variable the build step already sets`);
  } else {
    const value = lookup(secrets, name);
    if (typeof value !== 'string' || value === '') {
      problems.push(`${name} isn't set: add it to the repo's production environment (or as a repo secret) and call the workflow with secrets: inherit`);
    } else {
      added[name] = value;
    }
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
