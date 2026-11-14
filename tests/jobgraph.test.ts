// The Action-side producer of the ADR-22.D13 wire (jobgraph.ts). These arms pin the pure halves —
// the YAML → declared-jobs parse and the declared ⋈ rendered join — against the contract the
// engine consumes, and the choice of WHICH workflow file is read (ADR-22.D17; the entry-level arms
// are in entry-jobgraph.test.ts). The acquisition rules mirror the crawler's producer (the same wire, a second
// transport), so every refusal here is a contract clause, not a style choice: verbatim `name:`,
// the exactly-one conclusion rule, key-less quoted renderings, the edge gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    epochSeconds,
    executedWorkflowCoordinate,
    joinDeclaredJobs,
    parseWorkflowJobs,
    resolveBaselineJobGraph,
    resolveChangedJobGraph,
    type DeclaredJobWire,
    type ListedJob,
    type RenderedJob,
    type ResolveJobGraphParams,
} from '../src/jobgraph.js';
import { listedRows } from './listing-rows.js';

// ── parseWorkflowJobs — the workflow file's declarations, verbatim ───────────

test('parseWorkflowJobs: keys, verbatim names, and both `needs:` shapes — scalar and sequence, one meaning', () => {
    const jobs = parseWorkflowJobs(
        [
            'name: CI',
            'jobs:',
            '  build:',
            '    name: Build',
            '  gate:',
            '    needs: build',
            '  release:',
            '    needs: [build, gate]',
        ].join('\n'),
    );
    assert.equal(jobs.length, 3, `expected 3 declared jobs, got ${jobs.length}: ${JSON.stringify(jobs)}`);
    assert.deepEqual(jobs[0], { key: 'build', name: 'Build', needs: [], callsWorkflow: false, declaresMatrix: false, steps: [] });
    assert.deepEqual(
        jobs[1],
        { key: 'gate', name: '', needs: ['build'], callsWorkflow: false, declaresMatrix: false, steps: [] },
        'a bare scalar `needs:` is one edge',
    );
    assert.deepEqual(jobs[2], { key: 'release', name: '', needs: ['build', 'gate'], callsWorkflow: false, declaresMatrix: false, steps: [] });
});

test('parseWorkflowJobs: a `${{ }}` name is kept AS WRITTEN — the producer renders no expression', () => {
    // The verbatim name fails the join downstream, deliberately: a job whose rendering the
    // acquirer cannot know stays UNRESOLVED rather than guessed.
    const jobs = parseWorkflowJobs(
        ['jobs:', '  matrixed:', "    name: build ${{ matrix.os }}", '    needs: []'].join('\n'),
    );
    assert.equal(jobs[0]!.name, 'build ${{ matrix.os }}', 'the expression must survive unrendered');
});

test('parseWorkflowJobs: a null-body job is KEPT — its key is a legitimate `needs:` target', () => {
    const jobs = parseWorkflowJobs(['jobs:', '  stub:', '  gate:', '    needs: stub'].join('\n'));
    assert.deepEqual(jobs[0], { key: 'stub', name: '', needs: [], callsWorkflow: false, declaresMatrix: false, steps: [] });
});

test('parseWorkflowJobs: unreadable YAML and a jobs-less file THROW the reason — the caller logs it as ABSENT', () => {
    assert.throws(() => parseWorkflowJobs('a: [unclosed'), /workflow YAML is unreadable/);
    assert.throws(() => parseWorkflowJobs('- a list, not a workflow'), /not a YAML mapping/);
    assert.throws(() => parseWorkflowJobs('name: CI\non: push'), /declares no `jobs:` mapping/);
});

// ── joinDeclaredJobs — the acquirer resolves the mapping, both halves travel ─

const RENDERED_FANOUT: RenderedJob[] = listedRows([
    { name: 'Build', conclusion: 'success' },
    { name: 'Bazel / test linux', conclusion: 'success' },
    { name: 'Bazel / test windows', conclusion: 'failure' },
]);

test('joinDeclaredJobs: the anchor is the `name:` when present, else the key — GitHub\'s own rendering rule', () => {
    const joined = joinDeclaredJobs(
        [
            { key: 'build', name: 'Build', needs: [], callsWorkflow: false, declaresMatrix: false, steps: [] },
            { key: 'bazel', name: 'Bazel', needs: ['build'], callsWorkflow: true, declaresMatrix: false, steps: [] },
        ],
        RENDERED_FANOUT,
    );
    assert.equal(joined[0]!.display, 'Build', 'named job anchors on its name');
    assert.equal(joined[1]!.display, 'Bazel', 'the fan-out prefix still resolves the anchor');
});

