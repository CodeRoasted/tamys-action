// Baseline resolution must DEGRADE to a cold start (return null), never throw, when
// the GitHub runs/artifacts API errors. A fork PR gets a READ-ONLY token that 403s on
// these calls (contract § 6); the README promises graceful degradation, so these tests
// hold the code to it — otherwise an unwrapped throw reddens the render/comment job on
// every fork PR instead of falling back to an honest cold start.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ARTIFACT_PAGES, newestNamedArtifact, resolveBaseline, type ResolveParams } from '../src/baseline.js';

// The subject this run diffs, and the lineage it resolves (DN-160.D1): the sidecars below stamp it,
// so the resolution under test is the one a run of this job makes.
const SUBJECT = { job: 'build / build', capture: '' };

function params(octokit: unknown, over: Partial<ResolveParams> = {}): ResolveParams {
    return {
        octokit: octokit as ResolveParams['octokit'],
        owner: 'CodeRoasted',
        repo: 'insight-canon',
        runId: 1,
        spec: { kind: 'auto' },
        contextBranch: 'main',
        lineage: { artifactName: 'tamys-baseline-build-build-0123456789abcdef', subject: SUBJECT },
        workDir: '/tmp',
        ...over,
    };
}

// Calls that must NOT be reached once an earlier call has failed.
const unreached = (): never => {
    throw new Error('resolveBaseline kept calling the API after an earlier failure');
};

// An `artifact=` resolution reads this run and the artifact's producing run to compare their
// workflows (DN-118.D5); here both belong to one workflow, so nothing is declared.
const sameWorkflow = async () => ({ data: { workflow_id: 42, path: '.github/workflows/ci.yml' } });

test('a 403 on the first API call degrades to cold start (null), never throws', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => {
                    throw new Error('HttpError: Resource not accessible by integration (403)');
                },
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit)), null);
});

test('a 403 mid-resolution (runs list) also degrades to cold start, never throws', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 42 } }),
                listWorkflowRuns: async () => {
                    throw new Error('HttpError: 403');
                },
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit)), null);
});

test('no green base run is a normal cold start (null), distinct from an error', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 42 } }),
                listWorkflowRuns: async () => ({ data: { workflow_runs: [], total_count: 0 } }),
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit)), null);
});

// ── Baseline selection grammar + the new sources (user King of the baseline) ─

import { parseBaselineSpec } from '../src/baseline.js';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

test('parseBaselineSpec: the full grammar parses; malformed input THROWS (config error)', () => {
    assert.deepEqual(parseBaselineSpec(''), { kind: 'auto' });
    assert.deepEqual(parseBaselineSpec('auto'), { kind: 'auto' });
    assert.deepEqual(parseBaselineSpec('none'), { kind: 'none' });
    assert.deepEqual(parseBaselineSpec('branch=develop'), { kind: 'branch', branch: 'develop' });
    assert.deepEqual(parseBaselineSpec('artifact=tamys-baseline-main-build'), {
        kind: 'artifact',
        name: 'tamys-baseline-main-build',
    });
    assert.deepEqual(parseBaselineSpec('path=/tmp/base.log'), { kind: 'path', file: '/tmp/base.log' });
    assert.throws(() => parseBaselineSpec('previous-run'));
    assert.throws(() => parseBaselineSpec('artifact='));
    assert.throws(() => parseBaselineSpec('bogus=x'));
});

test('baseline=none: forced cold start, NO API call', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: unreached,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit, { spec: { kind: 'none' } })), null);
});

test('branch=<name>: the run resolver targets the EXPLICIT branch, not the contextual one', async () => {
    let asked = '';
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 42 } }),
                listWorkflowRuns: async (args: { branch: string }) => {
                    asked = args.branch;
                    return { data: { workflow_runs: [], total_count: 0 } };
                },
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(
        await resolveBaseline(params(octokit, { spec: { kind: 'branch', branch: 'release' } })),
        null,
    );
    assert.equal(asked, 'release');
});

// The stack a `target-job` run declares for the bytes it stores (DN-89.D38 §2), and therefore
// what a sidecar published by such a run records.
const JOB_LOG_STACK = ['utf8-bom-line-prefix', 'api-rfc3339-line-prefix'];

// The sidecar the CURRENT Action publishes (DN-89.D38 §4; DN-160.D1, the stored job): its context version, the
// publishing run's native verdict token, the ordered stack the stored bytes were declared under, and
// the subject they are — this run's job.
function recordedSidecar(outcomeToken: string, transport: unknown = JOB_LOG_STACK): Record<string, unknown> {
    return { context_version: '0.4.0', outcome_token: outcomeToken, transport, subject: SUBJECT };
}

