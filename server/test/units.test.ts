import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, parseHostAliases } from '../src/config.ts';
import { parseRange } from '../src/files.ts';
import { markdownToHtml } from '../src/markdown.ts';
import { isSparklePublicKey, verifySparkleSignature } from '../src/sparkle.ts';
import { compareVersions, defaultBuild, parseVersion } from '../src/versions.ts';
import { sparkleKeys } from './helpers.ts';

test('versions', () => {
  assert.equal(defaultBuild('1.2.3'), 100200300);
  assert.equal(defaultBuild('0.4.21'), 402100);
  assert.equal(parseVersion('1.02.3'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('v1.2.3'), null);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('markdown escapes everything it does not understand', () => {
  assert.equal(markdownToHtml('# Hi\n\nA <b>bold</b> **move**\nnext line'), '<h3>Hi</h3>\n<p>A &lt;b&gt;bold&lt;/b&gt; <strong>move</strong><br>next line</p>');
  assert.equal(markdownToHtml('- one\n- `two`'), '<ul><li>one</li><li><code>two</code></li></ul>');
  assert.equal(markdownToHtml('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(markdownToHtml('[x](https://a.test/?q="y")'), '<p><a href="https://a.test/?q=&quot;y&quot;">x</a></p>');
});

test('ranges', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-1', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
});

test('sparkle signatures', () => {
  const keys = sparkleKeys();
  const data = Buffer.from('archive bytes');
  assert.ok(isSparklePublicKey(keys.publicKey));
  assert.ok(!isSparklePublicKey('abc'));
  assert.ok(verifySparkleSignature(keys.publicKey, data, keys.sign(data)));
  assert.ok(!verifySparkleSignature(keys.publicKey, Buffer.from('other'), keys.sign(data)));
  assert.ok(!verifySparkleSignature(keys.publicKey, data, 'not base64!'));
});

test('config', () => {
  const env = { APPS_PUBLIC_URL: 'https://apps.moulik.dev/', APPS_REMOTE_NAME: 'moulik', APPS_ADMIN_TOKEN: 'x'.repeat(32) };
  const config = loadConfig(env);
  assert.equal(config.publicUrl, 'https://apps.moulik.dev');
  assert.equal(config.dataDir, '/data');
  assert.equal(config.port, 3000);
  assert.throws(() => loadConfig({ ...env, APPS_ADMIN_TOKEN: 'short' }));
  assert.throws(() => loadConfig({ ...env, APPS_PUBLIC_URL: 'https://apps.moulik.dev/sub' }));
  assert.deepEqual([...parseHostAliases('notes.proletic.co=hobola, Agent.proletic.co=proactive-agent')], [
    ['notes.proletic.co', 'hobola'],
    ['agent.proletic.co', 'proactive-agent'],
  ]);
  assert.throws(() => parseHostAliases('broken'));
});
