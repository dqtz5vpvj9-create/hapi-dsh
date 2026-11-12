#!/usr/bin/env node
/** Runs from the independent archive; api.mjs is built beside this entry. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { extractBrowserRecovery, createFilesStage, runOfflineMigration, resumeOfflineRecovery } from './api.mjs';

const help = `Offline recovery — Node.js 24 or later; no DSH, credentials or network required.

  node cli.mjs recover-browser --input BROWSER_EXPORT.json --output FRESH_DIRECTORY
  node cli.mjs extract-browser --input BROWSER_EXPORT.json --output FRESH_DIRECTORY
  node cli.mjs capture --request PRIVATE_REQUEST.json --output RECOVERY_DIRECTORY
  node cli.mjs resume --output RECOVERY_DIRECTORY

recover-browser preserves the selected export, drafts and Blob bytes in a local
recovery package. It does not assign an account, install data, contact a source,
send a message, restore Push or attach a terminal. See README.md for exact mapping.
`;

try {
    const { values, positionals } = parseArgs({ options: {
        input: { type: 'string' }, request: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    }, allowPositionals: true });
    if (values.help || positionals.length === 0) process.stdout.write(help);
    else {
        const [command] = positionals;
        if (positionals.length !== 1 || !['recover-browser', 'extract-browser', 'capture', 'resume'].includes(command)) throw Error('Unknown command');
        if (!values.output) throw Error('Missing output');
        const output = resolve(values.output);
        let result;
        if (command === 'resume') result = await resumeOfflineRecovery(output);
        else if (command === 'capture') {
            if (!values.request) throw Error('Missing request');
            result = await runOfflineMigration(JSON.parse(await readFile(values.request, 'utf8')), output);
        } else {
            if (!values.input) throw Error('Missing browser export');
            if (command === 'extract-browser') result = await extractBrowserRecovery(values.input, output);
            else {
                await mkdir(output, { mode: 0o700 });
                const { snapshot } = await extractBrowserRecovery(values.input, join(output, 'selected'));
                const request = { version: 1, packageId: `browser-recovery-${randomUUID()}`, scope: 'unassigned-local-browser-export',
                    snapshot, requiredStages: [{ id: 'files', version: '1' }] };
                await writeFile(join(output, 'request.json'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
                result = await runOfflineMigration(request, join(output, 'recovery'), [createFilesStage({
                    inputs: [{ inputId: 'browser-export', kind: 'browser-export' }, { inputId: 'browser-blobs', kind: 'browser-blobs' }],
                    binaries: snapshot.inputs.filter(input => input.format === 'binary').map(input => ({ inputId: input.id })),
                })]);
            }
        }
        if ('packageId' in result) process.stdout.write(JSON.stringify({ packageId: result.packageId, status: result.status,
            inputs: result.inputs.length, objects: result.objects.length, unresolved: result.unresolved, automaticInstall: false, automaticDispatch: false }) + '\n');
        else process.stdout.write(JSON.stringify({ inputs: result.snapshot.inputs.length, blobs: result.blobs, bytes: result.bytes }) + '\n');
    }
} catch {
    process.stderr.write('Offline recovery did not complete. Keep the selected original and any partial private output. Use a fresh directory for browser extraction; use resume for an existing recovery package. No source operation was dispatched.\n');
    process.exitCode = 1;
}