test('joinDeclaredJobs: a conclusion is declared for EXACTLY ONE rendered job, or withheld as concluded per rendering', () => {
    // A fan-out has N conclusions and NO caller row; rolling them into one would author a verdict
    // the platform never stated. Withheld is a third state with its reason, never success, and
    // never the empty string DN-89.D26 refuses.
    const joined = joinDeclaredJobs(
        [
            { key: 'build', name: 'Build', needs: [], callsWorkflow: false, declaresMatrix: false, steps: [] },
            { key: 'bazel', name: 'Bazel', needs: ['build'], callsWorkflow: true, declaresMatrix: false, steps: [] },
        ],
        RENDERED_FANOUT,
    );
    assert.equal(joined[0]!.conclusion, 'success', 'rendered exactly once ⇒ that row\'s conclusion IS its conclusion');
    assert.deepEqual(
        joined[1]!.conclusion,
        { withheld: 'concluded_per_rendering' },
        'a fan-out (2 rendered rows) must NOT be rolled into one caller-grain verdict',
    );
});

test('joinDeclaredJobs: rendered NOWHERE ⇒ the anchor still travels, and no conclusion is read (DN-127.D7)', () => {
    const joined = joinDeclaredJobs(
        [{ key: 'ghost', name: 'Ghost', needs: [], callsWorkflow: false, declaresMatrix: false, steps: [] }],
        RENDERED_FANOUT,
    );
    assert.equal(
        joined[0]!.display,
        'Ghost',
        'the engine reaches over every declaration, so an unresolved one still says what it claims',
    );
    assert.deepEqual(joined[0]!.conclusion, { withheld: 'no_rendering' }, 'no rendering ⇒ withheld, with that reason');
});

test('joinDeclaredJobs: every rendered row is QUOTED key-less — a rendering is not referenceable', () => {
    // `key` is what `needs:` references; nothing may declare an edge to a rendering. The quoted
    // rows carry the platform's verdicts at the platform's own grain.
    const joined = joinDeclaredJobs(
        [{ key: 'bazel', name: 'Bazel', needs: [], callsWorkflow: true, declaresMatrix: false, steps: [] }],
        RENDERED_FANOUT,
    );
    const quoted = joined.filter((job) => job.key === '');
    assert.equal(quoted.length, RENDERED_FANOUT.length, 'every rendered row travels in its own right');
    assert.deepEqual(
        quoted.map((job) => [job.display, job.conclusion]),
        RENDERED_FANOUT.map((row) => [row.name, row.conclusion]),
        'quoted rows carry the platform\'s name and NATIVE conclusion, verbatim',
    );
    assert.deepEqual(
        quoted.map((job) => ('job_id' in job ? [job.job_id, job.run_attempt] : null)),
        RENDERED_FANOUT.map((row) => [row.id, row.run_attempt]),
        'each quoted row carries the listing row\'s own job id and attempt (DN-140.D2)',
    );
    assert.ok(
        quoted.every((job) => job.needs.length === 0),
        'a quoted rendering declares no edges — the causal graph stays exactly as big as declared',
    );
});

// ── executedWorkflowCoordinate — the runner names the executed file (ADR-22.D17) ──

const EXECUTED_SHA = 'e'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const WORKFLOW_REF = 'octo/demo/.github/workflows/ci.yml@refs/pull/7/merge';

test('executedWorkflowCoordinate: the path from GITHUB_WORKFLOW_REF, the commit from GITHUB_WORKFLOW_SHA', () => {
    assert.deepEqual(
        executedWorkflowCoordinate({ GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_WORKFLOW_SHA: EXECUTED_SHA }),
        { kind: 'executed', path: '.github/workflows/ci.yml', sha: EXECUTED_SHA },
    );
    assert.deepEqual(
        executedWorkflowCoordinate({
            GITHUB_WORKFLOW_REF: 'CodeRoasted/tamys-action/.github/workflows/ci.yml@refs/heads/main',
            GITHUB_WORKFLOW_SHA: 'A'.repeat(64),
        }),
        { kind: 'executed', path: '.github/workflows/ci.yml', sha: 'A'.repeat(64) },
        'a SHA-256 commit id is a commit id too',
    );
});