// A named-baseline zip the artifact source can inflate: the log under `baseline.log` and, unless
// `sidecar` is 'absent', the stamped provenance sidecar beside it.
function baselineZip(
    content: string | Buffer,
    sidecar: Record<string, unknown> | 'absent' = recordedSidecar(''),
): { data: ArrayBuffer } {
    const zip = new AdmZip();
    zip.addFile('baseline.log', typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    if (sidecar !== 'absent') {
        zip.addFile('tamys-baseline-meta.json', Buffer.from(JSON.stringify(sidecar), 'utf8'));
    }
    // `Buffer.buffer` is `ArrayBufferLike`, so slicing it yields `ArrayBuffer | SharedArrayBuffer`
    // — adm-zip 0.6.0's own types surface that honestly where the 0.5.x DefinitelyTyped stub did
    // not. Copy into a fresh ArrayBuffer instead of asserting the union away: this is the shape
    // octokit's `downloadArtifact` actually returns, and a cast here would hide the one place the
    // test fixture and the production payload could drift apart.
    const buffer = zip.toBuffer();
    return { data: Uint8Array.from(buffer).buffer };
}

test('artifact=<name>: newest live artifact resolves repo-wide; expired + own-run artifacts are skipped', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: sameWorkflow,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async (args: { name: string }) => {
                    assert.equal(args.name, 'tamys-baseline-main-build');
                    return {
                        data: {
                            total_count: 3,
                            artifacts: [
                                // The two skipped entries are newer than the live one: a skip that
                                // did not happen would pick them.
                                { id: 3, expired: false, created_at: '2026-07-03T00:00:00Z', workflow_run: { id: 1 } }, // THIS run — skip
                                { id: 2, expired: true, created_at: '2026-07-02T00:00:00Z', workflow_run: { id: 90 } }, // expired — skip
                                {
                                    id: 1,
                                    expired: false,
                                    created_at: '2026-07-01T00:00:00Z',
                                    workflow_run: { id: 80, head_sha: 'abc1234def', head_branch: 'main' },
                                },
                            ],
                        },
                    };
                },
                downloadArtifact: async (args: { artifact_id: number }) => {
                    assert.equal(args.artifact_id, 1);
                    return baselineZip('hello baseline\n');
                },
            },
        },
    };
    const resolved = await resolveBaseline(
        params(octokit, { spec: { kind: 'artifact', name: 'tamys-baseline-main-build' }, workDir }),
    );
    assert.ok(resolved);
    assert.equal(resolved.meta.kind, 'artifact');
    assert.equal(resolved.meta.label, 'tamys-baseline-main-build');
    assert.equal(resolved.meta.sha, 'abc1234def');
    assert.equal(await fs.readFile(resolved.logPath, 'utf8'), 'hello baseline\n');
    assert.equal(resolved.outcomeToken, '', 'a sidecar recording an empty token resolves with NO token — the ladder falls to the console tail');
});

test('the stamped sidecar rides back: outcome token verbatim, log entry selected past the sidecar', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: sameWorkflow,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async () => ({
                    data: {
                        total_count: 1,
                        artifacts: [
                            {
                                id: 1,
                                expired: false,
                                created_at: '2026-07-01T00:00:00Z',
                                workflow_run: { id: 80, head_sha: 'abc1234def', head_branch: 'main' },
                            },
                        ],
                    },
                }),
                downloadArtifact: async () => baselineZip('stamped baseline\n', recordedSidecar('success')),
            },
        },
    };
    const resolved = await resolveBaseline(
        params(octokit, { spec: { kind: 'artifact', name: 'tamys-baseline-main-build' }, workDir }),
    );
    assert.ok(resolved);
    assert.equal(resolved.outcomeToken, 'success', 'the native token must ride back verbatim');
    assert.equal(
        await fs.readFile(resolved.logPath, 'utf8'),
        'stamped baseline\n',
        'the LOG entry must be selected, never the sidecar',
    );
});

// DN-118.D5 (ROADMAP N365): a job's reusable-call prefix is its identity, so a baseline produced
// by ANOTHER workflow is never paired across by the engine; the resolver records both workflow
// files so the report can declare it. The producing run and this run are each read once, and the
// comparison is by `workflow_id`, never by a name.
function crossWorkflowOctokit(producerWorkflowId: number, producerPath: string): unknown {
    const runs: Record<number, { workflow_id: number; path: string }> = {
        1: { workflow_id: 42, path: '.github/workflows/release.yaml' }, // THIS run
        80: { workflow_id: producerWorkflowId, path: producerPath }, // the artifact's producing run
    };
    return {
        rest: {
            actions: {
                getWorkflowRun: async (args: { run_id: number }) => {
                    const run = runs[args.run_id];
                    assert.ok(run, `getWorkflowRun asked for run ${args.run_id}, neither this run nor the producer`);
                    return { data: run };
                },
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async () => ({
                    data: {
                        total_count: 1,
                        artifacts: [
                            {
                                id: 1,
                                expired: false,
                                created_at: '2026-07-01T00:00:00Z',
                                workflow_run: { id: 80, head_sha: 'abc1234def', head_branch: 'main' },
                            },
                        ],
                    },
                }),
                downloadArtifact: async () => baselineZip('baseline\n'),
            },
        },
    };
}

test('artifact=<name>: a producing run of ANOTHER workflow is recorded, naming both workflow files', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const resolved = await resolveBaseline(
        params(crossWorkflowOctokit(7, '.github/workflows/ci.yml'), {
            spec: { kind: 'artifact', name: 'tamys-baseline-main-build' },
            workDir,
        }),
    );
    assert.ok(resolved);
    assert.deepEqual(resolved.meta.cross_workflow, {
        baseline: '.github/workflows/ci.yml',
        changed: '.github/workflows/release.yaml',
    });
});

test('artifact=<name>: a producing run of THIS workflow records nothing', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const resolved = await resolveBaseline(
        params(crossWorkflowOctokit(42, '.github/workflows/release.yaml'), {
            spec: { kind: 'artifact', name: 'tamys-baseline-main-build' },
            workDir,
        }),
    );
    assert.ok(resolved);
    assert.equal(resolved.meta.cross_workflow, undefined);
});

test('artifact=<name>: a producing run whose workflow cannot be read is a cold start, never an undeclared diff', async () => {
    const octokit = crossWorkflowOctokit(7, '.github/workflows/ci.yml') as {
        rest: { actions: Record<string, unknown> };
    };
    octokit.rest.actions['getWorkflowRun'] = async () => {
        throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    };
    octokit.rest.actions['downloadArtifact'] = unreached;
    assert.equal(
        await resolveBaseline(params(octokit, { spec: { kind: 'artifact', name: 'tamys-baseline-main-build' } })),
        null,
    );
});

test('artifact=<name>: no live artifact is a normal cold start (null)', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: unreached,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async () => ({ data: { total_count: 0, artifacts: [] } }),
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(
        await resolveBaseline(params(octokit, { spec: { kind: 'artifact', name: 'x' } })),
        null,
    );
});

