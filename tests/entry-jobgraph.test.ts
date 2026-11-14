// The job-graph read as the SHIPPED ENTRY performs it (ADR-22.D17, DN-118.O3). jobgraph.test.ts
// executes the coordinate function and the resolver; these arms execute src/main.ts itself, because
// both decisions are taken at the call site and are invisible to the resolver's own tests: WHICH
// commit is read (until 2026-09-27 main.ts took it from the event payload, a PR's `base.sha`, a file
// that did not run), and WHETHER the graph is read at all (at every grain since DN-118.D4's gate on
// `target-job` was withdrawn, arm R5).
//
// The entry runs as a child process against a local stand-in for the REST API (GITHUB_API_URL),
// with a `pull_request` event payload whose `base.sha` differs from the runner's
// GITHUB_WORKFLOW_SHA. The stand-in serves the workflow file per ref, so the graph the engine
// receives says WHICH commit was read, and it serves the run's jobs listing and one job's log, so
// the `target-job` source runs too. The fake engine records its argv and copies the
// `--changed-job-graph` file out, then exits 4: the graph read happens before the engine, and a
// failing engine ends the entry before any comment, summary or artifact surface needs a stand-in of
// its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';

import type { DeclaredJobWire } from '../src/jobgraph.js';
import { BASELINE_META_FILE, CONTEXT_VERSION } from '../src/types.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js');

const OWNER = 'octo';
const REPO = 'demo';
const RUN_ID = 4242;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
// The runner's commit (on `pull_request`, the merge commit it executed) and the PR's base tip.
const EXECUTED_SHA = 'e'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);
// The baseline run an `artifact=` baseline was published by: a `push` run at its own commit, whose
// listing is served at its own attempt.
const BASELINE_RUN_ID = 3131;
const BASELINE_RUN_SHA = 'c'.repeat(40);
const BASELINE_RUN_ATTEMPT = 2;
const BASELINE_ARTIFACT = 'tamys-baseline-main';
// The workflow both runs belong to, as the runs API identifies it.
const WORKFLOW_ID = 77;

