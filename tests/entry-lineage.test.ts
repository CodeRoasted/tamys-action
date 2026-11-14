// A baseline lineage belongs to one job (DN-160.O1), driven through the SHIPPED ENTRY: src/main.ts
// runs as a child process against a local stand-in for the REST API (GITHUB_API_URL) and for the
// artifact service the runner's runtime token reaches (ACTIONS_RESULTS_URL). The decisions under
// test are taken at the entry — which job this run is, which name it reads and publishes, whether a
// stored baseline is another job's — so the arms observe what the entry DOES: the names it uploads
// under (the artifact service records every CreateArtifact), whether it downloads or hands the engine
// a baseline, the warnings it prints, and the comment it writes to the job summary.
//
// The expected names are spelled out here from DN-160.D2's grammar, never imported from the Action:
// an arm must red if the derivation drifts, so it may not read the derivation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js');

const OWNER = 'octo';
const REPO = 'demo';
const RUN_ID = 5150;
const WORKFLOW_ID = 77;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
// The newest green run of this workflow on `main`, the base run `auto` resolves.
const BASE_RUN_ID = 4040;
const BASE_RUN_SHA = 'a'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);
// This step's runner, and another job's.
const RUNNER = 'GitHub Actions 7';
const OTHER_RUNNER = 'GitHub Actions 8';

// The two jobs of tamys-action CI run 43606780330, as its listing renders them.
const BUILD = 'build / build';
const MANIFEST_LOAD = 'manifest-load / manifest-load';

// DN-160.D2: `tamys-<kind>-<slug>-<first 16 hex of sha256 over JSON [job, capture, tag]>`.
function digest(job: string, capture: string, tag: string): string {
    return createHash('sha256').update(JSON.stringify([job, capture, tag]), 'utf8').digest('hex').slice(0, 16);
}
const BUILD_BASELINE = `tamys-baseline-build-build-${digest(BUILD, '', '')}`;
// DN-160.D4 (6): the report's name carries the run attempt; the baseline's never does.
const buildReport = (attempt: number) => `tamys-report-build-build-${digest(BUILD, '', '')}-${attempt}`;

interface ListingRow {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    run_attempt: number;
    runner_name: string | null;
}

function row(id: number, name: string, status: string, runner: string | null): ListingRow {
    return { id, name, status, conclusion: status === 'completed' ? 'success' : null, run_attempt: 1, runner_name: runner };
}

// The listing of a `log:`-mode step: this step's job in progress on RUNNER, a sibling on another.
const TWO_JOBS = [row(1, BUILD, 'in_progress', RUNNER), row(2, MANIFEST_LOAD, 'in_progress', OTHER_RUNNER)];

interface StoredArtifact {
    id: number;
    name: string;
    created_at: string;
    size?: number;
    /** The run that produced it. */
    run_id: number;
    sidecar: Record<string, unknown>;
}

function sidecar(subject: { job: string; capture: string } | undefined, version = '0.4.0'): Record<string, unknown> {
    const meta: Record<string, unknown> = { context_version: version, outcome_token: 'success', transport: [] };
    if (subject) meta.subject = subject;
    return meta;
}

function zipOf(artifact: StoredArtifact): Buffer {
    const zip = new AdmZip();
    zip.addFile('changed.log', Buffer.from('compile\nok\n', 'utf8'));
    zip.addFile('tamys-baseline-meta.json', Buffer.from(JSON.stringify(artifact.sidecar), 'utf8'));
    return zip.toBuffer();
}

function apiArtifact(artifact: StoredArtifact): Record<string, unknown> {
    return {
        id: artifact.id,
        name: artifact.name,
        expired: false,
        size_in_bytes: artifact.size ?? 512,
        created_at: artifact.created_at,
        workflow_run: { id: artifact.run_id, head_sha: BASE_RUN_SHA, head_branch: 'main' },
    };
}