// (A4) Each malformed input is refused with a reason naming the variable at fault — never a guess,
// never a substitute.
test('executedWorkflowCoordinate (A4): refuses each malformed input, with a reason naming the variable', () => {
    const cells: ReadonlyArray<{ what: string; ref?: string; sha?: string; reason: RegExp }> = [
        { what: 'a ref with no @refs/ marker', ref: 'not-a-workflow-ref', sha: EXECUTED_SHA, reason: /^GITHUB_WORKFLOW_REF "not-a-workflow-ref" names no workflow path$/ },
        { what: 'a ref naming only owner/repo', ref: 'octo/demo@refs/heads/main', sha: EXECUTED_SHA, reason: /^GITHUB_WORKFLOW_REF "octo\/demo@refs\/heads\/main" names no workflow path$/ },
        { what: 'an empty SHA', ref: WORKFLOW_REF, sha: '', reason: /^GITHUB_WORKFLOW_SHA is absent or empty$/ },
        { what: 'an unset SHA', ref: WORKFLOW_REF, reason: /^GITHUB_WORKFLOW_SHA is absent or empty$/ },
        { what: 'a SHA without a path', sha: EXECUTED_SHA, reason: /^GITHUB_WORKFLOW_REF is absent or empty$/ },
        { what: 'a branch name in the SHA slot', ref: WORKFLOW_REF, sha: 'main', reason: /^GITHUB_WORKFLOW_SHA "main" is not a commit id$/ },
        { what: 'a truncated SHA', ref: WORKFLOW_REF, sha: EXECUTED_SHA.slice(0, 12), reason: /is not a commit id$/ },
        { what: 'neither variable', reason: /^GITHUB_WORKFLOW_REF is absent or empty; GITHUB_WORKFLOW_SHA is absent or empty$/ },
    ];
    for (const cell of cells) {
        const coordinate = executedWorkflowCoordinate({ GITHUB_WORKFLOW_REF: cell.ref, GITHUB_WORKFLOW_SHA: cell.sha });
        assert.equal(coordinate.kind, 'refused', `${cell.what}: expected a refusal, got ${JSON.stringify(coordinate)}`);
        if (coordinate.kind === 'refused') {
            assert.match(coordinate.reason, cell.reason, `${cell.what}: reason was "${coordinate.reason}"`);
        }
    }
});

// ── resolveChangedJobGraph — the read is at the coordinate, and nowhere else ─