// The re-wired aggregator: the base declares `gate` needs `a`; the PR re-wires it to `b`.
const WORKFLOW_AT: Record<string, string> = {
    [BASE_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [a]'].join('\n'),
    [EXECUTED_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [b]'].join('\n'),
    [BASELINE_RUN_SHA]: ['jobs:', '  a:', '    steps:', '      - run: echo baseline-declared', '  b: {}', '  gate:', '    needs: [a]'].join('\n'),
};
// The listing rows as the REST API serves them: each row's identity at its attempt, its steps and
// its runner, which the graph's renderings carry or decide from (DN-140.D2, DN-140.D3).
const LISTING = [
    { id: 101, name: 'a', status: 'completed', conclusion: 'success', run_attempt: 1, steps: [], runner_id: 1, runner_name: 'r1' },
    { id: 102, name: 'b', status: 'completed', conclusion: 'failure', run_attempt: 1, steps: [], runner_id: 2, runner_name: 'r2' },
    { id: 103, name: 'gate', status: 'completed', conclusion: 'failure', run_attempt: 1, steps: [], runner_id: 3, runner_name: 'r3' },
];
// The `target-job` source: the failed member, whose raw log the stand-in serves with the runner's
// timestamp prefix and its one Job marker.
const TARGET_JOB = 'b';
const TARGET_JOB_LOG = [
    '2026-09-27T10:00:00.0000000Z Complete job name: b',
    '2026-09-27T10:00:01.0000000Z compile',
    '2026-09-27T10:00:02.0000000Z error: b failed',
].join('\n');

// The line DN-118.D4's gate printed at `target-job` grain, which its withdrawal removes.
const ONE_JOB_GRAIN_LINE = /no declared job graph — this run diffs one job's log/;

interface RecordedRequest {
    method: string;
    pathname: string;
    ref: string | null;
}

interface EntryRun {
    requests: RecordedRequest[];
    stdout: string;
    graph: DeclaredJobWire[] | null;
    baselineGraph: DeclaredJobWire[] | null;
    /** The engine's argv, or null when the entry never reached the engine. */
    argv: string[] | null;
    exitCode: number | null;
}

// Where the changed log comes from: a file the workflow wrote (`log:`), or one finished job of this
// run (`target-job`).
type Source = 'log' | 'target-job';

interface EntryOptions {
    source: Source;
    /** Where the baseline comes from: a local file (no run), or a named artifact a run published. */
    baseline?: 'path' | 'artifact';
    /** undefined = the variable is UNSET. */
    workflowSha: string | undefined;
}

// The named baseline artifact: the log and a sidecar recording its stack and its job.
function baselineZip(): Buffer {
    const zip = new AdmZip();
    zip.addFile('baseline.log', Buffer.from('compile\nok\n', 'utf8'));
    zip.addFile(
        BASELINE_META_FILE,
        Buffer.from(
            JSON.stringify({
                context_version: CONTEXT_VERSION,
                outcome_token: 'success',
                transport: [],
                // The job the `target-job` source resolves, so the named baseline is this run's own lineage.
                subject: { job: TARGET_JOB, capture: 'auto' },
            }),
            'utf8',
        ),
    );
    return zip.toBuffer();
}

function serve(recorded: RecordedRequest[]) {
    return createServer((request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? '/', 'http://stand-in');
        recorded.push({
            method: request.method ?? '',
            pathname: decodeURIComponent(url.pathname),
            ref: url.searchParams.get('ref'),
        });
        const contentsPrefix = `/repos/${OWNER}/${REPO}/contents/`;
        const pathname = decodeURIComponent(url.pathname);
        if (pathname === `${contentsPrefix}${WORKFLOW_PATH}`) {
            const yaml = WORKFLOW_AT[url.searchParams.get('ref') ?? ''];
            if (yaml !== undefined) {
                response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                response.end(yaml);
                return;
            }
        }
        if (pathname === `/repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}/jobs`) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ total_count: LISTING.length, jobs: LISTING }));
            return;
        }
        if (pathname === `/repos/${OWNER}/${REPO}/actions/artifacts`) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(
                JSON.stringify({
                    total_count: 1,
                    artifacts: [
                        {
                            id: 55,
                            name: BASELINE_ARTIFACT,
                            expired: false,
                            size_in_bytes: 512,
                            created_at: '2026-10-07T08:00:00Z',
                            workflow_run: { id: BASELINE_RUN_ID, head_sha: BASELINE_RUN_SHA, head_branch: 'main' },
                        },
                    ],
                }),
            );
            return;
        }
        if (pathname === `/repos/${OWNER}/${REPO}/actions/artifacts/55/zip`) {
            response.writeHead(200, { 'content-type': 'application/zip' });
            response.end(baselineZip());
            return;
        }
        // This run, which an `artifact=` baseline reads to compare its producing run's workflow
        // (DN-118.D5): the same workflow as the baseline run, so no cross-workflow pair is declared.
        if (pathname === `/repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}`) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ id: RUN_ID, event: 'pull_request', workflow_id: WORKFLOW_ID, path: WORKFLOW_PATH }));
            return;
        }
        if (pathname === `/repos/${OWNER}/${REPO}/actions/runs/${BASELINE_RUN_ID}`) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(
                JSON.stringify({
                    id: BASELINE_RUN_ID,
                    event: 'push',
                    workflow_id: WORKFLOW_ID,
                    path: WORKFLOW_PATH,
                    head_sha: BASELINE_RUN_SHA,
                    run_attempt: BASELINE_RUN_ATTEMPT,
                }),
            );
            return;
        }
        if (pathname === `/repos/${OWNER}/${REPO}/actions/runs/${BASELINE_RUN_ID}/attempts/${BASELINE_RUN_ATTEMPT}/jobs`) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ total_count: LISTING.length, jobs: LISTING }));
            return;
        }
        const target = LISTING.find((job) => job.name === TARGET_JOB)!;
        if (pathname === `/repos/${OWNER}/${REPO}/actions/jobs/${target.id}/logs`) {
            response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(TARGET_JOB_LOG);
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message: 'Not Found' }));
    });
}