interface Scenario {
    source: { kind: 'log' } | { kind: 'target-job'; name: string };
    /** undefined = RUNNER_NAME unset. */
    runnerName?: string;
    listing: ListingRow[] | 'denied';
    baseline: string;
    baselineName?: string;
    /** The base run's artifacts (`auto`, `branch=`), in the order the listing serves them. */
    runArtifacts?: StoredArtifact[];
    /** A `total_count` the base run's listing states over the entries it serves. */
    runTotalCount?: number;
    /** GITHUB_RUN_ATTEMPT; 1 when unset here. */
    attempt?: number;
    /** The repository's artifacts (`artifact=`). */
    repoArtifacts?: StoredArtifact[];
    /** The fake engine writes a report and exits 0; otherwise the run must never reach it. */
    report?: boolean;
}

interface Recorded {
    method: string;
    pathname: string;
    query: Record<string, string>;
}

interface EntryRun {
    requests: Recorded[];
    /** Every artifact name the entry asked the artifact service to create, in order. */
    created: string[];
    downloads: number[];
    stdout: string;
    summary: string;
    engineRan: boolean;
    exitCode: number | null;
}

function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}

function serve(scenario: Scenario, recorded: Recorded[], created: string[], downloads: number[]) {
    const repoPath = `/repos/${OWNER}/${REPO}`;
    return createServer((request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const url = new URL(request.url ?? '/', 'http://stand-in');
            const pathname = decodeURIComponent(url.pathname);
            recorded.push({ method: request.method ?? '', pathname, query: Object.fromEntries(url.searchParams) });
            const body = Buffer.concat(chunks).toString('utf8');

            // The artifact service (ACTIONS_RESULTS_URL), and the blob store its signed URL names.
            if (pathname === '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact') {
                const name = (JSON.parse(body) as { name: string }).name;
                created.push(name);
                const port = (request.socket.address() as AddressInfo).port;
                return json(response, 200, { ok: true, signedUploadUrl: `http://127.0.0.1:${port}/blob/${encodeURIComponent(name)}?sig=stand-in` });
            }
            if (pathname === '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact') {
                return json(response, 200, { ok: true, artifactId: String(created.length) });
            }
            if (pathname.startsWith('/blob/')) {
                response.writeHead(201, { 'x-ms-request-id': 'stand-in', etag: '"stand-in"' });
                response.end();
                return;
            }

            if (pathname === `${repoPath}/actions/runs/${RUN_ID}/jobs`) {
                if (scenario.listing === 'denied') {
                    return json(response, 403, { message: 'Resource not accessible by integration' });
                }
                return json(response, 200, { total_count: scenario.listing.length, jobs: scenario.listing });
            }
            if (pathname === `${repoPath}/actions/runs/${RUN_ID}`) {
                return json(response, 200, { id: RUN_ID, workflow_id: WORKFLOW_ID, path: WORKFLOW_PATH, event: 'pull_request' });
            }
            if (pathname === `${repoPath}/actions/workflows/${WORKFLOW_ID}/runs`) {
                return json(response, 200, {
                    total_count: 1,
                    workflow_runs: [
                        {
                            id: BASE_RUN_ID,
                            head_sha: BASE_RUN_SHA,
                            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${BASE_RUN_ID}`,
                            created_at: '2026-11-14T14:28:00Z',
                        },
                    ],
                });
            }
            // A producing run: this workflow's, and a `pull_request` run, so its graph is not read.
            const producer = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(pathname);
            if (producer) {
                return json(response, 200, {
                    id: Number(producer[1]),
                    workflow_id: WORKFLOW_ID,
                    path: WORKFLOW_PATH,
                    event: 'pull_request',
                    head_sha: BASE_RUN_SHA,
                    run_attempt: 1,
                });
            }
            if (pathname === `${repoPath}/actions/runs/${BASE_RUN_ID}/artifacts`) {
                const name = url.searchParams.get('name');
                const listed = (scenario.runArtifacts ?? []).filter((artifact) => name === null || artifact.name === name);
                return json(response, 200, { total_count: scenario.runTotalCount ?? listed.length, artifacts: listed.map(apiArtifact) });
            }
            if (pathname === `${repoPath}/actions/artifacts`) {
                const name = url.searchParams.get('name');
                const listed = (scenario.repoArtifacts ?? []).filter((artifact) => artifact.name === name);
                return json(response, 200, { total_count: listed.length, artifacts: listed.map(apiArtifact) });
            }
            const zip = /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/(\d+)\/zip$/.exec(pathname);
            if (zip) {
                const id = Number(zip[1]);
                downloads.push(id);
                const stored = [...(scenario.runArtifacts ?? []), ...(scenario.repoArtifacts ?? [])].find((artifact) => artifact.id === id);
                if (stored) {
                    response.writeHead(200, { 'content-type': 'application/zip' });
                    response.end(zipOf(stored));
                    return;
                }
            }
            const log = /^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/.exec(pathname);
            if (log) {
                response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                response.end('2026-11-14T14:29:00.0000000Z compile\n2026-11-14T14:29:01.0000000Z ok\n');
                return;
            }
            if (pathname === `${repoPath}/issues/7/comments`) {
                return request.method === 'POST' ? json(response, 201, { id: 1 }) : json(response, 200, []);
            }
            json(response, 404, { message: 'Not Found' });
        });
    });
}

// A runtime token whose only content the artifact client reads: the backend ids in its scope.
function runtimeToken(): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'none', typ: 'JWT' })}.${part({ scp: 'Actions.Results:run-backend:job-backend' })}.stand-in`;
}

// The report a fake engine writes: one change, nothing significant.
const REPORT = {
    report_version: '1.0.0',
    summary: { total_changes: 1, significant_changes: 0 },
    ranked_changes: [],
    inputs: { baseline: { label: 'base', lines_observed: 2 }, changed: { label: 'head', lines_observed: 2 } },
    markdown: 'one change',
};

async function runEntry(scenario: Scenario): Promise<EntryRun> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tamys-lineage-'));
    const ranMarker = path.join(dir, 'engine-ran');
    const engine = path.join(dir, 'fake-tamys');
    await fsp.writeFile(
        engine,
        [
            `#!${process.execPath}`,
            "const fs = require('fs');",
            'const args = process.argv.slice(2);',
            `fs.writeFileSync(${JSON.stringify(ranMarker)}, '');`,
            scenario.report
                ? `fs.writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(JSON.stringify(REPORT))}); process.exit(0);`
                : 'process.exit(4);',
        ].join('\n'),
    );
    await fsp.chmod(engine, 0o755);
    const log = path.join(dir, 'build.log');
    await fsp.writeFile(log, 'compile\nok\n');
    const eventPath = path.join(dir, 'event.json');
    await fsp.writeFile(
        eventPath,
        JSON.stringify({
            pull_request: { number: 7, base: { ref: 'main', sha: BASE_RUN_SHA }, head: { ref: 'topic', sha: HEAD_SHA } },
            repository: { default_branch: 'main' },
        }),
    );
    const summaryPath = path.join(dir, 'summary.md');
    await fsp.writeFile(summaryPath, '');
    const outputPath = path.join(dir, 'output');
    await fsp.writeFile(outputPath, '');

    const recorded: Recorded[] = [];
    const created: string[] = [];
    const downloads: number[] = [];
    const server = serve(scenario, recorded, created, downloads);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A hermetic environment, built from nothing: no ambient GITHUB_*, ACTIONS_* or proxy leaks in.
    // GITHUB_WORKFLOW_SHA is unset, so the job graph is refused before any request of its own.
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        RUNNER_TEMP: dir,
        GITHUB_API_URL: base,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
        GITHUB_RUN_ID: String(RUN_ID),
        GITHUB_RUN_ATTEMPT: String(scenario.attempt ?? 1),
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: 'refs/pull/7/merge',
        GITHUB_SHA: HEAD_SHA,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
        ACTIONS_RESULTS_URL: `${base}/`,
        ACTIONS_RUNTIME_TOKEN: runtimeToken(),
        'INPUT_GITHUB-TOKEN': 'stand-in-token',
        INPUT_BASELINE: scenario.baseline.replace('{log}', log),
        'INPUT_TAMYS-BINARY': engine,
        'INPUT_BASELINE-MAX-AGE': '',
    };
    if (scenario.runnerName !== undefined) env.RUNNER_NAME = scenario.runnerName;
    if (scenario.baselineName !== undefined) env['INPUT_BASELINE-NAME'] = scenario.baselineName;
    if (scenario.source.kind === 'log') env.INPUT_LOG = log;
    else env['INPUT_TARGET-JOB'] = scenario.source.name;

    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const summary = await fsp.readFile(summaryPath, 'utf8');
    const engineRan = await fsp.access(ranMarker).then(
        () => true,
        () => false,
    );
    await fsp.rm(dir, { recursive: true, force: true });
    return { requests: recorded, created, downloads, stdout, summary, engineRan, exitCode };
}

function warnings(run: EntryRun): string[] {
    return run.stdout.split('\n').filter((line) => line.startsWith('::warning'));
}

function describe(run: EntryRun): string {
    return (
        `\n  created: ${JSON.stringify(run.created)}` +
        `\n  downloads: ${JSON.stringify(run.downloads)}` +
        `\n  engine ran: ${run.engineRan}, exit: ${run.exitCode}` +
        `\n  requests: ${JSON.stringify(run.requests.map((request) => `${request.method} ${request.pathname} ${JSON.stringify(request.query)}`))}` +
        `\n  entry output:\n${run.stdout}` +
        `\n  summary:\n${run.summary}`
    );
}

// ── Arm 1: the derivation, `log:` mode ───────────────────────────────────────────────────────

test('DN-160.O1 arm 1: a log: step with baseline-name unset looks for and seeds the name derived from its own job', async () => {
    const run = await runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: TWO_JOBS, baseline: 'auto' });
    assert.ok(
        run.stdout.includes(`no live \`${BUILD_BASELINE}\` artifact`),
        `the resolver must look for ${BUILD_BASELINE}, the name derived from "${BUILD}"; ` +
            `tamys-baseline-log is the shared constant two jobs collided on${describe(run)}`,
    );
    assert.deepEqual(run.created, [BUILD_BASELINE], `the seed must publish under ${BUILD_BASELINE}${describe(run)}`);
});

// ── Arm 2: an unestablished job ──────────────────────────────────────────────────────────────

const UNESTABLISHED: ReadonlyArray<{ name: string; listing: ListingRow[] | 'denied'; cause: RegExp }> = [
    { name: 'the listing is denied (403)', listing: 'denied', cause: /jobs listing could not be read/ },
    {
        name: 'no row is in progress on this runner',
        listing: [row(1, BUILD, 'in_progress', OTHER_RUNNER), row(2, MANIFEST_LOAD, 'completed', RUNNER)],
        cause: /holds no row not completed on runner/,
    },
    {
        name: 'two rows are in progress on this runner',
        listing: [row(1, BUILD, 'in_progress', RUNNER), row(2, MANIFEST_LOAD, 'in_progress', RUNNER)],
        cause: /holds 2 rows/,
    },
];

for (const cell of UNESTABLISHED) {
    test(`DN-160.O1 arm 2: ${cell.name} — nothing resolved remotely, nothing seeded, one warning naming actions: read`, async () => {
        const run = await runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: cell.listing, baseline: 'auto' });
        const remote = run.requests.filter(
            (request) => request.pathname.includes('/artifacts') || request.pathname.includes(`/workflows/`),
        );
        assert.deepEqual(remote, [], `no remote baseline may be resolved${describe(run)}`);
        assert.deepEqual(run.created, [], `nothing may be uploaded under any name, the constant least of all${describe(run)}`);
        const said = warnings(run);
        assert.equal(said.length, 1, `expected exactly one warning, got ${said.length}${describe(run)}`);
        assert.match(said[0]!, cell.cause, `the warning must name the cause${describe(run)}`);
        assert.match(said[0]!, /actions: read/, `the warning must name the remedy${describe(run)}`);
    });
}

test('DN-160.O1 arm 2: an unestablished job still diffs a path= baseline, and uploads no report artifact', async () => {
    const run = await runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: 'denied', baseline: 'path={log}', report: true });
    assert.ok(run.engineRan, `a path= baseline is unaffected and must still be diffed${describe(run)}`);
    assert.deepEqual(run.created, [], `no report artifact and no seed without a job${describe(run)}`);
});