test('path=<file>: local baseline resolves with path provenance; a MISSING file throws (config error)', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const file = path.join(workDir, 'my-baseline.log');
    await fs.writeFile(file, 'local\n');
    const octokit = { rest: { actions: {} } };
    const resolved = await resolveBaseline(
        params(octokit, { spec: { kind: 'path', file }, workDir }),
    );
    assert.ok(resolved);
    assert.equal(resolved.meta.kind, 'path');
    assert.equal(resolved.meta.label, file);
    assert.equal(resolved.outcomeToken, '', 'a local file carries no provenance sidecar');
    // DN-89.D38 §4: the Action does not know how a local file was delivered, so its side stays
    // UNDECLARED and the engine deduces it — never `none`, which would be a declaration.
    assert.equal(resolved.transport, undefined, 'a `path=` baseline must leave its transport undeclared');
    assert.equal(await fs.readFile(resolved.logPath, 'utf8'), 'local\n');

    await assert.rejects(
        resolveBaseline(params(octokit, { spec: { kind: 'path', file: path.join(workDir, 'absent.log') }, workDir })),
    );
});

// ── The staleness bound (baseline-max-age) ──────────────────────────────────
// The bound exists because the green-gated re-seed has no upper age limit: over
// a red streak the baseline ages silently. Parsing is strict (config error) and
// an unknown age is NULL, never 0 — 0 would read as "fresh", the silent
// degradation the bound exists to kill.

import { baselineAgeHours, parseMaxAgeHours } from '../src/baseline.js';

test('parseMaxAgeHours: h/d grammar parses to hours; empty = no bound (null)', () => {
    assert.equal(parseMaxAgeHours(''), null);
    assert.equal(parseMaxAgeHours('  '), null);
    assert.equal(parseMaxAgeHours('72h'), 72);
    assert.equal(parseMaxAgeHours('7d'), 168);
    assert.equal(parseMaxAgeHours('1H'), 1); // case-insensitive
});

test('parseMaxAgeHours: malformed or non-positive input THROWS (config error, never silent unbounded)', () => {
    assert.throws(() => parseMaxAgeHours('72'), /baseline-max-age/);
    assert.throws(() => parseMaxAgeHours('3w'), /baseline-max-age/);
    assert.throws(() => parseMaxAgeHours('h'), /baseline-max-age/);
    assert.throws(() => parseMaxAgeHours('-2h'), /baseline-max-age/);
    assert.throws(() => parseMaxAgeHours('0d'), /must be positive/);
});

test('baselineAgeHours: whole floored hours from created_at; unknown stamp is NULL, never 0', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    assert.equal(baselineAgeHours('2026-07-22T12:00:00Z', now), 120); // the measured 5-day instance
    assert.equal(baselineAgeHours('2026-07-27T11:01:00Z', now), 0);   // 59 min floors to 0
    assert.equal(baselineAgeHours('', now), null);
    assert.equal(baselineAgeHours('not-a-date', now), null);
    assert.equal(baselineAgeHours('2026-07-27T13:00:00Z', now), 0, 'clock skew clamps to 0, never negative');
});

// ── The baseline artifact's SIZE BOUNDS (GHSA: adm-zip <0.6.0, "crafted ZIP file
// triggers 4GB memory allocation") ────────────────────────────────────────────────
//
// The baseline is a REPOSITORY ARTIFACT and artifacts are uploaded by workflow runs —
// this Action's own documented pattern has a build job upload it. Where a consumer lets a
// fork-triggered run publish under that name, those bytes are contributor-controlled and
// reach the zip parser. These arms hold the three bounds to REJECTING; a bound that has
// never rejected anything is decoration.
//
// Each must degrade to an honest cold start (null), never throw — the same contract the
// 403 arms above enforce — and each rejects at a DIFFERENT stage, so a single bound
// cannot satisfy all three.

const bigRun = {
    rest: {
        actions: {
            getWorkflowRun: async () => ({ data: { workflow_id: 7 } }),
            listWorkflowRuns: async () => ({
                data: {
                    total_count: 1,
                    workflow_runs: [
                        { id: 42, head_sha: 'abc', html_url: 'u', created_at: '2026-01-01T00:00:00Z' },
                    ],
                },
            }),
        },
    },
};

function octokitWith(artifact: Record<string, unknown>, download: () => Promise<unknown>): unknown {
    return {
        rest: {
            actions: {
                ...bigRun.rest.actions,
                listWorkflowRunArtifacts: async () => ({ data: { artifacts: [artifact] } }),
                downloadArtifact: download,
            },
        },
    };
}

const liveArtifact = (over: Record<string, unknown> = {}) => ({
    id: 9,
    name: 'tamys-baseline-build-build-0123456789abcdef',
    expired: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
});

test('BOUND 1: an oversized artifact is refused on METADATA — the bytes never transfer', async () => {
    const octokit = octokitWith(
        liveArtifact({ size_in_bytes: 64 * 1024 * 1024 }),
        // Reaching the download at all means the pre-download gate did not fire.
        async () => {
            throw new Error('downloadArtifact was called despite the pre-download size gate');
        },
    );
    assert.equal(await resolveBaseline(params(octokit)), null);
});

test('BOUND 2: oversized DOWNLOADED bytes are refused before the parser sees them', async () => {
    // `size_in_bytes` absent — the metadata gate cannot fire, which is exactly why this
    // second bound exists rather than being redundant with the first.
    const octokit = octokitWith(liveArtifact(), async () => ({
        data: new ArrayBuffer(33 * 1024 * 1024),
    }));
    assert.equal(await resolveBaseline(params(octokit)), null);
});

