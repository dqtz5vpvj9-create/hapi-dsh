/**
 * pnpm `overrides` management for the staged profile.
 *
 * Rules from the distribution spec:
 *  - hapi-dsh only ever owns the overrides it recorded in its own release
 *    state; every other key in the profile is the user's and is preserved.
 *  - an existing key with a different value that hapi-dsh did not write is a
 *    conflict: installation fails instead of overwriting it.
 *  - `file:` targets always resolve inside the immutable release directory.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Package-name-shaped key check, so state files cannot inject arbitrary keys. */
const PACKAGE_NAME = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

function toPosix(path) {
    return path.split(sep).join('/');
}

/**
 * A `file:` specifier for `target` that resolves against `fromDirectory`.
 * Climbing (`../..`) is expected because the profile lives beside the release
 * store; the resolved target itself is checked by `assertTargetInside`.
 */
export function fileSpecifier(fromDirectory, target) {
    const relativePath = toPosix(relative(resolve(fromDirectory), resolve(target)));
    if (relativePath === '') throw new Error(`cannot express ${target} relative to ${fromDirectory}`);
    return `file:${relativePath.startsWith('.') ? relativePath : `./${relativePath}`}`;
}

/** Throw when a specifier escapes the release root. */
export function assertTargetInside(target, releaseRoot, name) {
    const resolvedTarget = resolve(target);
    const resolvedRoot = resolve(releaseRoot);
    const rel = relative(resolvedRoot, resolvedTarget);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`override target for ${name} resolves outside its release directory`);
    }
}

/**
 * Build the override map hapi-dsh wants for this release.
 * style 'tarball': file: point at payload/dsh-ext/*.tgz
 * style 'directory': file: point at the unpacked payload/dsh-ext/<slug>/package
 */
export function buildManagedOverrides({ manifest, releaseRoot, profileDirectory, style = 'tarball', extractedExtDirectories = {} }) {
    const overrides = {};
    const targets = {};
    for (const item of manifest.payload.dshExt) {
        if (!PACKAGE_NAME.test(item.name)) throw new Error(`refusing to write an override for an unexpected package name: ${item.name}`);
        const target = style === 'tarball'
            ? resolve(releaseRoot, item.tarball)
            : extractedExtDirectories[item.name];
        if (!target) throw new Error(`no unpacked directory for ${item.name}; directory-style overrides need the extracted payload`);
        assertTargetInside(target, releaseRoot, item.name);
        overrides[item.name] = fileSpecifier(profileDirectory, target);
        targets[item.name] = target;
    }
    return { overrides, targets };
}

/**
 * Merge managed overrides into the profile's existing override map.
 * Returns { overrides, conflicts, removed } without mutating the inputs.
 */
export function mergeOverrides({ existing = {}, managed, previousManaged = {} }) {
    const conflicts = [];
    const removed = [];
    const result = {};
    for (const [key, value] of Object.entries(existing)) {
        if (typeof value !== 'string') throw new Error(`the profile contains a non-string override for ${key}`);
        result[key] = value;
    }
    for (const [key, value] of Object.entries(managed)) {
        if (!PACKAGE_NAME.test(key)) throw new Error(`refusing to manage an override for an unexpected package name: ${key}`);
        if (!(key in result)) {
            result[key] = value;
            continue;
        }
        if (result[key] === value) continue;
        if (previousManaged[key] === result[key]) {
            result[key] = value;
            continue;
        }
        conflicts.push({ key, existing: result[key], managed: value });
    }
    for (const key of Object.keys(previousManaged)) {
        if (key in managed) continue;
        if (!(key in result)) continue;
        if (result[key] === previousManaged[key]) {
            delete result[key];
            removed.push(key);
        } else {
            conflicts.push({ key, existing: result[key], managed: undefined });
        }
    }
    return { overrides: result, conflicts, removed };
}

export function overridesEqual(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index++) {
        if (leftKeys[index] !== rightKeys[index]) return false;
        if (left[leftKeys[index]] !== right[rightKeys[index]]) return false;
    }
    return true;
}

export function describeConflicts(conflicts) {
    return conflicts.map(({ key, existing, managed }) => managed === undefined
        ? `${key}: profile has ${existing} but this bundle no longer manages it`
        : `${key}: profile has ${existing}, bundle needs ${managed}`).join('; ');
}