// ── Arm 3: identity is the rendered name ─────────────────────────────────────────────────────

test('DN-160.O1 arm 3: target-job `build` resolving `ci / build` derives the name over `ci / build`', async () => {
    const run = await runEntry({
        source: { kind: 'target-job', name: 'build' },
        runnerName: RUNNER,
        listing: [row(1, 'ci / build', 'completed', OTHER_RUNNER), row(2, 'tamys', 'in_progress', RUNNER)],
        baseline: 'auto',
    });
    const expected = `tamys-baseline-ci-build-${digest('ci / build', 'auto', '')}`;
    assert.deepEqual(run.created, [expected], `the name is over the rendered "ci / build" and capture "auto"${describe(run)}`);
});

// ── Arm 6: one artifact, the wrong job ──────────────────────────────────────────────────────

test('DN-160.O1 arm 6: under auto, a stored baseline whose sidecar names another job is refused, naming both jobs', async () => {
    const run = await runEntry({
        source: { kind: 'log' },
        runnerName: RUNNER,
        listing: TWO_JOBS,
        baseline: 'auto',
        baselineName: 'shared-name',
        runArtifacts: [
            { id: 14117947216, name: 'shared-name', created_at: '2026-11-14T14:29:01Z', run_id: BASE_RUN_ID, sidecar: sidecar({ job: MANIFEST_LOAD, capture: '' }) },
        ],
        report: true,
    });
    assert.ok(!run.engineRan, `another job's bytes must never be diffed under auto${describe(run)}`);
    assert.deepEqual(run.downloads, [14117947216], `the one candidate is read, so its stamp is what refuses${describe(run)}`);
    const refusal = warnings(run).find((line) => line.includes('shared-name') && line.includes(`run ${BASE_RUN_ID}`));
    assert.ok(refusal, `a warning must name the artifact name and the run${describe(run)}`);
    assert.ok(refusal.includes(MANIFEST_LOAD) && refusal.includes(BUILD), `the refusal names both jobs${describe(run)}`);
    assert.match(refusal, /baseline-name/, `the refusal names the remedy's input${describe(run)}`);
});