test('BOUND 1/2 admit a normal artifact — the caps do not reject everything (can-PASS)', async () => {
    // A tiny buffer that is NOT a valid zip: it clears both size bounds and then fails in
    // the parser. Proves the rejections above came from the SIZE gates, not from every
    // input being refused — without this, all three arms would pass on a broken gate.
    let parsed = false;
    const octokit = octokitWith(liveArtifact({ size_in_bytes: 128 }), async () => {
        parsed = true;
        return { data: new ArrayBuffer(128) };
    });
    assert.equal(await resolveBaseline(params(octokit)), null);
    assert.ok(parsed, 'a within-bounds artifact must reach the download/parse stage');
});

// ── Which green run is the baseline (the runs endpoint documents NO ordering) ──
//
// `listWorkflowRuns` takes no sort parameter and its documentation promises no order, so
// "the last green run" is a property the Action must ESTABLISH, never read off position 0.
// These arms hand the resolver pages in an order GitHub does not use today — the failure
// is silent when it fires (a confident diff against the wrong run), so only a reordered
// fixture can see it. The run the resolver picked is read back from `meta.run_id`.

interface StubRun {
    id: number;
    created_at: string;
    head_sha?: string;
    html_url?: string;
}

const green = (id: number, createdAt: string): StubRun => ({
    id,
    created_at: createdAt,
    head_sha: `sha${id}`,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
});

// Serves `pages` in order, one per `listWorkflowRuns` call, and records every call's
// arguments; downloads resolve for any run so the picked id is observable end to end.
function runsOctokit(pages: { workflow_runs: StubRun[]; total_count: number }[]) {
    const calls: Record<string, unknown>[] = [];
    const artifactRuns: number[] = [];
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 42 } }),
                listWorkflowRuns: async (args: Record<string, unknown>) => {
                    calls.push(args);
                    const page = pages[calls.length - 1];
                    if (!page) throw new Error(`listWorkflowRuns called ${calls.length} times, stub serves ${pages.length}`);
                    return { data: page };
                },
                listWorkflowRunArtifacts: async (args: { run_id: number }) => {
                    artifactRuns.push(args.run_id);
                    return { data: { artifacts: [liveArtifact()] } };
                },
                downloadArtifact: async () => baselineZip('green baseline\n'),
            },
        },
    };
    return { octokit, calls, artifactRuns };
}

test('a REORDERED page still resolves the newest green run by creation, not position 0', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const { octokit, calls } = runsOctokit([
        {
            total_count: 3,
            workflow_runs: [
                green(500, '2026-09-20T08:00:00Z'), // oldest, served first
                green(900, '2026-09-26T08:00:00Z'), // newest, served in the middle
                green(700, '2026-09-23T08:00:00Z'),
            ],
        },
    ]);
    const resolved = await resolveBaseline(params(octokit, { workDir }));
    assert.ok(resolved, 'three green runs exist — a cold start here is a defect');
    assert.equal(
        resolved.meta.run_id,
        '900',
        `picked run ${resolved.meta.run_id}; the newest green run by created_at is 900 ` +
            '(a pick of 500 is position 0 of the page — the unordered-endpoint defect)',
    );
    assert.equal(calls.length, 1, `a page holding every green run needs no second call, made ${calls.length}`);
    assert.equal(calls[0]?.status, 'success');
    assert.equal(calls[0]?.per_page, 100, `asked per_page=${String(calls[0]?.per_page)}; one run cannot be re-sorted`);
});

test('equal created_at stamps break on the run id, so the pick is deterministic', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const { octokit } = runsOctokit([
        {
            total_count: 2,
            workflow_runs: [green(801, '2026-09-26T08:00:00Z'), green(802, '2026-09-26T08:00:00Z')],
        },
    ]);
    const resolved = await resolveBaseline(params(octokit, { workDir }));
    assert.ok(resolved);
    assert.equal(resolved.meta.run_id, '802', `picked ${resolved.meta.run_id}, expected the higher id 802`);
});

test('this very run is never its own baseline, whatever its position and stamp', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const { octokit } = runsOctokit([
        {
            total_count: 2,
            workflow_runs: [green(1, '2026-09-27T08:00:00Z'), green(600, '2026-09-25T08:00:00Z')],
        },
    ]);
    const resolved = await resolveBaseline(params(octokit, { workDir, runId: 1 }));
    assert.ok(resolved);
    assert.equal(resolved.meta.run_id, '600', `picked ${resolved.meta.run_id}; run 1 is the current run`);
});

test('more green runs than one page: a created>= window proves the newest, and it is picked', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    // Page 1 is a partial view (total_count 250) whose own newest is 2026-09-24T10:00:00Z; the
    // true newest (run 990) is NOT on it. The window "created >= that stamp" must contain it.
    const { octokit, calls } = runsOctokit([
        {
            total_count: 250,
            workflow_runs: [green(300, '2026-09-10T10:00:00Z'), green(640, '2026-09-24T10:00:00Z')],
        },
        {
            total_count: 3,
            workflow_runs: [
                green(640, '2026-09-24T10:00:00Z'),
                green(990, '2026-09-26T09:30:00Z'),
                green(870, '2026-09-25T10:00:00Z'),
            ],
        },
    ]);
    const resolved = await resolveBaseline(params(octokit, { workDir }));
    assert.ok(resolved);
    assert.equal(resolved.meta.run_id, '990', `picked ${resolved.meta.run_id}, expected 990 from the window`);
    assert.equal(calls.length, 2, `expected page + window (2 calls), made ${calls.length}`);
    assert.equal(
        calls[1]?.created,
        '>=2026-09-24T10:00:00+00:00',
        `window query was ${String(calls[1]?.created)}`,
    );
});

