// Reads and writes the build-env text the release actions take: environment
// variables for the build command, one per line, in the form GitHub uses for
// $GITHUB_ENV:
//
//   NAME=value                  a single-line value
//   NAME<<DELIMITER             a value of any number of lines, ended by a line
//   line one                    holding only DELIMITER
//   line two
//   DELIMITER
//
// Blank lines are skipped. A value that might hold a newline must use the
// NAME<<DELIMITER form, with a delimiter that can't appear in it. Errors name
// the line number only, never its text, since values are secrets.
//
//   node scripts/common/build-env.mjs mask
//     Checks APPS_BUILD_ENV and prints an ::add-mask:: command for every line
//     of every value, so the runner hides them in logs.
//   node scripts/common/build-env.mjs from-secrets
//     Picks the secrets named in APPS_BUILD_SECRETS from APPS_SECRETS_JSON and
//     prints build_env=<build-env text> for $GITHUB_OUTPUT. The reusable
//     workflows use it to turn their build-secrets input into build-env.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses build-env text into [name, value] pairs and a list of problems. */
export function parseBuildEnv(text) {
  const entries = [];
  const problems = [];
  const seen = new Set();
  const lines = (text ?? '').split('\n').map((line) => line.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const heredoc = /^\s*([A-Za-z_][A-Za-z0-9_]*)<<(\S+)\s*$/.exec(line);
    const single = heredoc ? null : /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    let name;
    let value;
    if (heredoc) {
      name = heredoc[1];
      const delimiter = heredoc[2];
      const end = lines.findIndex((candidate, j) => j > i && candidate.trim() === delimiter);
      if (end < 0) {
        problems.push(`build-env line ${i + 1}: ${name} has no closing ${delimiter} line`);
        break;
      }
      value = lines.slice(i + 1, end).join('\n');
      i = end;
    } else if (single) {
      name = single[1];
      value = single[2];
    } else {
      problems.push(`build-env line ${i + 1} isn't NAME=value or NAME<<DELIMITER (a value with several lines needs the NAME<<DELIMITER form)`);
      continue;
    }
    if (seen.has(name.toUpperCase())) {
      problems.push(`build-env sets ${name} twice`);
    } else if (value === '') {
      problems.push(`build-env gives ${name} an empty value: is the secret set in the repo's production environment?`);
    } else {
      seen.add(name.toUpperCase());
      entries.push([name, value]);
    }
  }
  return { entries, problems };
}

/** Writes [name, value] pairs as build-env text, using NAME<<DELIMITER where a value has a newline. */
export function formatBuildEnv(entries) {
  return entries.map(([name, value]) => {
    if (!value.includes('\n') && !value.includes('\r')) return `${name}=${value}`;
    let delimiter;
    do delimiter = `APPS_BUILD_ENV_${randomBytes(9).toString('hex')}`; while (value.includes(delimiter));
    return `${name}<<${delimiter}\n${value}\n${delimiter}`;
  }).join('\n');
}

/** Picks the named secrets from a toJSON(secrets) object. Names match case-insensitively. */
export function selectSecrets(namesText, secretsJson) {
  const names = [...new Set((namesText ?? '').split(/[\s,]+/).filter(Boolean))];
  let secrets;
  try {
    secrets = JSON.parse(secretsJson || '{}');
  } catch {
    // The parser's message can quote part of the input, so it isn't shown.
    return { entries: [], problems: ["couldn't parse the workflow's secrets"] };
  }
  if (!secrets || typeof secrets !== 'object') return { entries: [], problems: ["couldn't parse the workflow's secrets"] };
  const entries = [];
  const problems = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) {
      problems.push(`"${name}" isn't a valid secret name`);
      continue;
    }
    const key = Object.keys(secrets).find((k) => k.toUpperCase() === name.toUpperCase());
    const value = key === undefined ? undefined : secrets[key];
    if (typeof value !== 'string' || value === '') {
      problems.push(`${name} isn't set: add it to the repo's production environment and pass the secrets in (secrets: inherit to the reusable workflow, or build-env on the action)`);
    } else {
      entries.push([name, value]);
    }
  }
  return { entries, problems };
}

/** Escapes a workflow command's data the way @actions/core does. */
function commandData(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function main() {
  const fail = (problems) => {
    console.error(`error: ${problems.join('\n  ')}`);
    process.exit(1);
  };
  const mode = process.argv[2];
  if (mode === 'mask') {
    const { entries, problems } = parseBuildEnv(process.env.APPS_BUILD_ENV);
    if (problems.length) fail(problems);
    for (const [, value] of entries) {
      for (const line of value.split('\n')) {
        if (line.trim()) console.log(`::add-mask::${commandData(line)}`);
      }
    }
    console.log(`Build env: ${entries.map(([name]) => name).join(', ') || 'none'}`);
  } else if (mode === 'from-secrets') {
    const { entries, problems } = selectSecrets(process.env.APPS_BUILD_SECRETS, process.env.APPS_SECRETS_JSON);
    if (problems.length) fail(problems.map((problem) => `build-secrets: ${problem}`));
    const text = formatBuildEnv(entries);
    let delimiter;
    do delimiter = `APPS_OUTPUT_${randomBytes(9).toString('hex')}`; while (text.includes(delimiter));
    process.stdout.write(`build_env<<${delimiter}\n${text}\n${delimiter}\n`);
  } else {
    fail(['usage: build-env.mjs mask | from-secrets']);
  }
}

// Run main only when this file is the script node was started with, not when imported.
const real = (p) => { try { return realpathSync.native(p); } catch { return p; } };
if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) main();