// ── Arm 7: the v3.0.0 sidecar ────────────────────────────────────────────────────────────────

test('DN-160.O1 arm 7: a 0.3.0 sidecar with no subject is not compared, and the same run re-seeds the lineage', async () => {
    // An explicit name, as a v3.0.0 user's: the lineage keeps its name across the upgrade, and only
    // its stored sidecar is older than the job record.
    const explicit = 'tamys-baseline-main-ci';
    const run = await runEntry({
        source: { kind: 'log' },
        runnerName: RUNNER,
        listing: TWO_JOBS,
        baseline: 'auto',
        baselineName: explicit,
        runArtifacts: [
            { id: 31, name: explicit, created_at: '2026-11-14T14:29:01Z', run_id: BASE_RUN_ID, sidecar: sidecar(undefined, '0.3.0') },
        ],
        report: true,
    });
    assert.deepEqual(run.downloads, [31], `precondition: the sidecar is what refuses, so it is downloaded${describe(run)}`);
    assert.ok(!run.engineRan, `a baseline that names no job must not be diffed${describe(run)}`);
    assert.ok(
        warnings(run).some((line) => line.includes('recorded no job')),
        `the cold start must say why${describe(run)}`,
    );
    assert.deepEqual(run.created, [explicit], `the same run re-seeds its lineage, under its own name${describe(run)}`);
});

