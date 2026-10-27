// Checks inspectApk() against a synthetic APK (see fixtures.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectApk } from '../src/apk.js';
import { PNG, buildSampleApk, zip } from './fixtures.js';

test('reads package, version, label and the best bitmap icon', () => {
  const info = inspectApk(buildSampleApk());
  assert.equal(info.packageName, 'dev.apricot.sample');
  assert.equal(info.versionName, '1.2.3');
  assert.equal(info.versionCode, 42);
  assert.equal(info.minSdk, 24);
  assert.equal(info.label, 'Hello Apricot');
  assert.equal(info.iconPath, 'res/mipmap-xxhdpi-v4/ic_launcher.png');
  assert.deepEqual(info.icon, PNG);
  assert.deepEqual(info.abis, ['arm64-v8a']);
});

test('explains split bundles', () => {
  const bundle = zip([['base.apk', Buffer.from('x'), false], ['split_config.arm64_v8a.apk', Buffer.from('y'), false]]);
  assert.throws(() => inspectApk(bundle), /split bundle/);
});

test('rejects files that are not zips', () => {
  assert.throws(() => inspectApk(Buffer.from('definitely not an apk, just some text padding it out')), /not a valid APK/);
});