test('a window that is itself incomplete REFUSES (cold start), never guesses a newest', async () => {
    const { octokit, artifactRuns } = runsOctokit([
        { total_count: 250, workflow_runs: [green(640, '2026-09-24T10:00:00Z')] },
        { total_count: 180, workflow_runs: [green(640, '2026-09-24T10:00:00Z'), green(990, '2026-09-26T09:30:00Z')] },
    ]);
    assert.equal(await resolveBaseline(params(octokit)), null);
    assert.deepEqual(artifactRuns, [], `no run may be read as the baseline, read ${artifactRuns.join(',')}`);
});

test('a window that omits the run the page already showed is a contradictory API answer — refused', async () => {
    const { octokit, artifactRuns } = runsOctokit([
        { total_count: 250, workflow_runs: [green(640, '2026-09-24T10:00:00Z')] },
        { total_count: 0, workflow_runs: [] },
    ]);
    assert.equal(await resolveBaseline(params(octokit)), null);
    assert.deepEqual(artifactRuns, [], `no run may be read as the baseline, read ${artifactRuns.join(',')}`);
});

// ── Which named artifact is the baseline (the artifacts endpoint documents NO ordering) ──
//
// `listArtifactsForRepo` takes `name`, `per_page` and `page` and nothing else: no sort, no
// `created` filter, so the green-run window above has no equivalent. The newest live artifact
// of the name is ESTABLISHED by reading every page (100 a page, at most 10 pages) and sorting
// locally by `created_at`, then `id`. Past the ceiling, or when `total_count` moves between
// pages, the resolution refuses to a cold start that names why. The artifact the resolver
// picked is read back from the download it asked for.

interface StubArtifact {
    id: number;
    expired: boolean;
    created_at: string;
    workflow_run: { id: number; head_sha: string; head_branch: string };
}

const named = (id: number, createdAt: string, expired = false): StubArtifact => ({
    id,
    expired,
    created_at: createdAt,
    workflow_run: { id: id + 10_000, head_sha: `sha${id}`, head_branch: 'main' },
});

// Serves `pages[page - 1]` for each call's `page` argument (1-based, as the API numbers them),
// records every call's arguments and every download.
function artifactsOctokit(pages: { total_count: number; artifacts: StubArtifact[] }[]) {
    const calls: Record<string, unknown>[] = [];
    const downloads: number[] = [];
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: sameWorkflow,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async (args: Record<string, unknown>) => {
                    calls.push(args);
                    const page = pages[Number(args.page ?? 1) - 1];
                    if (!page) throw new Error(`page ${String(args.page)} requested, the stub serves ${pages.length}`);
                    return { data: page };
                },
                downloadArtifact: async (args: { artifact_id: number }) => {
                    downloads.push(args.artifact_id);
                    return baselineZip('named baseline\n');
                },
            },
        },
    };
    return { octokit: octokit as unknown as ResolveParams['octokit'], calls, downloads };
}

const namedSpec = { kind: 'artifact', name: 'tamys-baseline-main-build' } as const;

test('artifact=<name>: a page served OLDEST first still resolves the newest live artifact', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const { octokit, calls, downloads } = artifactsOctokit([
        {
            total_count: 3,
            artifacts: [
                named(11, '2026-09-20T08:00:00Z'),
                named(12, '2026-09-23T08:00:00Z'),
                named(13, '2026-09-26T08:00:00Z'),
            ],
        },
    ]);
    const resolved = await resolveBaseline(params(octokit, { spec: namedSpec, workDir }));
    assert.ok(resolved, 'three live artifacts exist — a cold start here is a defect');
    assert.deepEqual(downloads, [13], `downloaded ${downloads.join(',')}; the newest by created_at is 13 (11 is position 0)`);
    assert.equal(resolved.meta.created_at, '2026-09-26T08:00:00Z');
    assert.equal(calls.length, 1, `one page holds every artifact, made ${calls.length} calls`);
    assert.equal(calls[0]?.per_page, 100, `asked per_page=${String(calls[0]?.per_page)}`);
    assert.equal(calls[0]?.name, 'tamys-baseline-main-build');
});

test('artifact=<name>: equal created_at stamps break on the larger id', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const { octokit, downloads } = artifactsOctokit([
        { total_count: 2, artifacts: [named(21, '2026-09-26T08:00:00Z'), named(22, '2026-09-26T08:00:00Z')] },
    ]);
    assert.ok(await resolveBaseline(params(octokit, { spec: namedSpec, workDir })));
    assert.deepEqual(downloads, [22], `downloaded ${downloads.join(',')}, expected the larger id 22`);
});

test('artifact=<name>: 150 artifacts with the newest on page 2 — both pages read, the newest picked', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const pageOne = Array.from({ length: 100 }, (_, i) =>
        named(1_000 + i, `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T08:00:00Z`),
    );
    const pageTwo = Array.from({ length: 50 }, (_, i) =>
        named(2_000 + i, `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T08:00:00Z`),
    );
    pageTwo[17] = named(2_017, '2026-09-26T08:00:00Z');
    pageTwo[18] = named(2_018, '2026-09-27T08:00:00Z', true); // newer, but expired — skipped
    const { octokit, calls, downloads } = artifactsOctokit([
        { total_count: 150, artifacts: pageOne },
        { total_count: 150, artifacts: pageTwo },
    ]);
    const resolved = await resolveBaseline(params(octokit, { spec: namedSpec, workDir }));
    assert.ok(resolved);
    assert.deepEqual(downloads, [2_017], `downloaded ${downloads.join(',')}, expected 2017 from page 2`);
    assert.deepEqual(
        calls.map((call) => call.page),
        [1, 2],
        `pages requested: ${calls.map((call) => String(call.page)).join(',')}`,
    );
});