// ── Arm 9: `artifact=`, another job ─────────────────────────────────────────────────────────

test('DN-160.O1 arm 9: under artifact=, another job\'s bytes are diffed and the first line under the header names both jobs', async () => {
    const run = await runEntry({
        source: { kind: 'log' },
        runnerName: RUNNER,
        listing: TWO_JOBS,
        baseline: 'artifact=tamys-baseline-main',
        repoArtifacts: [
            { id: 41, name: 'tamys-baseline-main', created_at: '2026-11-14T14:29:01Z', run_id: BASE_RUN_ID, sidecar: sidecar({ job: MANIFEST_LOAD, capture: '' }) },
        ],
        report: true,
    });
    assert.ok(run.engineRan, `a named baseline is the user's choice and is diffed${describe(run)}`);
    const lines = run.summary.split('\n');
    const header = lines.findIndex((line) => line.startsWith('### ') || line.startsWith('## '));
    const first = lines.slice(header + 1).find((line) => line.trim() !== '');
    assert.ok(
        first?.includes('another job') && first.includes(MANIFEST_LOAD) && first.includes(BUILD),
        `the first line under the header must declare the cross-job pair, naming both jobs; got: ${first}${describe(run)}`,
    );
});

// ── Arm 10: the report's name ───────────────────────────────────────────────────────────────

