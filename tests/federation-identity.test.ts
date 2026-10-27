import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { identityMatches, runtimeIdentity, validRuntimeIdentity, RUNTIME_PROTOCOL, type RuntimeIdentityV1 } from '../src/runner/identity.ts';
import { FEDERATION_PROTOCOL, parseFrame } from '../src/runner/protocol.ts';

function identity(overrides: Partial<RuntimeIdentityV1> = {}): RuntimeIdentityV1 {
    return { upstreamVersion: '0.2.1-rc.3', upstreamCommit: 'abc123', extRelease: '2', patchSetSha256: 'patch',
        packageSetSha256: 'packages', capabilities: { historySource: 1, mountedChat: 1 }, compositionVersion: '0.2.1-rc.3+ext.2',
        protocol: RUNTIME_PROTOCOL, ...overrides };
}

test('runtime identity reports the pinned upstream and a source ext fallback', () => {
    const value = runtimeIdentity({ dshVersion: '0.2.1-rc.3' });
    assert.equal(value.protocol, 2);
    assert.equal(value.upstreamVersion, '0.2.1-rc.3');
    const upstream = JSON.parse(readFileSync(new URL('../UPSTREAMS.json', import.meta.url), 'utf8')) as { dsh: { commit: string } };
    assert.equal(value.upstreamCommit, upstream.dsh.commit, 'the upstream commit comes from the packaged provenance');
    assert.equal(value.extRelease, 'source');
    assert.equal(value.compositionVersion, '0.2.1-rc.3+source');
    assert.deepEqual(value.capabilities, {});
    assert.equal(FEDERATION_PROTOCOL, RUNTIME_PROTOCOL, 'the federation frames and the identity share one protocol revision');
});

test('identity reads the sealed release identity from the bundle state', () => {
  const home = mkdtempSync(join(tmpdir(), 'identity-state-'));
  mkdirSync(join(home, 'hapi-dsh'), { recursive: true });
  writeFileSync(join(home, 'hapi-dsh', 'state.json'), JSON.stringify({ version: 1,
    profiles: { hapi: { active: { releaseId: 'r1' } } },
    releases: { r1: { releaseId: 'r1', dirName: 'r-r1', identity: { upstreamVersion: '0.2.1-rc.3', upstreamCommit: 'e'.repeat(40), extRelease: '7', patchSetSha256: 'a'.repeat(64),
      packageSetSha256: 'b'.repeat(64), capabilities: { historySource: 1, mountedChat: 1, windowCommit: 1 },
      compositionVersion: '0.2.1-rc.3+ext.7' } } } }));
  const value = runtimeIdentity({ dshVersion: '0.2.1-rc.3', dshHome: home, profile: 'hapi' });
  assert.equal(value.upstreamCommit, 'e'.repeat(40), 'the sealed release pins the upstream commit inside the installed runtime too');
  assert.equal(value.extRelease, '7');
  assert.equal(value.patchSetSha256, 'a'.repeat(64));
  assert.deepEqual(value.capabilities, { historySource: 1, mountedChat: 1, windowCommit: 1 });
  assert.equal(value.compositionVersion, '0.2.1-rc.3+ext.7');
});

test('identity matching is exact across every field and capability value', () => {
    const base = identity();
    assert.equal(identityMatches(base, identity()), true);
    for (const key of ['upstreamVersion', 'upstreamCommit', 'extRelease', 'patchSetSha256', 'packageSetSha256', 'compositionVersion'] as const) {
        assert.equal(identityMatches(base, identity({ [key]: 'different' })), false, `${key} must participate in the match`);
    }
    assert.equal(identityMatches(base, identity({ capabilities: { historySource: 1 } })), false, 'a missing capability is a mismatch');
    assert.equal(identityMatches(base, identity({ capabilities: { historySource: 2 } })), false, 'a capability value is part of the identity');
    assert.equal(identityMatches(base, identity({ protocol: 1 as never })), false, 'protocol revisions never cross-match');
    assert.equal(identityMatches(base, undefined), false);
});

test('identity parser accepts the advertised shape and rejects revisions or fields it cannot compare', () => {
    assert.equal(validRuntimeIdentity(identity()), true);
    assert.equal(validRuntimeIdentity(identity({ protocol: 1 as never })), false);
    const { extRelease: _extRelease, ...missing } = identity();
    assert.equal(validRuntimeIdentity(missing), false);
    assert.equal(validRuntimeIdentity({ ...identity(), extra: true }), false);
    assert.equal(validRuntimeIdentity({ ...identity(), capabilities: { historySource: 1.5 } }), false);
    assert.equal(validRuntimeIdentity({ ...identity(), capabilities: { 'Bad Key': 1 } }), false);
});

test('hello and welcome frames carry the identity and reject a stale protocol', () => {
    const value = identity();
    const hello = parseFrame(JSON.stringify({ type: 'hello', protocol: 2, machineId: 'machine-a', name: 'Machine A',
        dshVersion: '0.2.1-rc.3', generation: 'gen-1', identity: value }));
    assert.equal(hello.type, 'hello');
    const welcome = parseFrame(JSON.stringify({ type: 'welcome', protocol: 2, identity: value }));
    assert.equal(welcome.type, 'welcome');
    assert.throws(() => parseFrame(JSON.stringify({ type: 'hello', protocol: 1, machineId: 'machine-a', name: 'Machine A',
        dshVersion: '0.2.1-rc.3', generation: 'gen-1', identity: value })), /Invalid federation frame/);
    assert.throws(() => parseFrame(JSON.stringify({ type: 'hello', protocol: 2, machineId: 'machine-a', name: 'Machine A',
        dshVersion: '0.2.1-rc.3', generation: 'gen-1' })), /Invalid federation frame/);
    assert.throws(() => parseFrame(JSON.stringify({ type: 'welcome', protocol: 2 })), /Invalid federation frame/);
});