test('artifact=<name>: 1 001 artifacts is past the 10-page ceiling — refused, cold start, no download', async () => {
    const { octokit, calls, downloads } = artifactsOctokit([
        { total_count: 1_001, artifacts: Array.from({ length: 100 }, (_, i) => named(i + 1, '2026-09-01T08:00:00Z')) },
    ]);
    assert.equal(await resolveBaseline(params(octokit, { spec: namedSpec })), null);
    assert.deepEqual(downloads, [], `no artifact may be read as the baseline, read ${downloads.join(',')}`);
    assert.equal(calls.length, 1, `the ceiling is known from page 1's total_count; made ${calls.length} calls`);
    assert.equal(MAX_ARTIFACT_PAGES, 10);
    const scan = await newestNamedArtifact(artifactsOctokit([{ total_count: 1_001, artifacts: [] }]).octokit, 'o', 'r', 'tamys-baseline-main-build', 1);
    assert.equal(scan.kind, 'refused', `scan was ${scan.kind}`);
    assert.match(
        scan.kind === 'refused' ? scan.reason : '',
        /^1001 artifacts named `tamys-baseline-main-build`; the Action reads at most 1000 to establish the newest\. .*`branch=<name>`$/,
    );
});

test('artifact=<name>: total_count moving between pages is refused, naming both counts', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => named(i + 1, '2026-09-01T08:00:00Z'));
    const { octokit, downloads } = artifactsOctokit([
        { total_count: 150, artifacts: pageOne },
        { total_count: 151, artifacts: [named(500, '2026-09-26T08:00:00Z')] },
    ]);
    assert.equal(await resolveBaseline(params(octokit, { spec: namedSpec })), null);
    assert.deepEqual(downloads, [], `no artifact may be read as the baseline, read ${downloads.join(',')}`);
    const again = artifactsOctokit([
        { total_count: 150, artifacts: pageOne },
        { total_count: 151, artifacts: [named(500, '2026-09-26T08:00:00Z')] },
    ]);
    const scan = await newestNamedArtifact(again.octokit, 'o', 'r', 'n', 1);
    assert.equal(scan.kind === 'refused' ? scan.reason : scan.kind, 'the artifacts named `n` moved while they were read: page 1 counted 150, page 2 counts 151, so the newest cannot be established');
});

test('artifact=<name>: a listing that ends before total_count is refused, never read as complete', async () => {
    const { octokit, downloads } = artifactsOctokit([
        { total_count: 150, artifacts: Array.from({ length: 100 }, (_, i) => named(i + 1, '2026-09-01T08:00:00Z')) },
        { total_count: 150, artifacts: [] },
    ]);
    assert.equal(await resolveBaseline(params(octokit, { spec: namedSpec })), null);
    assert.deepEqual(downloads, []);
    const scan = await newestNamedArtifact(
        artifactsOctokit([
            { total_count: 150, artifacts: Array.from({ length: 100 }, (_, i) => named(i + 1, '2026-09-01T08:00:00Z')) },
            { total_count: 150, artifacts: [] },
        ]).octokit,
        'o',
        'r',
        'n',
        1,
    );
    assert.equal(scan.kind === 'refused' ? scan.reason : scan.kind, 'the listing of `n` ended after 100 of 150 artifacts (page 2 held 0), so the newest cannot be established');
});

test('artifact=<name>: an unparseable created_at on a live artifact is refused, never sorted as oldest', async () => {
    const broken = { ...named(7, 'not-a-date') };
    const { octokit, downloads } = artifactsOctokit([
        { total_count: 2, artifacts: [named(6, '2026-09-01T08:00:00Z'), broken] },
    ]);
    assert.equal(await resolveBaseline(params(octokit, { spec: namedSpec })), null);
    assert.deepEqual(downloads, []);
    const scan = await newestNamedArtifact(octokit, 'o', 'r', 'n', 1);
    assert.equal(scan.kind === 'refused' ? scan.reason : scan.kind, 'artifact 7 named `n` carries an unparseable created_at "not-a-date", so the newest cannot be established');
});

test('artifact=<name>: a SHORT page before total_count is reached is refused — the pages no longer tile', async () => {
    // Page 1 holds 60 of 150: page 2 then starts at entry 101, so entries 61–100 were never read.
    const { octokit, downloads } = artifactsOctokit([
        { total_count: 150, artifacts: Array.from({ length: 60 }, (_, i) => named(i + 1, '2026-09-01T08:00:00Z')) },
        { total_count: 150, artifacts: Array.from({ length: 90 }, (_, i) => named(i + 100, '2026-09-02T08:00:00Z')) },
    ]);
    assert.equal(await resolveBaseline(params(octokit, { spec: namedSpec })), null);
    assert.deepEqual(downloads, []);
    const scan = await newestNamedArtifact(octokit, 'o', 'r', 'n', 1);
    assert.equal(scan.kind === 'refused' ? scan.reason : scan.kind, 'the listing of `n` ended after 60 of 150 artifacts (page 1 held 60), so the newest cannot be established');
});

// ── DN-89.D38 arm A6: the sidecar records the stack its stored bytes were declared under ──────
//
// A stored baseline is the wire bytes of the run that published it, so its sidecar must say how
// those bytes are declared: `transport`, the ordered stack, an empty list for none, with the
// context at 0.3.0. On extraction a recorded stack rides back verbatim and in order, to become
// `--baseline-transport`. A sidecar that recorded no stack is NOT a baseline: the bytes it
// describes were hand-stripped by the old Action, and diffing them against canon-peeled bytes
// would rank the old defect's residue as change. So it is a cold start that names its reason,
// and so is a stack that is not a list of catalogue names, with a reason of its own. Neither
// throws: a refused baseline is reported, never a failed check.

import { publishBaselineLog } from '../src/artifact.js';

// Bytes a decode or a strip would not reproduce: a mark, a stamp, a CRLF and an ill-formed byte.
const STORED_WIRE_BYTES = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('2026-06-21T12:19:42.7928236Z Current runner version\r\n', 'utf8'),
    Buffer.from('2026-06-21T12:19:42.7928236Z compiler said ', 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('\n', 'utf8'),
]);