for (const attempt of [1, 2]) {
    test(`DN-160.O1 arm 10: at attempt ${attempt} the report artifact is tamys-report-<slug>-<digest>-${attempt}, and the footer names it`, async () => {
        const run = await runEntry({
            source: { kind: 'log' },
            runnerName: RUNNER,
            listing: TWO_JOBS,
            baseline: 'auto',
            runArtifacts: [
                { id: 51, name: BUILD_BASELINE, created_at: '2026-11-14T14:29:01Z', run_id: BASE_RUN_ID, sidecar: sidecar({ job: BUILD, capture: '' }) },
            ],
            report: true,
            attempt,
        });
        assert.ok(run.engineRan, `precondition: the job's own baseline is diffed${describe(run)}`);
        assert.deepEqual(
            run.created,
            [buildReport(attempt), BUILD_BASELINE],
            `the report uploads under ${buildReport(attempt)}, then the seed under the attempt-free lineage name${describe(run)}`,
        );
        assert.ok(run.summary.includes(`Full report: [\`${buildReport(attempt)}\` artifact]`), `the footer names the report artifact${describe(run)}`);
    });
}

// ── Arms 4, 4b, 4c, 5: the newest-first walk over one name's entries in one run (DN-160.D4) ──

const SHARED = 'shared-name';

// This step's job in progress on RUNNER, under the rendered name `job`.
function jobOf(job: string): ListingRow[] {
    return [row(1, job, 'in_progress', RUNNER), row(2, job === BUILD ? MANIFEST_LOAD : BUILD, 'in_progress', OTHER_RUNNER)];
}

function stored(id: number, created_at: string, job: string, size?: number, name = SHARED): StoredArtifact {
    return { id, name, created_at, size, run_id: BASE_RUN_ID, sidecar: sidecar({ job, capture: '' }) };
}

// Run 43605060997's two entries, in the order its listing served them: the older smoke artifact first.
const MEASURED_TWO = [
    stored(14117947216, '2026-11-14T14:29:01Z', MANIFEST_LOAD, 359),
    stored(14117927331, '2026-11-14T14:29:22Z', BUILD, 13727),
];

function sharedWarnings(run: EntryRun): string[] {
    return warnings(run).filter((line) => line.includes('is shared'));
}

