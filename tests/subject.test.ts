// The derived artifact names (DN-160.D2; DN-160.O1 arms 3, 10, 11). The expected names are spelled out from the grammar here, never read from the
// Action: an arm must red if the derivation drifts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DefaultArtifactClient } from '@actions/artifact';

import { derivedBaselineName, derivedReportName } from '../src/subject.js';

function digest(job: string, capture: string, tag: string): string {
    return createHash('sha256').update(JSON.stringify([job, capture, tag]), 'utf8').digest('hex').slice(0, 16);
}

// ── Arm 3: identity is the rendered name ────────────────────────────────────────────────────

test('DN-160.O1 arm 3: two reusable calls and two matrix legs derive two names each', () => {
    const pairs: [string, string][] = [
        ['linux / build', 'windows / build'],
        ['test (ubuntu, 20)', 'test (windows, 20)'],
    ];
    for (const [left, right] of pairs) {
        const leftName = derivedBaselineName({ job: left, capture: '' }, '');
        const rightName = derivedBaselineName({ job: right, capture: '' }, '');
        assert.notEqual(leftName, rightName, `"${left}" and "${right}" are two jobs, so two lineages: ${leftName}`);
    }
});

// ── Arm 10: the report's name carries the attempt ──────────────────────────────────────────

test('DN-160.O1 arm 10: attempts 1 and 2 of one job name two reports, over the baseline\'s key', () => {
    const subject = { job: 'build / build', capture: '' };
    const key = digest('build / build', '', '');
    assert.equal(derivedReportName(subject, '', 1), `tamys-report-build-build-${key}-1`);
    assert.equal(derivedReportName(subject, '', 2), `tamys-report-build-build-${key}-2`);
});

// ── Arm 11: the name grammar ───────────────────────────────────────────────────────────────

const GRAMMAR: ReadonlyArray<{ job: string; capture: string; tag: string; slug: string }> = [
    { job: 'build / build', capture: '', tag: '', slug: 'build-build' },
    { job: 'test (ubuntu-24.04, 20)', capture: '', tag: '', slug: 'test-ubuntu-24.04-20' },
    { job: 'deploy: "prod"', capture: '', tag: '', slug: 'deploy-prod' },
    { job: 'a\\b<c>|d*e?f', capture: '', tag: '', slug: 'a-b-c-d-e-f' },
    { job: 'compilación ✓ ok', capture: '', tag: '', slug: 'compilaci-n-ok' },
    // A section name reaches the slug; `auto` and `off` name no section and do not.
    { job: 'ci / build', capture: 'release', tag: 'vs-main', slug: 'ci-build-release-vs-main' },
    { job: 'ci / build', capture: 'auto', tag: '', slug: 'ci-build' },
    { job: 'ci / build', capture: 'off', tag: '', slug: 'ci-build' },
    // 60 characters: cut to 40, then the trailing `-` the cut exposed is trimmed again.
    { job: `${'x'.repeat(39)} ${'y'.repeat(20)}`, capture: '', tag: '', slug: 'x'.repeat(39) },
    { job: 'z'.repeat(60), capture: '', tag: '', slug: 'z'.repeat(40) },
    // Nothing legible: the slug segment is dropped, the digest alone names the lineage.
    { job: '✓✓✓', capture: '', tag: '', slug: '' },
];

for (const cell of GRAMMAR) {
    test(`DN-160.O1 arm 11: ${JSON.stringify(cell.job)} (capture ${JSON.stringify(cell.capture)}, tag ${JSON.stringify(cell.tag)}) → slug ${JSON.stringify(cell.slug)}`, () => {
        const key = digest(cell.job, cell.capture, cell.tag);
        const expected = cell.slug === '' ? `tamys-baseline-${key}` : `tamys-baseline-${cell.slug}-${key}`;
        assert.equal(derivedBaselineName({ job: cell.job, capture: cell.capture }, cell.tag), expected);
    });
}

test('DN-160.O1 arm 11: the digest is over the JSON triple, so the tag and the capture separate lineages', () => {
    const subject = { job: 'ci / build', capture: '' };
    const names = new Set([
        derivedBaselineName(subject, ''),
        derivedBaselineName(subject, 'vs-main'),
        derivedBaselineName({ ...subject, capture: 'auto' }, ''),
        derivedBaselineName({ ...subject, capture: 'off' }, ''),
    ]);
    assert.equal(names.size, 4, `four keys, four names: ${[...names].join(', ')}`);
});

test('DN-160.O1 arm 11: every derived name passes @actions/artifact\'s own name validation', async () => {
    // The client validates the name first, then finds no file to upload: a FilesNotFoundError
    // means the name was accepted, an "artifact name is not valid" error that it was refused.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-names-'));
    const client = new DefaultArtifactClient();
    for (const cell of GRAMMAR) {
        for (const name of [
            derivedBaselineName({ job: cell.job, capture: cell.capture }, cell.tag),
            derivedReportName({ job: cell.job, capture: cell.capture }, cell.tag, 3),
        ]) {
            await assert.rejects(client.uploadArtifact(name, [], dir), (error: Error) => {
                assert.doesNotMatch(error.message, /artifact name is not valid/, `${name} was refused: ${error.message}`);
                assert.match(error.message, /No files were found/, `${name}: unexpected error ${error.message}`);
                return true;
            });
        }
    }
});