// Runs `run` while recording every `::warning::` the Action prints; everything written still
// reaches the real stdout.
async function warningsDuring<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
    const original = process.stdout.write;
    const written: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (original as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
        const value = await run();
        return { value, warnings: written.filter((line) => line.startsWith('::warning')) };
    } finally {
        process.stdout.write = original;
    }
}

// One live named artifact whose download serves `zip`, and a record of every download.
function oneArtifactOctokit(zip: () => { data: ArrayBuffer }) {
    const downloads: number[] = [];
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: sameWorkflow,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async () => ({
                    data: { total_count: 1, artifacts: [named(21, '2026-10-01T08:00:00Z')] },
                }),
                downloadArtifact: async (args: { artifact_id: number }) => {
                    downloads.push(args.artifact_id);
                    return zip();
                },
            },
        },
    };
    return { octokit: octokit as unknown as ResolveParams['octokit'], downloads };
}

// DN-160.O1 arm 7's seed half: the sidecar a run publishes is 0.4.0 and names the subject its bytes are.
test('A6 / DN-160.O1 arm 7: a published sidecar records context 0.4.0, the verdict token, the ordered stack and the subject', async () => {
    for (const transport of [JOB_LOG_STACK, []]) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-baseline-publish-'));
        const logPath = path.join(dir, 'changed.log');
        await fs.writeFile(logPath, STORED_WIRE_BYTES);
        const uploads: { name: string; files: Record<string, Buffer> }[] = [];
        const client = {
            uploadArtifact: async (name: string, files: string[], root: string) => {
                const read: Record<string, Buffer> = {};
                for (const file of files) read[path.relative(root, file)] = await fs.readFile(file);
                uploads.push({ name, files: read });
                return { id: 1, size: 0 };
            },
        };
        await publishBaselineLog(logPath, 'success', transport, SUBJECT, 'tamys-baseline-build-build-0123456789abcdef', client);
        assert.equal(uploads.length, 1, `uploads: ${uploads.length}`);
        assert.equal(uploads[0]?.name, 'tamys-baseline-build-build-0123456789abcdef', 'the upload is under the name given');
        const files = uploads[0]?.files ?? {};
        assert.ok(
            files['changed.log']?.equals(STORED_WIRE_BYTES),
            `the stored log must be the bytes the run diffed, byte for byte; got ${files['changed.log']?.toString('hex')}`,
        );
        const sidecar = files['tamys-baseline-meta.json'];
        assert.ok(sidecar, `no sidecar uploaded; files: ${Object.keys(files).join(', ')}`);
        assert.deepEqual(JSON.parse(sidecar.toString('utf8')), {
            context_version: '0.4.0',
            outcome_token: 'success',
            transport,
            subject: { job: 'build / build', capture: '' },
        });
    }
});

test('A6: a recorded stack rides back verbatim and in order, and the stored bytes untouched', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    // Not the canonical order: a stack is ordered, and the Action must not sort or re-derive it.
    const recorded = ['api-rfc3339-line-prefix', 'utf8-bom-line-prefix'];
    const { octokit } = oneArtifactOctokit(() => baselineZip(STORED_WIRE_BYTES, recordedSidecar('success', recorded)));
    const resolved = await resolveBaseline(params(octokit, { spec: namedSpec, workDir }));
    assert.ok(resolved, 'a sidecar recording a stack must resolve');
    assert.deepEqual(resolved.transport, recorded);
    assert.equal(resolved.outcomeToken, 'success');
    assert.ok((await fs.readFile(resolved.logPath)).equals(STORED_WIRE_BYTES), 'the stored bytes were rewritten on extraction');

    const { octokit: none } = oneArtifactOctokit(() => baselineZip('plain\n', recordedSidecar('success', [])));
    const declaredNone = await resolveBaseline(params(none, { spec: namedSpec, workDir }));
    assert.ok(declaredNone, 'an empty stack is a declaration of none, and resolves');
    assert.deepEqual(declaredNone.transport, [], 'an empty recorded stack is none, never undeclared');
});

// A sidecar written before 0.4.0 names no job, so it is not compared, whatever else it records
// (DN-160.D1, the stored job); one that names this job is then held to its transport (DN-89.D38 §4).
const UNRECORDED = /recorded no job/;

const COLD_START_CELLS: ReadonlyArray<{
    name: string;
    sidecar: Record<string, unknown> | 'absent';
    unrecorded: boolean;
}> = [
    {
        name: 'a 0.2.0 sidecar, published before the stack was recorded',
        sidecar: { context_version: '0.2.0', outcome_token: 'success' },
        unrecorded: true,
    },
    { name: 'no sidecar at all', sidecar: 'absent', unrecorded: true },
    {
        name: 'a 0.3.0 sidecar, published before the subject was recorded (DN-160.O1 arm 7)',
        sidecar: { context_version: '0.3.0', outcome_token: 'success', transport: JOB_LOG_STACK },
        unrecorded: true,
    },
    { name: 'a transport that is not a list', sidecar: recordedSidecar('success', 'none'), unrecorded: false },
    {
        name: 'a list holding something other than a name',
        sidecar: recordedSidecar('success', ['api-rfc3339-line-prefix', 7]),
        unrecorded: false,
    },
    {
        name: 'a list naming a row outside the catalogue',
        sidecar: recordedSidecar('success', ['utf8-bom-line-prefix', 'gzip']),
        unrecorded: false,
    },
];