// A stand-in for the one REST call the resolver makes, serving the workflow file PER COMMIT and
// recording every call, so an arm can say both what was read and what was not. The run's jobs
// listing is handed in, read once by the entry (DN-160.D2), never read by the resolver itself.
const REWIRED_AT: Record<string, string> = {
    [BASE_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [a]'].join('\n'),
    [EXECUTED_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [b]'].join('\n'),
};
const REWIRED_LISTING = listedRows([
    { name: 'a', conclusion: 'success' },
    { name: 'b', conclusion: 'failure' },
    { name: 'gate', conclusion: 'failure' },
]);

// A workflow that declares no `needs:` edge, and its run's listing: `m` concluded `success`.
const EDGE_FREE_SHA = 'f'.repeat(40);
REWIRED_AT[EDGE_FREE_SHA] = ['jobs:', '  f:', '    name: Build', '  m:', '    name: Merge coverage'].join('\n');
const EDGE_FREE_LISTING = listedRows([
    { name: 'Build', conclusion: 'failure' },
    { name: 'Merge coverage', conclusion: 'success' },
]);

function standIn() {
    const calls: string[] = [];
    const octokit = {
        rest: {
            repos: {
                getContent: async (request: { path: string; ref: string }) => {
                    calls.push(`getContent ${request.path} @ ${request.ref}`);
                    const yaml = REWIRED_AT[request.ref];
                    if (yaml === undefined) throw new Error(`Not Found (${request.ref})`);
                    return { data: yaml };
                },
            },
        },
    };
    return { octokit: octokit as unknown as ResolveJobGraphParams['octokit'], calls };
}

async function resolveAt(sha: string | undefined, listing: unknown[] = REWIRED_LISTING) {
    const { octokit, calls } = standIn();
    const lines: string[] = [];
    const graph = await resolveChangedJobGraph({
        octokit,
        owner: 'octo',
        repo: 'demo',
        listing: { kind: 'listed', jobs: listing as ListedJob[] },
        workflow: executedWorkflowCoordinate({ GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_WORKFLOW_SHA: sha }),
        info: (line) => lines.push(line),
    });
    return { graph, calls, lines };
}

// The members of `aggregator` whose own conclusion is a failure — what a fold of its red can name.
function failedMembers(graph: DeclaredJobWire[], aggregator: string): string[] {
    const byKey = new Map(graph.filter((job) => job.key !== '').map((job) => [job.key, job]));
    return (byKey.get(aggregator)?.needs ?? []).filter((key) => byKey.get(key)?.conclusion === 'failure');
}

test('resolveChangedJobGraph (A1): the only contents read is at the coordinate\'s commit, and the log names it', async () => {
    const { calls, lines } = await resolveAt(EXECUTED_SHA);
    assert.deepEqual(
        calls.filter((call) => call.startsWith('getContent')),
        [`getContent .github/workflows/ci.yml @ ${EXECUTED_SHA}`],
        `expected one read at the runner's commit; calls: ${JSON.stringify(calls)}`,
    );
    assert.ok(
        lines.some((line) => line.includes(`.github/workflows/ci.yml at ${EXECUTED_SHA}`)),
        `a successful read must log its coordinate; log: ${JSON.stringify(lines)}`,
    );
});

test('resolveChangedJobGraph (A2): a re-wired `needs:` folds along the executed edge — and the base graph would have folded differently', async () => {
    const executed = await resolveAt(EXECUTED_SHA);
    assert.ok(executed.graph, `no graph at the executed commit; log: ${JSON.stringify(executed.lines)}`);
    const executedGate = executed.graph.find((job) => job.key === 'gate');
    assert.deepEqual(executedGate?.needs, ['b'], `executed gate: ${JSON.stringify(executedGate)}`);
    assert.deepEqual(failedMembers(executed.graph, 'gate'), ['b'], 'the executed graph lets gate\'s red fold into b');

    // Anti-vacuity: the SAME stand-in, read at the base commit, answers differently — so the arm
    // above can only pass by reading the executed commit.
    const base = await resolveAt(BASE_SHA);
    assert.ok(base.graph, `no graph at the base commit; log: ${JSON.stringify(base.lines)}`);
    const baseGate = base.graph.find((job) => job.key === 'gate');
    assert.deepEqual(baseGate?.needs, ['a'], `base gate: ${JSON.stringify(baseGate)}`);
    assert.deepEqual(
        failedMembers(base.graph, 'gate'),
        [],
        'on the base graph gate\'s red has no failed member: the fold that the executed graph makes would not fire',
    );
});

test('resolveChangedJobGraph (E1): an edge-free workflow\'s jobs carry their declared conclusions — the listing is joined', async () => {
    const { graph, lines } = await resolveAt(EDGE_FREE_SHA, EDGE_FREE_LISTING);
    assert.ok(graph, `no graph for the edge-free workflow; log: ${JSON.stringify(lines)}`);
    // The job the platform concluded `success` reaches the engine WITH that conclusion: the report
    // reads it to state a job's precedence over a failing row. Skipping the listing hands the
    // engine an empty display and no conclusion, which is what this arm exists to refuse.
    const merged = graph.find((job) => job.key === 'm');
    assert.deepEqual(
        merged,
        { key: 'm', display: 'Merge coverage', needs: [], conclusion: 'success', calls_workflow: false, declares_matrix: false, declared_steps: [] },
        `the succeeded job's entry: ${JSON.stringify(merged)}`,
    );
    const built = graph.find((job) => job.key === 'f');
    assert.equal(built?.conclusion, 'failure', `the failed job's entry: ${JSON.stringify(built)}`);
    // A graph with entries and no edge is an ordinary graph: nothing in it can fold.
    assert.ok(
        graph.every((job) => job.needs.length === 0),
        `an edge was minted: ${JSON.stringify(graph)}`,
    );
});

test('resolveChangedJobGraph (A3): no runner commit ⇒ ABSENT, zero requests, one log line naming GITHUB_WORKFLOW_SHA', async () => {
    const { graph, calls, lines } = await resolveAt(undefined);
    assert.equal(graph, null, `expected ABSENT, got ${JSON.stringify(graph)}`);
    assert.deepEqual(calls, [], `no request may be made without the runner's commit; calls: ${JSON.stringify(calls)}`);
    assert.equal(lines.length, 1, `expected exactly one log line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /^Tamys: no declared job graph — GITHUB_WORKFLOW_SHA is absent or empty\./);
});

// DN-160.D2: the listing is read once by the entry and handed in; a listing that could not be read
// leaves the graph ABSENT with its reason, after the workflow file was read at the coordinate.
test('resolveChangedJobGraph: a failed run listing ⇒ ABSENT, one log line naming the listing failure', async () => {
    const { octokit, calls } = standIn();
    const lines: string[] = [];
    const graph = await resolveChangedJobGraph({
        octokit,
        owner: 'octo',
        repo: 'demo',
        listing: { kind: 'failed', error: new Error('Resource not accessible by integration') },
        workflow: executedWorkflowCoordinate({ GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_WORKFLOW_SHA: EXECUTED_SHA }),
        info: (line) => lines.push(line),
    });
    assert.equal(graph, null, `expected ABSENT, got ${JSON.stringify(graph)}`);
    assert.deepEqual(calls, [`getContent .github/workflows/ci.yml @ ${EXECUTED_SHA}`], `calls: ${JSON.stringify(calls)}`);
    assert.equal(
        lines.filter((line) => line === "Tamys: no declared job graph — the run's jobs listing failed (Resource not accessible by integration).").length,
        1,
        `log: ${JSON.stringify(lines)}`,
    );
});

// ── The species travels, and the `<A> / X` containment is the caller's (DN-118.O3) ──

// appwrite/appwrite run 28568090223's shape, constructed: the plain job `checks` stands beside three
// jobs whose own `name:` begins with `Checks / `. `security` and `locale` are plain jobs whose STEPS
// use actions, which makes no job a caller; `dependencies` calls a reusable workflow at JOB level.
// The four rendered names are the committed graph's own (coderoast-corpora `f0d9938`).
const CHECKS_FAMILY_SHA = 'a'.repeat(40);
REWIRED_AT[CHECKS_FAMILY_SHA] = [
    'jobs:',
    '  dependencies:',
    '    name: Checks / Dependencies',
    '    uses: ./.github/workflows/osv-scan.yml',
    '  security:',
    '    name: Checks / Image',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: ./scan_image.sh',
    '  checks:',
    '    name: Checks',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: ./check.sh',
    '  locale:',
    '    name: Checks / Locale',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: ./check_locale.sh',
].join('\n');
const CHECKS_FAMILY_LISTING = listedRows([
    { name: 'Checks', conclusion: 'success' },
    { name: 'Checks / Image', conclusion: 'success' },
    { name: 'Checks / Locale', conclusion: 'success' },
    { name: 'Checks / Dependencies / osv-scan', conclusion: 'success' },
]);

// (R2) A plain job named `Checks / X` is not a rendering of the plain job `Checks`, so `checks`
// carries the one conclusion the platform declared for it. Anti-vacuity, asserted first: the caller
// `dependencies` still reaches `Checks / Dependencies / osv-scan`, the row its called workflow
// renders. Then the wire: `calls_workflow` on every keyed entry, true exactly for the job-level
// `uses:`, and on no keyless entry — the engine refuses either omission or excess (R4).
test('resolveChangedJobGraph (R2): a plain job named `Checks / X` is not a rendering of `Checks`, and only a job-level `uses:` makes a caller', async () => {
    const { graph, lines } = await resolveAt(CHECKS_FAMILY_SHA, CHECKS_FAMILY_LISTING);
    assert.ok(graph, `no graph for the Checks family; log: ${JSON.stringify(lines)}`);
    const keyed = graph.filter((job) => job.key !== '');
    const byKey = new Map(keyed.map((job) => [job.key, job]));

    const dependencies = byKey.get('dependencies');
    assert.equal(
        dependencies?.display,
        'Checks / Dependencies',
        'CONTROL: the caller no longer reaches the row its called workflow renders, so the arm below ' +
            `could pass on a join that matches nothing by prefix: ${JSON.stringify(graph)}`,
    );
    assert.equal(
        byKey.get('checks')?.conclusion,
        'success',
        'the plain job `checks` rendered exactly once, as `Checks`; reading the plain jobs named ' +
            '`Checks / ...` as its renderings withholds the conclusion the platform declared for it: ' +
            JSON.stringify(graph),
    );
    assert.deepEqual(
        keyed,
        [
            { key: 'dependencies', display: 'Checks / Dependencies', needs: [], conclusion: 'success', calls_workflow: true, declares_matrix: false, declared_steps: [] },
            { key: 'security', display: 'Checks / Image', needs: [], conclusion: 'success', calls_workflow: false, declares_matrix: false, declared_steps: [{ uses: 'actions/checkout@v4' }, { run: './scan_image.sh' }] },
            { key: 'checks', display: 'Checks', needs: [], conclusion: 'success', calls_workflow: false, declares_matrix: false, declared_steps: [{ uses: 'actions/checkout@v4' }, { run: './check.sh' }] },
            { key: 'locale', display: 'Checks / Locale', needs: [], conclusion: 'success', calls_workflow: false, declares_matrix: false, declared_steps: [{ uses: 'actions/checkout@v4' }, { run: './check_locale.sh' }] },
        ],
        `every keyed entry carries its species, true exactly for a job-level \`uses:\`: ${JSON.stringify(keyed)}`,
    );
    assert.deepEqual(
        graph.filter((job) => job.key === ''),
        CHECKS_FAMILY_LISTING.map((row) => ({
            key: '',
            display: row.name,
            needs: [],
            conclusion: row.conclusion,
            job_id: row.id,
            run_attempt: 1,
            listed_steps: [],
        })),
        `a quoted rendering carries no species — it is not a declaration: ${JSON.stringify(graph)}`,
    );
});
// on the keyed entry only. The engine cuts a `run:` text's first line; a cut here would be a third
// spelling of the expression delimiters, and this arm reds on one.
test('parseWorkflowJobs / joinDeclaredJobs (DN-89.D34): declared step texts travel verbatim on the keyed entry', () => {
    const yaml = [
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - name: only a name',
        '      - run: |',
        '          BASE_SHA="${{ github.sha }}"',
        '          git diff "$BASE_SHA"',
        '      - run: make test',
    ].join('\n');
    const expected = [
        { uses: 'actions/checkout@v4' },
        { run: 'BASE_SHA="${{ github.sha }}"\ngit diff "$BASE_SHA"\n' },
        { run: 'make test' },
    ];
    const declared = parseWorkflowJobs(yaml);
    assert.deepEqual(declared[0]?.steps, expected);
    const joined = joinDeclaredJobs(declared, listedRows([{ name: 'build', conclusion: 'success' }]));
    assert.deepEqual((joined[0] as { declared_steps?: unknown }).declared_steps, expected, JSON.stringify(joined));
    for (const member of ['declared_steps', 'steps']) {
        assert.ok(!Object.prototype.hasOwnProperty.call(joined[0], 'steps'), 'the keyed list travels as `declared_steps` only');
        assert.ok(!Object.prototype.hasOwnProperty.call(joined[1], member), `a rendering carries no \`${member}\``);
    }
});

// ── DN-89.D26: every conclusion is stated or WITHHELD with its reason, never the empty string ──
//
// The producer half of `W390`: the engine refuses `""`, `null`, an unknown reason and a reason on
// the wrong entry, so each state below is the one the join's own facts decide — one rendering
// copies its token, none is `no_rendering`, two or more `concluded_per_rendering`, and a listing
// row carrying no conclusion (the job had not completed) is `not_concluded`, on the keyed entry
// it is the one rendering of and on its own keyless entry alike. `listing_not_read` is never
// written: a listing that cannot be read makes the graph ABSENT.

test('DN-89.D26: each keyed and keyless conclusion takes the state the join decides, and no entry carries ""', () => {
    const declared = parseWorkflowJobs(
        [
            'jobs:',
            '  once:',
            '    runs-on: ubuntu-latest',
            '  fanned:',
            '    name: Bazel',
            '    uses: ./.github/workflows/bazel.yml',
            '  nowhere:',
            '    runs-on: ubuntu-latest',
            '  running:',
            '    runs-on: ubuntu-latest',
        ].join('\n'),
    );
    const joined = joinDeclaredJobs(
        declared,
        listedRows([
            { name: 'once', conclusion: 'failure' },
            { name: 'Bazel / linux', conclusion: 'success' },
            { name: 'Bazel / windows', conclusion: 'failure' },
            { name: 'running', conclusion: null },
        ]),
    );
    assert.deepEqual(
        joined.map((job) => [job.key, job.display, job.conclusion]),
        [
            ['once', 'once', 'failure'],
            ['fanned', 'Bazel', { withheld: 'concluded_per_rendering' }],
            ['nowhere', 'nowhere', { withheld: 'no_rendering' }],
            ['running', 'running', { withheld: 'not_concluded' }],
            ['', 'once', 'failure'],
            ['', 'Bazel / linux', 'success'],
            ['', 'Bazel / windows', 'failure'],
            ['', 'running', { withheld: 'not_concluded' }],
        ],
        JSON.stringify(joined),
    );
    const wire = JSON.stringify(joined);
    assert.ok(!wire.includes('"conclusion":""'), `the empty string is never a state: ${wire}`);
    assert.ok(!wire.includes('"conclusion":null'), `null is translated, never passed through: ${wire}`);
    assert.ok(!wire.includes('listing_not_read'), `the Action reads the listing or declares no graph: ${wire}`);
});

// ── DN-140.D2 and DN-140.D3: the listing row's identity and the steps it RAN, on the keyless entry ──

const STEPPED_ROW: RenderedJob = {
    id: 81441945730,
    name: 'manylinux2_28-builder:rocm7.1',
    conclusion: 'failure',
    run_attempt: 2,
    steps: [
        { number: 1, name: 'Set up job', conclusion: 'success', started_at: '2026-06-15T14:40:00Z', completed_at: '2026-06-15T14:40:05Z' },
        { number: 3, name: 'Build docker image', conclusion: 'failure', started_at: '2026-06-15T15:11:26Z', completed_at: '2026-06-15T15:30:07Z' },
        // A step the platform has not concluded, with no times, and one whose times carry a
        // fraction and an offset: neither is converted, both are withheld `not_timed`.
        { number: 5, name: 'Post Build docker image', conclusion: null, started_at: null, completed_at: null },
        { number: 6, name: 'Complete job', conclusion: 'success', started_at: '2026-06-15T15:30:44.123Z', completed_at: '2026-06-15T17:30:45+02:00' },
    ],
    runner_id: 17,
    runner_name: 'linux.rocm.gpu',
};

test('DN-140.D2: a rendering carries job_id, run_attempt and every listed step in five members, times as whole epoch seconds', () => {
    const joined = joinDeclaredJobs([], [STEPPED_ROW]);
    assert.deepEqual(
        joined,
        [
            {
                key: '',
                display: 'manylinux2_28-builder:rocm7.1',
                needs: [],
                conclusion: 'failure',
                job_id: 81441945730,
                run_attempt: 2,
                listed_steps: [
                    { number: 1, name: 'Set up job', conclusion: 'success', started_at: 1781534400, completed_at: 1781534405 },
                    { number: 3, name: 'Build docker image', conclusion: 'failure', started_at: 1781536286, completed_at: 1781537407 },
                    {
                        number: 5,
                        name: 'Post Build docker image',
                        conclusion: { withheld: 'not_concluded' },
                        started_at: { withheld: 'not_timed' },
                        completed_at: { withheld: 'not_timed' },
                    },
                    {
                        number: 6,
                        name: 'Complete job',
                        conclusion: 'success',
                        started_at: { withheld: 'not_timed' },
                        completed_at: { withheld: 'not_timed' },
                    },
                ],
            },
        ],
        JSON.stringify(joined),
    );
});

test('DN-140.D3: no steps and no runner writes [], no steps with a runner writes emptied_by_platform, and nothing writes not_acquired', () => {
    const cells: ReadonlyArray<{ what: string; runner_id: number | null; runner_name: string | null; expected: unknown }> = [
        { what: 'no runner at all', runner_id: null, runner_name: null, expected: [] },
        { what: 'runner id 0 and an empty name', runner_id: 0, runner_name: '', expected: [] },
        { what: 'a runner id', runner_id: 9, runner_name: null, expected: { withheld: 'emptied_by_platform' } },
        { what: 'a runner name', runner_id: null, runner_name: 'GitHub Actions 3', expected: { withheld: 'emptied_by_platform' } },
    ];
    for (const cell of cells) {
        const [entry] = joinDeclaredJobs([], [
            { id: 5, name: 'skipped job', conclusion: 'skipped', run_attempt: 1, steps: [], runner_id: cell.runner_id, runner_name: cell.runner_name },
        ]);
        assert.deepEqual(
            entry && 'listed_steps' in entry ? entry.listed_steps : 'no keyless entry',
            cell.expected,
            `${cell.what}: ${JSON.stringify(entry)}`,
        );
    }
    // A row whose `steps` member is absent reads as a row listing none, the same two states.
    const [absent] = joinDeclaredJobs([], [{ id: 6, name: 'no steps member', conclusion: 'success', run_attempt: 1, runner_id: 4, runner_name: 'r' }]);
    assert.deepEqual(absent && 'listed_steps' in absent ? absent.listed_steps : null, { withheld: 'emptied_by_platform' });
    const everything = JSON.stringify(joinDeclaredJobs([], [STEPPED_ROW, ...listedRows([{ name: 'x', conclusion: 'success' }])]));
    assert.ok(!everything.includes('not_acquired'), `a live producer never writes not_acquired: ${everything}`);
});

test('epochSeconds: only `YYYY-MM-DDTHH:MM:SSZ` converts, by integer arithmetic; everything else is null', () => {
    assert.equal(epochSeconds('1970-01-01T00:00:00Z'), 0);
    assert.equal(epochSeconds('2026-06-15T15:30:07Z'), 1781537407);
    assert.equal(epochSeconds('2024-02-29T23:59:59Z'), 1709251199, 'a leap day converts');
    for (const text of [
        '2026-06-15T15:30:07.000Z',
        '2026-06-15T15:30:07+00:00',
        '2026-06-15 15:30:07Z',
        '1969-12-31T23:59:59Z',
        '2026-02-30T00:00:00Z',
        '2026-13-01T00:00:00Z',
        '2026-06-15T24:00:00Z',
        '2026-06-15T15:60:00Z',
        '2026-06-15T15:30:60Z',
        '2026-06-1xT15:30:07Z',
        '',
    ]) {
        assert.equal(epochSeconds(text), null, `"${text}" must not convert`);
    }
});

test('DN-140.D2: a listing row the wire cannot carry makes the graph ABSENT, naming the job — never a wire the engine refuses', async () => {
    const cells: ReadonlyArray<{ what: string; row: Record<string, unknown>; reason: RegExp }> = [
        { what: 'no run attempt', row: { run_attempt: undefined }, reason: /job "Build" carries no run attempt/ },
        { what: 'a zero job id', row: { id: 0 }, reason: /job "Build" carries no job id/ },
        {
            what: 'a repeated step number',
            row: { steps: [{ number: 2, name: 'a', conclusion: 'success' }, { number: 2, name: 'b', conclusion: 'success' }] },
            reason: /job "Build" lists step number 2 after 2/,
        },
        { what: 'a step with no name', row: { steps: [{ number: 1, name: '', conclusion: 'success' }] }, reason: /job "Build" lists step 1 with no name/ },
        {
            what: 'a step completing before it started',
            row: { steps: [{ number: 1, name: 'a', conclusion: 'success', started_at: '2026-06-15T15:30:07Z', completed_at: '2026-06-15T15:30:06Z' }] },
            reason: /job "Build" lists step 1 completing at 2026-06-15T15:30:06Z before it started/,
        },
    ];
    for (const cell of cells) {
        const [row] = listedRows([{ name: 'Build', conclusion: 'failure' }]);
        const { graph, lines } = await resolveAt(EDGE_FREE_SHA, [{ ...row, ...cell.row }, ...listedRows([{ name: 'Merge coverage', conclusion: 'success' }], 2001)]);
        assert.equal(graph, null, `${cell.what}: expected ABSENT, got ${JSON.stringify(graph)}`);
        assert.equal(lines.filter((line) => line.startsWith('Tamys: no declared job graph')).length, 1, `${cell.what}: ${JSON.stringify(lines)}`);
        assert.match(lines[lines.length - 1] ?? '', cell.reason, `${cell.what}: ${JSON.stringify(lines)}`);
    }
});

// ── resolveBaselineJobGraph — the BASELINE run's graph, read after the fact (DN-89.D34) ──────

const BASELINE_RUN_SHA = 'c'.repeat(40);
REWIRED_AT[BASELINE_RUN_SHA] = ['jobs:', '  build:', '    steps:', '      - run: git diff ${{ github.sha }}'].join('\n');

// A stand-in for the three calls the baseline resolver makes: the run object, the workflow file at
// a commit, and the listing at an attempt — each recorded with the coordinate it was asked for.
function baselineStandIn(run: Record<string, unknown> | Error) {
    const calls: string[] = [];
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async (request: { run_id: number }) => {
                    calls.push(`getWorkflowRun ${request.run_id}`);
                    if (run instanceof Error) throw run;
                    return { data: run };
                },
                listJobsForWorkflowRunAttempt: 'listJobsForWorkflowRunAttempt',
            },
            repos: {
                getContent: async (request: { path: string; ref: string }) => {
                    calls.push(`getContent ${request.path} @ ${request.ref}`);
                    const yaml = REWIRED_AT[request.ref];
                    if (yaml === undefined) throw new Error(`Not Found (${request.ref})`);
                    return { data: yaml };
                },
            },
        },
        paginate: async (route: unknown, request: { run_id: number; attempt_number: number }) => {
            calls.push(`paginate ${String(route)} run ${request.run_id} attempt ${request.attempt_number}`);
            return listedRows([{ name: 'build', conclusion: 'success' }]);
        },
    };
    return { octokit: octokit as unknown as ResolveJobGraphParams['octokit'], calls };
}