// One entry run under a `pull_request` event.
async function runEntry(options: EntryOptions): Promise<EntryRun> {
    const { source, workflowSha } = options;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tamys-entry-'));
    const captured = path.join(dir, 'captured-graph.json');
    const capturedBaseline = path.join(dir, 'captured-baseline-graph.json');
    const capturedArgv = path.join(dir, 'captured-argv.json');
    const engine = path.join(dir, 'fake-tamys');
    await fsp.writeFile(
        engine,
        [
            `#!${process.execPath}`,
            "const args = process.argv.slice(2);",
            `require('fs').writeFileSync(${JSON.stringify(capturedArgv)}, JSON.stringify(args));`,
            "const at = args.indexOf('--changed-job-graph');",
            `if (at >= 0) require('fs').copyFileSync(args[at + 1], ${JSON.stringify(captured)});`,
            "const base = args.indexOf('--baseline-job-graph');",
            `if (base >= 0) require('fs').copyFileSync(args[base + 1], ${JSON.stringify(capturedBaseline)});`,
            'process.exit(4);',
        ].join('\n'),
    );
    await fsp.chmod(engine, 0o755);
    const log = path.join(dir, 'build.log');
    await fsp.writeFile(log, 'compile\nok\n');
    const eventPath = path.join(dir, 'event.json');
    await fsp.writeFile(
        eventPath,
        JSON.stringify({
            pull_request: {
                number: 7,
                base: { ref: 'main', sha: BASE_SHA },
                head: { ref: 'rewire', sha: HEAD_SHA },
            },
            repository: { default_branch: 'main' },
        }),
    );

    const recorded: RecordedRequest[] = [];
    const server = serve(recorded);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // A hermetic environment, built from nothing: no proxy variable and no ambient GITHUB_* can
    // leak in from the shell running the suite.
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        RUNNER_TEMP: dir,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
        GITHUB_RUN_ID: String(RUN_ID),
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: 'refs/pull/7/merge',
        GITHUB_SHA: EXECUTED_SHA,
        GITHUB_WORKFLOW_REF: `${OWNER}/${REPO}/${WORKFLOW_PATH}@refs/pull/7/merge`,
        'INPUT_GITHUB-TOKEN': 'stand-in-token',
        INPUT_BASELINE: options.baseline === 'artifact' ? `artifact=${BASELINE_ARTIFACT}` : `path=${log}`,
        'INPUT_TAMYS-BINARY': engine,
    };
    if (source === 'log') env.INPUT_LOG = log;
    else env['INPUT_TARGET-JOB'] = TARGET_JOB;
    if (workflowSha !== undefined) env.GITHUB_WORKFLOW_SHA = workflowSha;

    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const graph = await readCapture<DeclaredJobWire[]>(captured);
    const baselineGraph = await readCapture<DeclaredJobWire[]>(capturedBaseline);
    const argv = await readCapture<string[]>(capturedArgv);
    await fsp.rm(dir, { recursive: true, force: true });
    return { requests: recorded, stdout, graph, baselineGraph, argv, exitCode };
}

// A file the fake engine wrote, or null when it wrote none.
async function readCapture<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

function contentsReads(run: EntryRun): RecordedRequest[] {
    return run.requests.filter((request) => request.pathname.includes('/contents/'));
}

function jobsListings(run: EntryRun): RecordedRequest[] {
    return run.requests.filter(
        (request) => request.pathname === `/repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}/jobs`,
    );
}

function describeRun(run: EntryRun): string {
    return (
        `\n  requests: ${JSON.stringify(run.requests)}` +
        `\n  graph: ${JSON.stringify(run.graph)}` +
        `\n  engine argv: ${JSON.stringify(run.argv)}` +
        `\n  exit: ${run.exitCode}` +
        `\n  entry output:\n${run.stdout}`
    );
}

// ADR-22.D17 (A1): the runner names the executed file; a payload's `base.sha` never picks the commit.
test('entry (A1): on a pull_request run the ONLY contents read is at GITHUB_WORKFLOW_SHA, never the payload base.sha', async () => {
    const run = await runEntry({ source: 'log', workflowSha: EXECUTED_SHA });
    assert.deepEqual(
        contentsReads(run).map((request) => [request.pathname, request.ref]),
        [[`/repos/${OWNER}/${REPO}/contents/${WORKFLOW_PATH}`, EXECUTED_SHA]],
        `expected exactly one contents read, at the runner's commit ${EXECUTED_SHA}; ` +
            `a read at ${BASE_SHA} is the payload's base.sha${describeRun(run)}`,
    );
});