for (const cell of COLD_START_CELLS) {
    test(`A6: ${cell.name} is a cold start with its reason, never a failed check`, async () => {
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
        const { octokit, downloads } = oneArtifactOctokit(() => baselineZip('old baseline\n', cell.sidecar));
        const { value, warnings } = await warningsDuring(() =>
            resolveBaseline(params(octokit, { spec: namedSpec, workDir })),
        );
        assert.deepEqual(downloads, [21], 'precondition: the artifact must be downloaded, so the sidecar is what refuses');
        assert.equal(value, null, `${cell.name} must not resolve as a baseline`);
        const said = warnings.join('');
        if (cell.unrecorded) {
            assert.match(said, UNRECORDED, `the warning must name the missing job; it said: ${said}`);
        } else {
            assert.match(said, /transport/, `the warning must name the malformed stack; it said: ${said}`);
            assert.doesNotMatch(said, /recorded no/, `a malformed stack has its own reason; it said: ${said}`);
        }
    });
}

// ── The age of a run-resolved baseline is the age of its STORED SNAPSHOT ─────────
//
// The age the bound judges is the age of the bytes this run diffs against, and those bytes were
// stored when the artifact was created — not when the run was. A run keeps its `created_at`
// across re-runs, so a run created days ago whose re-run stored a fresh snapshot an hour ago
// would read days old: a false STALE on a fresh baseline. `artifact=<name>` already measures the
// artifact's stamp; the run resolver must measure the same object, or the same bytes carry two
// ages depending on how they were selected. (Measured: insight-eidos run 42366548948 read its
// baseline 212h old from run 40914562578's creation, 2026-10-29T16:44:40Z, while the snapshot it
// diffed, artifact 12920659191, was stored at 18:11:58Z — 210h.)

test("auto/branch: the baseline age stamp is the stored artifact's created_at, not the run's", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const runCreated = '2026-09-20T08:00:00Z';
    const storedAt = '2026-09-24T17:30:00Z'; // a re-run of run 77 stored this snapshot four days later
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 5 } }),
                listWorkflowRuns: async () => ({
                    data: { total_count: 1, workflow_runs: [green(77, runCreated)] },
                }),
                listWorkflowRunArtifacts: async () => ({
                    data: { artifacts: [liveArtifact({ created_at: storedAt })] },
                }),
                downloadArtifact: async () => baselineZip('green baseline\n'),
            },
        },
    };
    const resolved = await resolveBaseline(params(octokit, { workDir }));
    assert.ok(resolved, 'one green run with a live artifact exists — a cold start here is a defect');
    assert.equal(resolved.meta.run_id, '77');
    assert.equal(
        resolved.meta.created_at,
        storedAt,
        `meta.created_at is ${resolved.meta.created_at}; the snapshot diffed was stored at ${storedAt} ` +
            `(the run's own creation, ${runCreated}, would age it by 4 extra days)`,
    );
});

test("auto/branch: an artifact with no created_at stamp yields an UNKNOWN age, never the run's stamp", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-test-'));
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 5 } }),
                listWorkflowRuns: async () => ({
                    data: { total_count: 1, workflow_runs: [green(78, '2026-09-20T08:00:00Z')] },
                }),
                listWorkflowRunArtifacts: async () => ({
                    data: { artifacts: [liveArtifact({ created_at: null })] },
                }),
                downloadArtifact: async () => baselineZip('green baseline\n'),
            },
        },
    };
    const resolved = await resolveBaseline(params(octokit, { workDir }));
    assert.ok(resolved, 'one green run with a live artifact exists — a cold start here is a defect');
    assert.equal(
        resolved.meta.created_at,
        '',
        `meta.created_at is "${resolved.meta.created_at}"; an unstamped snapshot has no known age`,
    );
});

// ── The STALE warning states what the resolver SEARCHED, never an unmeasured cause ──
//
// The warning used to say "No run inside the bound has re-seeded `<name>` (a red streak never
// seeds)" whatever the selector. Under `auto`/`branch=` that is a claim the resolver never
// measured: it reads ONE branch's runs of this workflow. insight-eidos run 42366548948 (a
// candidate dispatched on a tag, so `auto` resolved `main`) printed it while four candidate runs
// had stored `tamys-baseline-log` 32h to 42h earlier, on tag refs the resolver does not read — and
// the reader concluded the baseline was not being updated. The warning names the scope it
// searched and what that scope leaves out.

import { staleBaselineWarning } from '../src/baseline.js';

test('STALE warning, run-resolved: names the run and branch searched, and the refs it does not read', () => {
    const text = staleBaselineWarning(
        { kind: 'run', sha: 'abc', run_id: '40914562578', run_url: 'u', branch: 'main', created_at: 'x', label: 'tamys-baseline-log' },
        210,
        '72h',
    );
    assert.ok(text.startsWith('Tamys: STALE baseline — 210h old, past the 72h bound.'), text);
    assert.ok(text.includes('run 40914562578'), `the resolved run is named: ${text}`);
    assert.ok(text.includes('newest green run of this workflow on `main`'), `the searched scope is named: ${text}`);
    assert.ok(text.includes('`baseline: artifact=tamys-baseline-log`'), `the repo-wide selector is named: ${text}`);
    assert.ok(!text.includes('No run inside the bound'), `the unmeasured repo-wide claim is gone: ${text}`);
});

test('STALE warning, artifact-resolved: the repo-wide claim IS measured there, and it is stated', () => {
    const text = staleBaselineWarning(
        {
            kind: 'artifact',
            sha: 'abc',
            run_id: '9',
            run_url: 'u',
            branch: 'b',
            created_at: 'x',
            label: 'tamys-baseline-main',
        },
        100,
        '72h',
    );
    assert.ok(text.startsWith('Tamys: STALE baseline — 100h old, past the 72h bound.'), text);
    assert.ok(text.includes('newest live `tamys-baseline-main` artifact in the repository'), text);
    assert.ok(text.includes('run 9'), text);
    assert.ok(text.includes('no run has stored a newer one'), text);
});