test('DN-160.O1 arm 4: two jobs under one explicit name each diff their own entry, newest first', async () => {
    const build = await runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: jobOf(BUILD), baseline: 'auto', baselineName: SHARED, runArtifacts: MEASURED_TWO, report: true });
    assert.deepEqual(build.downloads, [14117927331], `build reads only the newest entry, its own${describe(build)}`);
    assert.ok(build.engineRan, `build diffs against its own entry${describe(build)}`);
    assert.deepEqual(sharedWarnings(build), [], `build met no other job's entry first${describe(build)}`);

    const smoke = await runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: jobOf(MANIFEST_LOAD), baseline: 'auto', baselineName: SHARED, runArtifacts: MEASURED_TWO, report: true });
    assert.deepEqual(smoke.downloads, [14117927331, 14117947216], `manifest-load discards build's entry, then reads its own${describe(smoke)}`);
    assert.ok(smoke.engineRan, `manifest-load diffs against its own entry${describe(smoke)}`);
    const said = sharedWarnings(smoke);
    assert.equal(said.length, 1, `exactly one warning names the shared name${describe(smoke)}`);
    assert.ok(said[0]!.includes(BUILD) && said[0]!.includes(MANIFEST_LOAD) && said[0]!.includes('baseline-name'), `it names both jobs and baseline-name${describe(smoke)}`);
});

// Run 43606780330 after manifest-load was re-run: three entries of one name, listed in this order.
const MEASURED_RERUN = [
    stored(14118688882, '2026-11-14T15:18:11Z', MANIFEST_LOAD, 359),
    stored(14118219586, '2026-11-14T14:49:05Z', BUILD, 14001),
    stored(14117724284, '2026-11-14T14:48:42Z', MANIFEST_LOAD, 359),
];

test('DN-160.O1 arm 4b: after a re-run, manifest-load reads one entry and build two; nobody reads the earlier attempt', async () => {
    const smoke = await runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: jobOf(MANIFEST_LOAD), baseline: 'auto', baselineName: SHARED, runArtifacts: MEASURED_RERUN, report: true });
    assert.deepEqual(smoke.downloads, [14118688882], `manifest-load's newest entry is its own latest attempt${describe(smoke)}`);
    assert.ok(smoke.engineRan, `no refusal${describe(smoke)}`);

    const build = await runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: jobOf(BUILD), baseline: 'auto', baselineName: SHARED, runArtifacts: MEASURED_RERUN, report: true });
    assert.deepEqual(build.downloads, [14118688882, 14118219586], `build discards the re-run's entry, then reads its own${describe(build)}`);
    assert.ok(build.engineRan, `no refusal${describe(build)}`);
});

test('DN-160.O1 arm 4b: on a derived name, a re-run is two entries of one lineage — one download, no warning', async () => {
    const run = await runEntry({
        source: { kind: 'log' },
        runnerName: RUNNER,
        listing: TWO_JOBS,
        baseline: 'auto',
        runArtifacts: [
            stored(61, '2026-11-14T14:49:05Z', BUILD, 14001, BUILD_BASELINE),
            stored(62, '2026-11-14T15:18:11Z', BUILD, 14001, BUILD_BASELINE),
        ],
        report: true,
    });
    assert.deepEqual(run.downloads, [62], `the newest attempt's entry is read, and only it${describe(run)}`);
    assert.ok(run.engineRan, `the lineage's own bytes are diffed${describe(run)}`);
    assert.deepEqual(warnings(run), [], `a re-run is not a shared name${describe(run)}`);
});

test('DN-160.O1 arm 4c: five candidates stamped by five other jobs — four downloads, then a refusal naming the count', async () => {
    const run = await runEntry({
        source: { kind: 'log' },
        runnerName: RUNNER,
        listing: TWO_JOBS,
        baseline: 'auto',
        baselineName: SHARED,
        runArtifacts: [1, 2, 3, 4, 5].map((n) => stored(70 + n, `2026-11-14T14:0${n}:00Z`, `other ${n}`)),
        report: true,
    });
    assert.deepEqual(run.downloads, [75, 74, 73, 72], `the walk stops at its ceiling of four, newest first${describe(run)}`);
    assert.ok(!run.engineRan, `no entry is this job's, so nothing is diffed${describe(run)}`);
    const refusal = warnings(run).find((line) => line.includes(SHARED));
    assert.ok(refusal?.includes('5 live artifacts') && refusal.includes('baseline-name'), `the refusal names the count and baseline-name${describe(run)}`);
});