async function resolveBaselineAt(run: Record<string, unknown> | Error) {
    const { octokit, calls } = baselineStandIn(run);
    const lines: string[] = [];
    const graph = await resolveBaselineJobGraph({ octokit, owner: 'octo', repo: 'demo', baselineRunId: 3131, info: (line) => lines.push(line) });
    return { graph, calls, lines };
}

test('resolveBaselineJobGraph: a push run is read at its own head_sha, and its listing at its own attempt', async () => {
    const { graph, calls, lines } = await resolveBaselineAt({ event: 'push', path: '.github/workflows/ci.yml', head_sha: BASELINE_RUN_SHA, run_attempt: 2 });
    assert.deepEqual(
        calls,
        [
            'getWorkflowRun 3131',
            `getContent .github/workflows/ci.yml @ ${BASELINE_RUN_SHA}`,
            'paginate listJobsForWorkflowRunAttempt run 3131 attempt 2',
        ],
        `calls: ${JSON.stringify(calls)}`,
    );
    assert.ok(graph, `no baseline graph; log: ${JSON.stringify(lines)}`);
    assert.deepEqual(
        (graph[0] as { declared_steps?: unknown }).declared_steps,
        [{ run: 'git diff ${{ github.sha }}' }],
        'the baseline declaration carries its own step texts, verbatim',
    );
    assert.ok(lines.some((line) => line.includes(`at ${BASELINE_RUN_SHA}`) && line.includes('attempt 2')), JSON.stringify(lines));
});