// ADR-22.D17 (A2): the fold's edge is the one the run executed. The anti-vacuity half — the same
// stand-in read at the base commit yields `a` — lives in jobgraph.test.ts, where the resolver can be
// pointed at either commit directly.
test('entry (A2): a PR that re-wires `needs:` hands the engine the EXECUTED edge (gate → b), not the base edge (gate → a)', async () => {
    const run = await runEntry({ source: 'log', workflowSha: EXECUTED_SHA });
    assert.ok(run.graph, `the engine received no --changed-job-graph${describeRun(run)}`);
    const gate = run.graph.find((job) => job.key === 'gate');
    assert.deepEqual(
        gate?.needs,
        ['b'],
        `gate.needs must be the merge commit's edge ["b"]; ["a"] is the base branch's${describeRun(run)}`,
    );
});

// ADR-22.D17 (A3): no runner commit, no graph — and no substitute commit either.
test('entry (A3): GITHUB_WORKFLOW_SHA unset ⇒ no graph, zero graph requests, one log line naming the variable', async () => {
    const run = await runEntry({ source: 'log', workflowSha: undefined });
    assert.ok(run.argv, `the entry never reached the engine: the run must still diff${describeRun(run)}`);
    assert.ok(
        !run.argv.includes('--changed-job-graph'),
        `the engine must receive no --changed-job-graph without GITHUB_WORKFLOW_SHA${describeRun(run)}`,
    );
    assert.equal(run.graph, null, `the engine must receive no graph flag${describeRun(run)}`);
    assert.deepEqual(contentsReads(run), [], `no contents request may be made${describeRun(run)}`);
    // The one jobs listing is the entry's own, read once per run to name this step's job (DN-160.D2);
    // the refused graph adds none.
    assert.equal(jobsListings(run).length, 1, `exactly one jobs listing, the entry's${describeRun(run)}`);
    const naming = run.stdout.split('\n').filter((line) => line.includes('GITHUB_WORKFLOW_SHA'));
    assert.equal(
        naming.length,
        1,
        `expected exactly one log line naming GITHUB_WORKFLOW_SHA, got ${naming.length}${describeRun(run)}`,
    );
    assert.match(naming[0]!, /no declared job graph/, `the line must say the graph is absent${describeRun(run)}`);
});

// DN-118.O3 (R5), the Action's half: once the pinned engine refuses a fold whose aggregator and
// member claim one row, the graph is read at `target-job` grain too — one contents read, at the
// runner's commit, the one jobs listing the log sourcing also reads (DN-160.D2: read once per run),
// the flag in the argv — and the one-job line is gone. RED at tamys-action a136364, where the gate made zero
// contents reads at this grain. The engine's half (a `New — FAILING` row in a target job the graph
// declares successful takes the job frame) is driven on the pinned engine in tools/preflight.ts.
test('entry (R5): at target-job grain the graph is read once at GITHUB_WORKFLOW_SHA and passes --changed-job-graph', async () => {
    const run = await runEntry({ source: 'target-job', workflowSha: EXECUTED_SHA });
    assert.ok(run.argv, `the entry never reached the engine${describeRun(run)}`);
    assert.deepEqual(
        contentsReads(run).map((request) => [request.pathname, request.ref]),
        [[`/repos/${OWNER}/${REPO}/contents/${WORKFLOW_PATH}`, EXECUTED_SHA]],
        `expected exactly one contents read at target-job grain, at the runner's commit ${EXECUTED_SHA}${describeRun(run)}`,
    );
    assert.equal(
        jobsListings(run).length,
        1,
        `expected one jobs listing, read once and shared by the log sourcing and the graph join${describeRun(run)}`,
    );
    assert.ok(run.argv.includes('--changed-job-graph'), `the engine must receive --changed-job-graph${describeRun(run)}`);
    assert.ok(run.graph, `the engine received no graph file${describeRun(run)}`);
    assert.deepEqual(
        run.graph.filter((job) => job.key === '').map((job) => [job.display, job.conclusion]),
        LISTING.map((row) => [row.name, row.conclusion]),
        `every listed job travels with its declared conclusion${describeRun(run)}`,
    );
    assert.equal(
        run.stdout.split('\n').filter((line) => ONE_JOB_GRAIN_LINE.test(line)).length,
        0,
        `the withdrawn gate's one-job line must not appear${describeRun(run)}`,
    );
});