test('DN-160.O1 arm 5: a base-run listing whose total_count exceeds its entries is refused, read by name, before any download', async () => {
    const run = await runEntry({
        source: { kind: 'log' },
        runnerName: RUNNER,
        listing: TWO_JOBS,
        baseline: 'auto',
        runArtifacts: Array.from({ length: 100 }, (_, n) => stored(100 + n, '2026-11-14T14:00:00Z', BUILD, 10, BUILD_BASELINE)),
        runTotalCount: 101,
        report: true,
    });
    const listings = run.requests.filter((request) => request.pathname.endsWith(`/runs/${BASE_RUN_ID}/artifacts`));
    assert.deepEqual(listings.map((request) => request.query.name), [BUILD_BASELINE], `one listing, filtered by the name${describe(run)}`);
    assert.deepEqual(run.downloads, [], `nothing is downloaded from an unestablished candidate set${describe(run)}`);
    assert.ok(!run.engineRan, `refused, a cold start${describe(run)}`);
    assert.ok(warnings(run).some((line) => line.includes('101')), `the refusal states the count${describe(run)}`);
});

// ── Arm 8: `artifact=`, a split newest run ─────────────────────────────────────────────────

const NAMED = 'tamys-baseline-main';

function namedRun(entries: StoredArtifact[]) {
    return runEntry({ source: { kind: 'log' }, runnerName: RUNNER, listing: TWO_JOBS, baseline: `artifact=${NAMED}`, repoArtifacts: entries, report: true });
}

function scanOnly(run: EntryRun): void {
    const listings = run.requests.filter((request) => request.pathname.endsWith('/artifacts'));
    assert.deepEqual(
        listings.map((request) => request.pathname),
        [`/repos/${OWNER}/${REPO}/actions/artifacts`],
        `no listing request beyond the scan's one page${describe(run)}`,
    );
}

test('DN-160.O1 arm 8: artifact= whose newest run holds this job\'s entry beside another\'s uses its own', async () => {
    const run = await namedRun([
        stored(81, '2026-11-14T14:29:22Z', MANIFEST_LOAD, 359, NAMED),
        stored(82, '2026-11-14T14:29:01Z', BUILD, 13727, NAMED),
    ]);
    scanOnly(run);
    assert.deepEqual(run.downloads, [81, 82], `the walk reads the newest, then this job's own${describe(run)}`);
    assert.ok(run.engineRan, `this job's own entry is diffed${describe(run)}`);
    assert.ok(!run.summary.includes('another job'), `an exact pair declares nothing${describe(run)}`);
});

test('DN-160.O1 arm 8: artifact= whose newest run holds two OTHER jobs\' entries is refused as ambiguous', async () => {
    const run = await namedRun([
        stored(83, '2026-11-14T14:29:22Z', MANIFEST_LOAD, 359, NAMED),
        stored(84, '2026-11-14T14:29:01Z', 'lint / lint', 900, NAMED),
    ]);
    scanOnly(run);
    assert.ok(!run.engineRan, `which artifact the user meant cannot be established${describe(run)}`);
    const refusal = warnings(run).find((line) => line.includes(NAMED));
    assert.ok(refusal?.includes(MANIFEST_LOAD) && refusal.includes('lint / lint'), `the refusal names both jobs${describe(run)}`);
});

test('DN-160.O1 arm 8: artifact= whose newest run holds two entries of ONE other job uses the newest, declared', async () => {
    const run = await namedRun([
        stored(85, '2026-11-14T14:29:01Z', MANIFEST_LOAD, 359, NAMED),
        stored(86, '2026-11-14T15:18:11Z', MANIFEST_LOAD, 359, NAMED),
    ]);
    scanOnly(run);
    assert.deepEqual(run.downloads, [86, 85], `both are read, newest first${describe(run)}`);
    assert.ok(run.engineRan, `one other job's newest entry is the user's choice, diffed${describe(run)}`);
    assert.ok(run.summary.includes('Baseline from another job'), `the pair is declared${describe(run)}`);
});