test('resolveBaselineJobGraph: a pull_request run names no executed commit — ABSENT, no file read, the event named', async () => {
    for (const event of ['pull_request', 'pull_request_target', 'repository_dispatch']) {
        const { graph, calls, lines } = await resolveBaselineAt({ event, path: '.github/workflows/ci.yml', head_sha: BASELINE_RUN_SHA, run_attempt: 1 });
        assert.equal(graph, null, `${event}: expected ABSENT`);
        assert.deepEqual(calls, ['getWorkflowRun 3131'], `${event}: no contents read and no listing; calls: ${JSON.stringify(calls)}`);
        assert.equal(lines.length, 1, `${event}: ${JSON.stringify(lines)}`);
        assert.match(lines[0]!, new RegExp(`^Tamys: no baseline job graph — baseline run 3131 is a \`${event}\` run`));
    }
});

test('resolveBaselineJobGraph: an unreadable run, a run naming no file or no attempt, and an unreadable file are each ABSENT with the reason', async () => {
    const cells: ReadonlyArray<{ what: string; run: Record<string, unknown> | Error; reason: RegExp }> = [
        { what: 'the run read fails', run: new Error('Resource not accessible'), reason: /baseline run 3131 could not be read \(Resource not accessible\)/ },
        { what: 'no workflow file', run: { event: 'push', path: '', head_sha: BASELINE_RUN_SHA, run_attempt: 1 }, reason: /names no workflow file/ },
        { what: 'no attempt', run: { event: 'push', path: '.github/workflows/ci.yml', head_sha: BASELINE_RUN_SHA }, reason: /states no attempt/ },
        { what: 'the file is absent at the commit', run: { event: 'push', path: '.github/workflows/ci.yml', head_sha: 'd'.repeat(40), run_attempt: 1 }, reason: /could not read \.github\/workflows\/ci\.yml at d{40}/ },
    ];
    for (const cell of cells) {
        const { graph, lines } = await resolveBaselineAt(cell.run);
        assert.equal(graph, null, `${cell.what}: expected ABSENT`);
        assert.match(lines.join('\n'), cell.reason, `${cell.what}: ${JSON.stringify(lines)}`);
    }
});