// DN-140.D4: the entry declares the changed log's provenance from the row it fetched the log by —
// the target job's id and attempt — and a `log:` file declares none.
test('entry (DN-140.D4): target-job declares the fetched job\'s id and attempt; a log: file declares neither', async () => {
    const target = LISTING.find((job) => job.name === TARGET_JOB)!;
    const sourced = await runEntry({ source: 'target-job', workflowSha: EXECUTED_SHA });
    assert.ok(sourced.argv, `the entry never reached the engine${describeRun(sourced)}`);
    const at = sourced.argv.indexOf('--changed-log-job-id');
    assert.deepEqual(
        [sourced.argv[at + 1], sourced.argv[sourced.argv.indexOf('--changed-log-attempt') + 1]],
        [String(target.id), String(target.run_attempt)],
        `the provenance must name job ${target.id} at attempt ${target.run_attempt}${describeRun(sourced)}`,
    );
    const filed = await runEntry({ source: 'log', workflowSha: EXECUTED_SHA });
    assert.ok(filed.argv, `the entry never reached the engine${describeRun(filed)}`);
    assert.ok(
        !filed.argv.some((arg) => arg.startsWith('--changed-log-') || arg.startsWith('--baseline-log-')),
        `a log: file's job and attempt are unknown, so nothing is declared${describeRun(filed)}`,
    );
});

// DN-118.D4 (G2): a `log:` file may carry several jobs' logs, where the fold is correct, so the
// graph is still read, at the runner's commit, and handed to the engine. Anti-vacuity: a gate that
// skipped the read on every grain gives zero reads here, and this arm reds.
test('entry (G2): a log: file still reads the graph once at GITHUB_WORKFLOW_SHA and passes --changed-job-graph', async () => {
    const run = await runEntry({ source: 'log', workflowSha: EXECUTED_SHA });
    assert.ok(run.argv, `the entry never reached the engine${describeRun(run)}`);
    assert.deepEqual(
        contentsReads(run).map((request) => [request.pathname, request.ref]),
        [[`/repos/${OWNER}/${REPO}/contents/${WORKFLOW_PATH}`, EXECUTED_SHA]],
        `expected exactly one contents read, at the runner's commit ${EXECUTED_SHA}${describeRun(run)}`,
    );
    assert.ok(
        run.argv.includes('--changed-job-graph'),
        `the engine must receive --changed-job-graph for a log: file${describeRun(run)}`,
    );
    assert.equal(
        run.stdout.split('\n').filter((line) => ONE_JOB_GRAIN_LINE.test(line)).length,
        0,
        `the one-job grain line must not appear for a log: file${describeRun(run)}`,
    );
});

// DN-89.D34 on the Action path: a baseline published by a run brings that run's own declared graph,
// read after the fact at the commit the run executed and its listing at the run's own attempt, and
// rides as `--baseline-job-graph`. A `path=` baseline names no run, so it brings none and says so.
test('entry (DN-89.D34): an artifact baseline\'s run graph is read at its head_sha and attempt and passed; a path= baseline passes none', async () => {
    const run = await runEntry({ source: 'target-job', workflowSha: EXECUTED_SHA, baseline: 'artifact' });
    assert.ok(run.argv, `the entry never reached the engine${describeRun(run)}`);
    assert.deepEqual(
        contentsReads(run).map((request) => request.ref).sort(),
        [BASELINE_RUN_SHA, EXECUTED_SHA].sort(),
        `one contents read per side, each at its own executed commit${describeRun(run)}`,
    );
    assert.ok(
        run.requests.some((request) => request.pathname === `/repos/${OWNER}/${REPO}/actions/runs/${BASELINE_RUN_ID}/attempts/${BASELINE_RUN_ATTEMPT}/jobs`),
        `the baseline listing must be read at the run's own attempt ${BASELINE_RUN_ATTEMPT}${describeRun(run)}`,
    );
    assert.ok(run.argv.includes('--baseline-job-graph'), `the engine must receive --baseline-job-graph${describeRun(run)}`);
    const declared = run.baselineGraph?.find((job) => job.key === 'a') as { declared_steps?: unknown } | undefined;
    assert.deepEqual(
        declared?.declared_steps,
        [{ run: 'echo baseline-declared' }],
        `the baseline graph is the BASELINE run's declaration, not this run's${describeRun(run)}`,
    );

    const local = await runEntry({ source: 'target-job', workflowSha: EXECUTED_SHA });
    assert.ok(local.argv, `the entry never reached the engine${describeRun(local)}`);
    assert.ok(!local.argv.includes('--baseline-job-graph'), `a path= baseline names no run${describeRun(local)}`);
    assert.equal(
        local.stdout.split('\n').filter((line) => line.includes('no baseline job graph')).length,
        1,
        `the absence is said once${describeRun(local)}`,
    );
});
