// Preflight: does the argument vector this Action BUILDS actually RUN on the engine it PINS?
//
// The class this exists for: the Action forwards a flag or a value its pinned engine does not
// understand. Three instances so far — `--outcome-vocabulary`, then `--transport none` twice.
// Every gate we owned went green on all three, because they answered "did it ship" (tsc, the
// unit suite, the dist staleness check) and never "will it run". The unit suite CANNOT catch
// this: it asserts the arg vector's CONTENT, and the vector was always exactly what we intended
// — the defect is that the engine on the other side rejects it.
//
// Reuse, not reimplementation. This imports the REAL `tamysArgs` (the vector the Action sends),
// the REAL `resolveTamys` (the pin, via TAMYS_VERSION) and the REAL `engineEnv` (the allowlisted
// child environment). It restates none of them. A preflight that rebuilt the vector by hand
// would be a second copy of the predicate, and a second copy is precisely how a reproduction
// comes to disagree with the thing it reproduces.
//
// Same script in CI and on a developer's machine — `npm run preflight` in both — so the two can
// never drift into checking different things.
//
// Cost, stated: it DOWNLOADS the pinned engine (once per version bump; the resolver caches).
// That is the accepted price for catching this class before the push instead of after.
//
// COVERAGE, declared rather than implied: this drives every flag `tamysArgs` can emit, and the
// narration process's vector, `narrationArgs` under `narrationEnv` (DN-158.D4), with no exempt pair:
// section I runs it on the pinned engine against a loopback https endpoint nothing listens on, so
// the engine takes the flags, fails its one call soft, and spends nothing.
//
// SECOND BOUNDARY, and its history is the reason it is written down. Until 2026-08-10 this file
// drove ONE argument vector, the one with every optional field populated — which took every
// conditional push but exercised every CONDITION in exactly one cell. Measured: mutating
// `tamysArgs` so `--outcome-vocabulary` rides only when BOTH outcome tokens are present — which
// breaks the two single-token cells the Action really sends — left this preflight GREEN.
// The verdict coordinate is now driven in all four cells below, so that specific hole is closed.
//
// THE BOUNDARY THAT REMAINS, stated so the next reader does not re-derive the wrong lesson: the
// widenings cover TWO coordinates — the verdict pair (four cells) and the `--changed-job-graph`
// declaration (three cells, section A′ — the FOURTH instance of this class, named by ADR-22.D13
// before it could become the fifth discovery). The per-side transport (DN-89.D38) is driven in
// four shapes: `none` on both sides (sections A to C), a job-log stack against an undeclared
// `path=` baseline and `none` against a stored job-log stack (section C′, with every catalogue row
// a stored sidecar may record), and the job-log stack on both sides of a pair the real
// acquisition produced (section D). Every other conditional in `tamysArgs` is still exercised in a
// single combination, and a mutation aimed at one of those would still green here.
// This file's sentence is *"the pinned engine ACCEPTS what the Action emits"*;
// `tests/tamys.test.ts`'s is *"the Action emits a PAIRED vector in every cell"*. **Neither subsumes
// the other, and a property provable without the engine belongs in the unit arm, where it is total
// and free.**

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { joinDeclaredJobs, parseWorkflowJobs, type RenderedJob } from '../src/jobgraph.js';
import {
    engineEnv,
    readReport,
    tamysArgs,
    TamysReportUnreadableError,
    type TamysInvocation,
} from '../src/tamys.js';
import { fetchTargetJobLog, JOB_LOG_TRANSPORT, type FetchJobLogParams, type JobRow } from '../src/joblog.js';
import { narrationArgs, narrationEnv } from '../src/narrate.js';
import { TRANSPORT_CATALOGUE } from '../src/types.js';
import { CLAIM_BOUNDARY, ngramRefusalLine } from '../src/frame.js';
import { resolveTamys } from '../src/resolve-tamys.js';
import { TAMYS_VERSION } from '../src/tamys-version.js';

const execFileAsync = promisify(execFile);

// Two logs that differ, so the engine does real work rather than short-circuiting on an
// identical pair. Content is irrelevant to what this proves — the subject is the ARGUMENT
// VECTOR, not the diff.
const BASELINE_LOG = ['Run actions/checkout@v5', 'building target', 'ok: 12 passed', 'done'].join('\n');
const CHANGED_LOG = ['Run actions/checkout@v5', 'building target', 'FAILED: 1 of 12', 'done'].join('\n');

// The four verdict cells the Action can emit. `joblog.ts` knows a side's conclusion only when it
// resolved that run, so a SINGLE-token invocation is not a corner case — it is what ships whenever
// one side's verdict is unknown, and it is the shape a bump makes fatal.
const VERDICT_CELLS: ReadonlyArray<{ name: string; baselineOutcome: string; changedOutcome: string }> = [
    { name: 'no verdict declared', baselineOutcome: '', changedOutcome: '' },
    { name: 'baseline verdict only', baselineOutcome: 'success', changedOutcome: '' },
    { name: 'changed verdict only', baselineOutcome: '', changedOutcome: 'failure' },
    { name: 'both verdicts', baselineOutcome: 'success', changedOutcome: 'failure' },
];

// ── The link between TAMYS_VERSION and the ENGINE CAPABILITY it pins ──────────────────────────
//
// This is the one thing no other instrument here could hold. `tests/tamys.test.ts` proves the
// Action never emits a half-pair; nothing proved what the PINNED ENGINE does when it receives
// one, and that behaviour changes underneath us at a bump.
//
// MEASURED on engine v1.9.2 (2026-08-10): a verdict token with NO `--outcome-vocabulary` was
// accepted, exit 0, output byte-identical to the paired invocation, and NOT ONE WORD of
// diagnostic. That is the silent degradation itself — the same shape cost `tamys-crawl` 60
// critical/high `regression` rows across 63 identical-commit pairs whose ground truth was
// silence.
//
// MEASURED on engine v1.9.3 (2026-08-15, this bump): the half-pair is REFUSED — exit 1, a
// diagnostic naming the missing coordinate and enumerating the composed vocabularies ("error:
// --baseline-outcome / --changed-outcome need --outcome-vocabulary. … the composed vocabularies
// are: \"github\", \"gitlab\", \"jenkins\", \"test_frameworks\""). A usage error, not a SIGABRT:
// the CLI refuses before constructing the config (ADR-22.D13 — fail-closed is a property of the
// OUTCOME, and a CLI has an exit code and must use it). This probe went red on exactly this bump
// and the declaration moved with the pin, which is this constant doing its one job.
//
// So this constant is the pin's other half, and it fails CLOSED: `bump.sh` moves TAMYS_VERSION,
// this stops matching, preflight goes red, and whoever bumps must look at the difference rather
// than remember it. Do not "fix" a red here by editing this value alone — read the engine's new
// behaviour first and confirm it is the one intended.
const PINNED_ENGINE_HALF_PAIR: 'tolerated' | 'fatal' = 'fatal';

// ── The link between TAMYS_VERSION and the OUTPUT CONTRACT the Action checks ──────────────────
//
// `readReport` refuses a report that is not well-formed UTF-8, or whose displayed text carries
// a control byte. Those are guarantees of the ENGINE, so the check is only safe to ship beside
// a pin that keeps them: against an engine that does not, it fails every user whose log holds
// such a byte. `tests/tamys.test.ts` proves the Action refuses a breach; nothing there can prove
// the PINNED engine never commits one. These pairs do, on the engine itself.
//
// MEASURED with the published binaries (2026-09-30): engine v1.10.4 breaches both — the control
// pair reaches a row's summary raw, and the ill-formed byte reaches the report file — and engine
// v1.10.5 honours both. So a pin moved back below 1.10.5 reds here, which is this section's job.
//
// The bytes are BUILT, never typed: a literal control byte in a source file is the hazard under
// test. Each changed log carries a marker the accepted report must show in a displayed field, so
// a pair the engine stopped ranking cannot pass as a contract it kept.
const HOSTILE_MARKER = 'FAILED';
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

function logOf(rows: ReadonlyArray<Uint8Array>): Buffer {
    return Buffer.concat(rows.flatMap((row) => [Buffer.from(row), Buffer.from('\n')]));
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');
const bytes = (...values: number[]): Buffer => Buffer.from(values);

const HOSTILE_BASELINE = logOf([utf8('Run make test'), utf8('building target'), utf8('ok: 12 passed'), utf8('done')]);
const HOSTILE_CELLS: ReadonlyArray<{ name: string; changed: Buffer; shows: string }> = [
    {
        // An SGR escape sequence, SOH, TAB and DEL inside the line the diff ranks.
        name: 'control bytes in a ranked line',
        changed: logOf([
            utf8('Run make test'),
            utf8('building target'),
            Buffer.concat([
                utf8('error: '), bytes(0x1b), utf8(`[31m${HOSTILE_MARKER}`), bytes(0x1b), utf8('[0m stage'),
                bytes(0x01), utf8('one'), bytes(0x09), utf8('of'), bytes(0x7f), utf8(' twelve'),
            ]),
            utf8('done'),
        ]),
        shows: HOSTILE_MARKER,
    },
    {
        // One byte that is not well-formed UTF-8, which the engine replaces with U+FFFD.
        name: 'an ill-formed UTF-8 byte in a ranked line',
        changed: logOf([
            utf8('Run make test'),
            utf8('building target'),
            Buffer.concat([utf8(`error: ${HOSTILE_MARKER} stage `), bytes(0x80), utf8(' of twelve')]),
            utf8('done'),
        ]),
        shows: REPLACEMENT_CHARACTER,
    },
];

// The stack a `log:` file is declared under: none. The prefix-free fixtures above are such files.
const LOG_FILE_TRANSPORT: readonly string[] = [];

// ── DN-89.D38 arm A7: the declared job-log stack really peels, on the PINNED engine ─────────
//
// A stamped job-log pair goes through the REAL acquisition — `fetchTargetJobLog` against a stub
// client serving the bytes the API serves, unparsed — so the bytes written and the stack
// declared are the Action's own, never restated here. The pinned engine must then confront the
// changed side's declaration with its probe and print that the probe AGREES: the anti-vacuity
// half of the ruling, because a declared stack the bytes do not carry peels nothing and says so
// in that same line. A stamp left in a ranked row is the second witness that nothing peeled.
const STAMP = '2026-06-21T12:19:42.7928236Z ';
const STAMP_DATE = '2026-06-21T12:19:42';

function stampedJobLog(failing: boolean): Buffer {
    const lines: Buffer[] = [
        Buffer.concat([bytes(0xef, 0xbb, 0xbf), utf8(`${STAMP}Current runner version: '2.335.1'`)]),
        utf8(`${STAMP}##[group]Run make test`),
        utf8(`${STAMP}##[endgroup]`),
        utf8(`${STAMP}building target`),
        utf8(failing ? `${STAMP}FAILED: 1 of 12` : `${STAMP}ok: 12 passed`),
        utf8(`${STAMP}done`),
    ];
    return logOf(lines);
}

// The one completed job the stub run lists.
const BUILD_ROW: JobRow = { id: 1, name: 'build', status: 'completed', conclusion: 'success' };

// The client the Action talks to, reduced to the one call `fetchTargetJobLog` makes: the job's log
// served as a byte stream when the body is requested unparsed — otherwise decoded as text, the way
// the real client hands back a `text/plain` body.
function servingClient(served: Buffer): FetchJobLogParams['octokit'] {
    const client = {
        rest: {
            actions: {
                downloadJobLogsForWorkflowRun: async (args: { request?: { parseSuccessResponseBody?: boolean } }) => ({
                    data:
                        args.request?.parseSuccessResponseBody === false
                            ? new ReadableStream<Uint8Array>({
                                  start(controller) {
                                      controller.enqueue(new Uint8Array(served));
                                      controller.close();
                                  },
                              })
                            : new TextDecoder('utf-8').decode(served),
                }),
            },
        },
    };
    return client as unknown as FetchJobLogParams['octokit'];
}

async function acquireStamped(failing: boolean): Promise<{ bytes: Uint8Array; transport: readonly string[] }> {
    const out = await fetchTargetJobLog({
        octokit: servingClient(stampedJobLog(failing)),
        owner: 'preflight',
        repo: 'preflight',
        jobs: [BUILD_ROW],
        jobName: 'build',
        capture: 'auto',
    });
    return { bytes: out.bytes, transport: out.transport };
}

// One job's log as the API serves it, named `build`: a passing `make test` step, and — when
// `failingStep` — a `./lint.sh` step closing on GitHub's declared error marker.
function oneJobLog(failingStep: boolean): Buffer {
    return logOf([
        Buffer.concat([bytes(0xef, 0xbb, 0xbf), utf8(`${STAMP}Current runner version: '2.335.1'`)]),
        utf8(`${STAMP}Complete job name: build`),
        utf8(`${STAMP}##[group]Run make test`),
        utf8(`${STAMP}ok: 12 passed`),
        utf8(`${STAMP}##[endgroup]`),
        ...(failingStep
            ? [
                  utf8(`${STAMP}##[group]Run ./lint.sh`),
                  utf8(`${STAMP}linting`),
                  utf8(`${STAMP}##[error]Process completed with exit code 1.`),
                  utf8(`${STAMP}##[endgroup]`),
              ]
            : []),
        utf8(`${STAMP}Post job cleanup.`),
    ]);
}

interface RunResult {
    exitCode: number;
    stderr: string;
    wroteReport: boolean;
    rejected: boolean;
    ranClean: boolean;
}

async function runVector(tamysBin: string, args: readonly string[], outputPath: string): Promise<RunResult> {
    let stderr = '';
    let exitCode = 0;
    try {
        const r = await execFileAsync(tamysBin, [...args], { env: engineEnv(), maxBuffer: 32 * 1024 * 1024 });
        stderr = r.stderr;
    } catch (e) {
        const err = e as { stderr?: string; code?: number; signal?: string };
        stderr = err.stderr ?? '';
        // `code` is absent when the child died on a SIGNAL — which is exactly how the `none`
        // instance presented (SIGABRT). Treating an undefined code as 0 would have greened it.
        exitCode = err.code ?? (err.signal ? 134 : 1);
    }

    // The engine's own rejection vocabulary. It fails CLOSED on an unknown token, which is the
    // behaviour that makes this check possible at all.
    const rejected = /^FATAL:/m.test(stderr) || /unknown|unrecognized/i.test(stderr);
    // tamys exits 2 when --fail-on holds. That is a VERDICT, not a rejection, and the fixture
    // pair is built to trigger it — so 0 and 2 are both healthy here.
    const ranClean = exitCode === 0 || exitCode === 2;

    let wroteReport = true;
    try {
        await access(outputPath);
    } catch {
        wroteReport = false;
    }

    return { exitCode, stderr, wroteReport, rejected, ranClean };
}

async function main(): Promise<void> {
    const work = await mkdtemp(join(tmpdir(), 'tamys-preflight-'));
    const baselineLog = join(work, 'baseline.log');
    const changedLog = join(work, 'changed.log');

    await writeFile(baselineLog, BASELINE_LOG);
    await writeFile(changedLog, CHANGED_LOG);

    process.stdout.write(`preflight: resolving the PINNED engine (TAMYS_VERSION ${TAMYS_VERSION})\n`);
    const tamysBin = await resolveTamys('', work);

    const failures: string[] = [];
    let bothCellArgs: readonly string[] = [];
    let bothCellOutput = '';

    // ── A) every verdict cell the Action can emit, each against the PINNED engine ────────────
    // Every other optional field stays populated, so every conditional `args.push` in tamysArgs is
    // still TAKEN in each cell. Only the verdict coordinate varies.
    for (const [index, cell] of VERDICT_CELLS.entries()) {
        const outputPath = join(work, `report-${index}.json`);
        const invocation: TamysInvocation = {
            tamysBin,
            baselineLog,
            changedLog,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: cell.baselineOutcome,
            changedOutcome: cell.changedOutcome,
            failOn: 'medium',
            outputPath,
            changedTransport: LOG_FILE_TRANSPORT,
            baselineTransport: LOG_FILE_TRANSPORT,
        };
        const args = tamysArgs(invocation);
        if (cell.baselineOutcome && cell.changedOutcome) {
            bothCellArgs = args;
            bothCellOutput = outputPath;
        }

        const r = await runVector(tamysBin, args, outputPath);
        const ok = !r.rejected && r.ranClean && r.wroteReport;
        process.stdout.write(
            `preflight cell ${index + 1}/${VERDICT_CELLS.length} [${cell.name}]: ` +
                `${args.length} args, exit ${r.exitCode} — ${ok ? 'accepted' : 'REJECTED'}\n`,
        );
        if (!ok) {
            if (r.stderr.trim()) {
                process.stdout.write(`--- engine stderr ---\n${r.stderr.trimEnd()}\n---------------------\n`);
            }
            failures.push(
                `  cell [${cell.name}]: exit ${r.exitCode}` +
                    `${r.exitCode === 134 ? ' (ABORTED — died on a signal)' : ''}` +
                    `, report.json ${r.wroteReport ? 'written' : 'ABSENT'}, rejected=${r.rejected}\n` +
                    `      vector: ${args.join(' ')}`,
            );
        }
    }

    // ── A′) the `--changed-job-graph` coordinate, in its three ship shapes ───────────────────
    // Each graph is the wire jobgraph.ts PRODUCES — `parseWorkflowJobs` over a workflow file,
    // joined by `joinDeclaredJobs` with a listing — never a hand-written wire, so a producer change
    // the pinned engine refuses reds here, not only a flag. The verdict cells above stay graph-FREE
    // because acquisition-absent is itself a ship shape (a denied `contents: read`, a missing
    // GITHUB_WORKFLOW_REF or GITHUB_WORKFLOW_SHA, a listing that failed), so both halves of the
    // conditional stay driven on the real engine.
    const GRAPH_CELLS: ReadonlyArray<{
        name: string;
        workflow: string;
        listing: RenderedJob[];
        baselineOutcome: string;
        changedOutcome: string;
    }> = [
        {
            // The full PR shape: run tokens AND a graph carrying every conclusion state and every
            // listed-steps state this producer writes (DN-89.D26, DN-140.D3) — an edge, a resolved
            // conclusion, a reusable-workflow fan-out (`concluded_per_rendering`), a matrix whose
            // legs render, a declaration no row reaches (`no_rendering`), a job still running
            // (`not_concluded`), listed steps with converted and `not_timed` times, `[]`, and
            // `emptied_by_platform`.
            name: 'graph + both verdicts',
            workflow: [
                'jobs:',
                '  build:',
                '    runs-on: ubuntu-latest',
                '    steps:',
                '      - uses: actions/checkout@v5',
                '      - run: make test',
                '  bazel:',
                '    name: Bazel',
                '    uses: ./.github/workflows/bazel.yml',
                '  unit:',
                '    strategy:',
                '      matrix:',
                '        os: [linux, windows]',
                '  ghost:',
                '    runs-on: ubuntu-latest',
                '  tamys:',
                '    runs-on: ubuntu-latest',
                '  gate:',
                '    needs: [build, bazel, unit]',
            ].join('\n'),
            listing: [
                {
                    id: 501,
                    name: 'build',
                    conclusion: 'failure',
                    run_attempt: 1,
                    steps: [
                        { number: 1, name: 'Set up job', conclusion: 'success', started_at: '2026-10-07T10:00:00Z', completed_at: '2026-10-07T10:00:02Z' },
                        { number: 2, name: 'Run make test', conclusion: 'failure', started_at: '2026-10-07T10:00:02Z', completed_at: '2026-10-07T10:03:41Z' },
                        { number: 3, name: 'Complete job', conclusion: 'success', started_at: '2026-10-07T10:03:41.5Z', completed_at: null },
                    ],
                    runner_id: 11,
                    runner_name: 'GitHub Actions 11',
                },
                { id: 502, name: 'Bazel / test linux', conclusion: 'success', run_attempt: 1, steps: [], runner_id: 12, runner_name: 'GitHub Actions 12' },
                { id: 503, name: 'Bazel / test windows', conclusion: 'failure', run_attempt: 1, steps: [], runner_id: 13, runner_name: 'GitHub Actions 13' },
                { id: 504, name: 'unit (linux)', conclusion: 'success', run_attempt: 1, steps: [], runner_id: null, runner_name: null },
                { id: 505, name: 'unit (windows)', conclusion: 'skipped', run_attempt: 1, steps: [], runner_id: null, runner_name: null },
                { id: 506, name: 'tamys', conclusion: null, run_attempt: 1, steps: [{ number: 1, name: 'Set up job', conclusion: null, started_at: '2026-10-07T10:04:00Z', completed_at: null }], runner_id: 14, runner_name: 'GitHub Actions 14' },
                { id: 507, name: 'gate', conclusion: 'failure', run_attempt: 1, steps: [], runner_id: 15, runner_name: 'GitHub Actions 15' },
            ],
            baselineOutcome: 'success',
            changedOutcome: 'failure',
        },
        {
            // `log:` sourcing with no outcome wiring: the graph's conclusions are the ONLY
            // declared verdicts, so the vocabulary rides on them alone — the exact pairing branch
            // ADR-22.D13 added, driven with no run token to mask it.
            name: 'graph conclusions only, no run tokens',
            workflow: ['jobs:', '  deps:', '    runs-on: ubuntu-latest', '  build:', '    needs: deps'].join('\n'),
            listing: [
                { id: 601, name: 'deps', conclusion: 'success', run_attempt: 2, steps: [], runner_id: 21, runner_name: 'r' },
                { id: 602, name: 'build', conclusion: 'failure', run_attempt: 2, steps: [], runner_id: 22, runner_name: 'r' },
            ],
            baselineOutcome: '',
            changedOutcome: '',
        },
        {
            // Every conclusion withheld — the jobs had not concluded when the listing was read, and
            // one declaration renders nowhere — so the graph states no verdict and NO vocabulary
            // rides: the engine must accept it bare (its refusal trigger is a STATED conclusion).
            name: 'every conclusion withheld, no verdicts, no vocabulary',
            workflow: ['jobs:', '  build:', '    runs-on: ubuntu-latest', '  later:', '    needs: build'].join('\n'),
            listing: [
                { id: 701, name: 'build', conclusion: null, run_attempt: 1, steps: [{ number: 1, name: 'Set up job', conclusion: null, started_at: null, completed_at: null }], runner_id: 31, runner_name: 'r' },
            ],
            baselineOutcome: '',
            changedOutcome: '',
        },
    ];
    for (const [index, cell] of GRAPH_CELLS.entries()) {
        const outputPath = join(work, `report-graph-${index}.json`);
        const graphPath = join(work, `graph-${index}.json`);
        const jobs = joinDeclaredJobs(parseWorkflowJobs(cell.workflow), cell.listing);
        // The file body is written the way runTamys writes it — JSON.stringify of the typed wire —
        // so this drives the bytes the engine will really receive, not a hand-authored guess.
        await writeFile(graphPath, JSON.stringify(jobs));
        const invocation: TamysInvocation = {
            tamysBin,
            baselineLog,
            changedLog,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: cell.baselineOutcome,
            changedOutcome: cell.changedOutcome,
            failOn: 'medium',
            outputPath,
            changedTransport: LOG_FILE_TRANSPORT,
            baselineTransport: LOG_FILE_TRANSPORT,
            changedJobGraph: { path: graphPath, jobs },
        };
        const args = tamysArgs(invocation);
        const r = await runVector(tamysBin, args, outputPath);
        const ok = !r.rejected && r.ranClean && r.wroteReport;
        process.stdout.write(
            `preflight graph cell ${index + 1}/${GRAPH_CELLS.length} [${cell.name}]: ` +
                `${args.length} args, exit ${r.exitCode} — ${ok ? 'accepted' : 'REJECTED'}\n`,
        );
        if (!ok) {
            if (r.stderr.trim()) {
                process.stdout.write(`--- engine stderr ---\n${r.stderr.trimEnd()}\n---------------------\n`);
            }
            failures.push(
                `  graph cell [${cell.name}]: exit ${r.exitCode}` +
                    `${r.exitCode === 134 ? ' (ABORTED — died on a signal)' : ''}` +
                    `, report.json ${r.wroteReport ? 'written' : 'ABSENT'}, rejected=${r.rejected}\n` +
                    `      vector: ${args.join(' ')}`,
            );
        }
    }

    // ── B) the CAPABILITY PROBE — what does the PINNED engine do with a HALF-PAIR? ───────────
    // This is deliberately NOT a vector the Action can build (`tests/tamys.test.ts` proves it never
    // emits one). It is derived from the real both-token vector by REMOVING the vocabulary, so it
    // stays a fact about the engine rather than a hand-written guess at one. The probe asserts
    // nothing about the Action; it asserts that the pin's behaviour is still the one declared
    // above, and it is what makes a bump self-announcing instead of remembered.
    const probeOutput = join(work, 'report-halfpair.json');
    const vocabAt = bothCellArgs.indexOf('--outcome-vocabulary');
    if (vocabAt < 0) {
        failures.push(
            '  capability probe: could not derive a half-pair — the both-token vector carried no\n' +
                '      --outcome-vocabulary at all, which the unit arm should already have caught.',
        );
    } else {
        const probeArgs = [...bothCellArgs.slice(0, vocabAt), ...bothCellArgs.slice(vocabAt + 2)].map((a) =>
            a === bothCellOutput ? probeOutput : a,
        );
        const r = await runVector(tamysBin, probeArgs, probeOutput);
        const observed: 'tolerated' | 'fatal' =
            r.rejected || r.exitCode === 134 || !r.ranClean ? 'fatal' : 'tolerated';
        process.stdout.write(
            `preflight probe [half-pair on the pinned engine]: exit ${r.exitCode} — observed '${observed}', ` +
                `declared '${PINNED_ENGINE_HALF_PAIR}'\n`,
        );
        if (observed !== PINNED_ENGINE_HALF_PAIR) {
            failures.push(
                `  capability probe: the pinned engine now treats a HALF-PAIR as '${observed}',\n` +
                    `      but PINNED_ENGINE_HALF_PAIR in this file still declares '${PINNED_ENGINE_HALF_PAIR}'.\n` +
                    `      THIS IS THE BUMP CHANGING THE CONTRACT, not a flake. A 'fatal' engine turns any\n` +
                    `      regression that drops --outcome-vocabulary from a silent degradation into a usage\n` +
                    `      error on EVERY consumer run. Confirm the Action still pairs (npm test), then move\n` +
                    `      the declaration in the same change as the pin.`,
            );
        }
    }

    // ── C) the OUTPUT CONTRACT — does the pinned engine keep what `readReport` checks? ───────
    // The real vector and the real read: `tamysArgs` builds the invocation, the pinned engine
    // writes the report, and `readReport` judges the bytes exactly as `runTamys` hands them over.
    for (const [index, cell] of HOSTILE_CELLS.entries()) {
        const hostileBaseline = join(work, `hostile-baseline-${index}.log`);
        const hostileChanged = join(work, `hostile-changed-${index}.log`);
        const outputPath = join(work, `report-hostile-${index}.json`);
        await writeFile(hostileBaseline, HOSTILE_BASELINE);
        await writeFile(hostileChanged, cell.changed);
        const invocation: TamysInvocation = {
            tamysBin,
            baselineLog: hostileBaseline,
            changedLog: hostileChanged,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: 'success',
            changedOutcome: 'failure',
            failOn: 'none',
            outputPath,
            changedTransport: LOG_FILE_TRANSPORT,
            baselineTransport: LOG_FILE_TRANSPORT,
        };
        const r = await runVector(tamysBin, tamysArgs(invocation), outputPath);
        let verdict = '';
        if (r.rejected || !r.ranClean || !r.wroteReport) {
            verdict = `the engine did not write a report (exit ${r.exitCode})`;
        } else {
            try {
                const report = readReport(await readFile(outputPath), outputPath, r.exitCode);
                const displayed = [
                    ...report.ranked_changes.flatMap((row) => [row.summary, row.where ?? '', ...(row.evidence ?? [])]),
                    report.markdown ?? '',
                ];
                if (!displayed.some((text) => text.includes(cell.shows))) {
                    verdict =
                        'the report was accepted but shows the hostile line nowhere, so this pair no ' +
                        'longer exercises the contract — re-derive the pair before trusting the pass';
                }
            } catch (error) {
                if (!(error instanceof TamysReportUnreadableError)) {
                    throw error;
                }
                verdict = `the Action would REFUSE this report (${error.defect.kind})`;
            }
        }
        process.stdout.write(
            `preflight contract cell ${index + 1}/${HOSTILE_CELLS.length} [${cell.name}]: ` +
                `${verdict === '' ? 'kept' : 'BROKEN'}\n`,
        );
        if (verdict !== '') {
            failures.push(
                `  contract cell [${cell.name}]: ${verdict}.\n` +
                    `      The Action fails every run whose log carries such a byte unless the pinned\n` +
                    `      engine neutralises it; the check and the pin move together.`,
            );
        }
    }

    // ── C′) the per-side transport coordinate in its asymmetric ship shapes, and the catalogue ─
    // Every cell above declares both sides alike. The Action also sends: a `target-job` run
    // against a `path=` baseline (the baseline side UNDECLARED, the engine deduces it), a `log:`
    // run against a baseline a `target-job` run stored (a declared asymmetry, accepted by design),
    // and, through a stored sidecar, any row of the catalogue the Action accepts on extraction. A
    // name the pinned engine does not know is a FATAL abort there, so each is driven here.
    const TRANSPORT_CELLS: ReadonlyArray<{ name: string; changed: readonly string[]; baseline?: readonly string[] }> = [
        { name: 'job-log stack against an undeclared path= baseline', changed: JOB_LOG_TRANSPORT },
        { name: 'none against a stored job-log stack', changed: LOG_FILE_TRANSPORT, baseline: JOB_LOG_TRANSPORT },
        ...TRANSPORT_CATALOGUE.map((row) => ({
            name: `catalogue row ${row} recorded by a baseline`,
            changed: LOG_FILE_TRANSPORT,
            baseline: [row],
        })),
    ];
    for (const [index, cell] of TRANSPORT_CELLS.entries()) {
        const outputPath = join(work, `report-transport-${index}.json`);
        const invocation: TamysInvocation = {
            tamysBin,
            baselineLog,
            changedLog,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: 'success',
            changedOutcome: 'failure',
            failOn: 'none',
            outputPath,
            changedTransport: cell.changed,
            ...(cell.baseline !== undefined ? { baselineTransport: cell.baseline } : {}),
        };
        const args = tamysArgs(invocation);
        const r = await runVector(tamysBin, args, outputPath);
        const ok = !r.rejected && r.ranClean && r.wroteReport;
        process.stdout.write(
            `preflight transport cell ${index + 1}/${TRANSPORT_CELLS.length} [${cell.name}]: exit ${r.exitCode} — ` +
                `${ok ? 'accepted' : 'REJECTED'}\n`,
        );
        if (!ok) {
            if (r.stderr.trim()) {
                process.stdout.write(`--- engine stderr ---\n${r.stderr.trimEnd()}\n---------------------\n`);
            }
            failures.push(
                `  transport cell [${cell.name}]: exit ${r.exitCode}` +
                    `${r.exitCode === 134 ? ' (ABORTED — died on a signal)' : ''}` +
                    `, report.json ${r.wroteReport ? 'written' : 'ABSENT'}, rejected=${r.rejected}\n` +
                    `      vector: ${args.join(' ')}`,
            );
        }
    }

    // ── D) DN-89.D38 A7 — a target-job pair, declared under the job-log stack, really peels ────
    {
        const baseline = await acquireStamped(false);
        const changed = await acquireStamped(true);
        const stampedBaseline = join(work, 'stamped-baseline.log');
        const stampedChanged = join(work, 'stamped-changed.log');
        const outputPath = join(work, 'report-stamped.json');
        await writeFile(stampedBaseline, baseline.bytes);
        await writeFile(stampedChanged, changed.bytes);
        const invocation: TamysInvocation = {
            tamysBin,
            baselineLog: stampedBaseline,
            changedLog: stampedChanged,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: 'success',
            changedOutcome: 'failure',
            failOn: 'none',
            outputPath,
            changedTransport: changed.transport,
            // A baseline stored by a target-job run carries the same stack in its sidecar.
            baselineTransport: baseline.transport,
        };
        const args = tamysArgs(invocation);
        const r = await runVector(tamysBin, args, outputPath);
        const agrees = `transport: preflight-changed ${changed.transport.join(',')} (declared) — the probe on these bytes agrees`;
        let verdict = '';
        if (r.rejected || !r.ranClean || !r.wroteReport) {
            verdict = `the engine did not write a report (exit ${r.exitCode}${r.exitCode === 134 ? ', ABORTED' : ''})`;
        } else if (!r.stderr.includes(agrees)) {
            verdict = `the changed side's confrontation does not read "${agrees}"`;
        } else {
            const report = readReport(await readFile(outputPath), outputPath, r.exitCode);
            const stamped = report.ranked_changes
                .flatMap((row) => [row.summary, ...(row.evidence ?? [])])
                .filter((textLine) => textLine.includes(STAMP_DATE));
            if (report.ranked_changes.length === 0) {
                verdict = 'the stamped pair ranked nothing, so it no longer shows whether the stack peeled';
            } else if (stamped.length > 0) {
                verdict = `a ranked row still carries a stamp, so the declared stack did not peel: "${stamped[0]}"`;
            }
        }
        process.stdout.write(
            `preflight stack cell [target-job pair, ${changed.transport.join(',')}]: ` +
                `exit ${r.exitCode} — ${verdict === '' ? 'peeled, probe agrees' : 'BROKEN'}\n`,
        );
        if (verdict !== '') {
            if (r.stderr.trim()) {
                process.stdout.write(`--- engine stderr ---\n${r.stderr.trimEnd()}\n---------------------\n`);
            }
            failures.push(`  stack cell [target-job pair]: ${verdict}.\n      vector: ${args.join(' ')}`);
        }
    }

    // ── E) DN-118.O3 arm R5, the engine's half — a target job's declared success frames its rows ─
    // The graph is read at `target-job` grain since DN-118.D4's gate was withdrawn. On one job's
    // log its first reader is the job-grain claim frame: a run that failed elsewhere, whose target
    // job the listing declares successful, absorbs a new declared error in that job (High, "its job
    // is declared successful") where the run's failure alone mints `New — FAILING` at Critical. The
    // graph is the producer's own output for a one-job listing; the control is the same vector
    // without it, so a frame that stopped engaging cannot pass as one that holds.
    {
        const jobLog = oneJobLog;
        const frameBaseline = join(work, 'frame-baseline.log');
        const frameChanged = join(work, 'frame-changed.log');
        await writeFile(frameBaseline, jobLog(false));
        await writeFile(frameChanged, jobLog(true));
        const graphPath = join(work, 'frame-graph.json');
        const jobs = joinDeclaredJobs(
            parseWorkflowJobs(['jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: make test', '      - run: ./lint.sh'].join('\n')),
            [{ id: 801, name: 'build', conclusion: 'success', run_attempt: 1, steps: [], runner_id: 41, runner_name: 'r' }],
        );
        await writeFile(graphPath, JSON.stringify(jobs));
        const frameCell = async (withGraph: boolean): Promise<{ args: string[]; rows: string[]; verdict: string }> => {
            const outputPath = join(work, `report-frame-${withGraph ? 'graph' : 'bare'}.json`);
            const invocation: TamysInvocation = {
                tamysBin,
                baselineLog: frameBaseline,
                changedLog: frameChanged,
                baselineLabel: 'preflight-baseline',
                changedLabel: 'preflight-changed',
                baselineOutcome: 'success',
                changedOutcome: 'failure',
                failOn: 'none',
                outputPath,
                changedTransport: JOB_LOG_TRANSPORT,
                baselineTransport: JOB_LOG_TRANSPORT,
                ...(withGraph ? { changedJobGraph: { path: graphPath, jobs } } : {}),
            };
            const args = tamysArgs(invocation);
            const r = await runVector(tamysBin, args, outputPath);
            if (r.rejected || !r.ranClean || !r.wroteReport) {
                return { args, rows: [], verdict: `the engine did not write a report (exit ${r.exitCode})` };
            }
            const report = readReport(await readFile(outputPath), outputPath, r.exitCode);
            const rows = report.ranked_changes.map((row) => `${row.severity} ${row.summary}`);
            return { args, rows, verdict: '' };
        };
        const framed = await frameCell(true);
        const bare = await frameCell(false);
        let verdict = framed.verdict || bare.verdict;
        if (verdict === '' && !bare.rows.some((row) => row.startsWith('critical') && row.includes('FAILING'))) {
            verdict = `the control without the graph no longer mints a Critical FAILING row (${JSON.stringify(bare.rows)}), so this cell proves nothing`;
        } else if (
            verdict === '' &&
            !framed.rows.some((row) => row.startsWith('high') && row.includes('its job is declared successful'))
        ) {
            verdict = `with the graph, no row reads its job's declared success: ${JSON.stringify(framed.rows)}`;
        } else if (verdict === '' && framed.rows.some((row) => row.includes('FAILING'))) {
            verdict = `with the graph, a row still claims FAILING: ${JSON.stringify(framed.rows)}`;
        }
        process.stdout.write(
            `preflight frame cell [target job declared successful in a failed run]: ${verdict === '' ? 'framed' : 'BROKEN'}\n`,
        );
        if (verdict !== '') failures.push(`  frame cell: ${verdict}.\n      vector: ${framed.args.join(' ')}`);
    }

    // ── F) DN-140.D4 and DN-140.D5 — a failed target job's row names the step its listing declares failed ─
    // End to end through the Action's own halves: the log acquired by `fetchTargetJobLog` from a
    // listing row (its id and attempt returned beside the bytes), the graph joined from that same
    // row by the producer, the vector built by `tamysArgs` with the provenance declared. The pinned
    // engine names step 3 on the job's FAILING row, with the seconds it ran. The control drops the
    // provenance and must name nothing, counting the side `provenance_undeclared`, so a naming that
    // engaged without the declaration cannot pass here.
    {
        const failedRow = {
            id: 901,
            name: 'build',
            status: 'completed',
            conclusion: 'failure',
            run_attempt: 1,
            steps: [
                { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-10-07T10:00:00Z', completed_at: '2026-10-07T10:00:02Z' },
                { number: 2, name: 'Run make test', status: 'completed', conclusion: 'success', started_at: '2026-10-07T10:00:02Z', completed_at: '2026-10-07T10:00:10Z' },
                { number: 3, name: 'Lint the tree', status: 'completed', conclusion: 'failure', started_at: '2026-10-07T10:00:10Z', completed_at: '2026-10-07T10:00:41Z' },
            ],
            runner_id: 51,
            runner_name: 'GitHub Actions 51',
        };
        const acquired = await fetchTargetJobLog({
            octokit: servingClient(oneJobLog(true)),
            owner: 'preflight',
            repo: 'preflight',
            jobs: [failedRow],
            jobName: 'build',
            capture: 'auto',
        });
        const namingBaseline = join(work, 'naming-baseline.log');
        const namingChanged = join(work, 'naming-changed.log');
        await writeFile(namingBaseline, oneJobLog(false));
        await writeFile(namingChanged, acquired.bytes);
        const graphPath = join(work, 'naming-graph.json');
        const jobs = joinDeclaredJobs(
            parseWorkflowJobs(['jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: make test', '      - run: ./lint.sh'].join('\n')),
            [{ ...failedRow, steps: failedRow.steps.map(({ status: _status, ...step }) => step) }],
        );
        await writeFile(graphPath, JSON.stringify(jobs));
        const namingCell = async (declared: boolean) => {
            const outputPath = join(work, `report-naming-${declared ? 'declared' : 'undeclared'}.json`);
            const invocation: TamysInvocation = {
                tamysBin,
                baselineLog: namingBaseline,
                changedLog: namingChanged,
                baselineLabel: 'preflight-baseline',
                changedLabel: 'preflight-changed',
                baselineOutcome: 'success',
                changedOutcome: acquired.conclusion ?? '',
                failOn: 'none',
                outputPath,
                changedTransport: acquired.transport,
                baselineTransport: JOB_LOG_TRANSPORT,
                changedJobGraph: { path: graphPath, jobs },
                ...(declared ? { changedLogProvenance: { jobId: acquired.jobId, attempt: acquired.runAttempt } } : {}),
            };
            const args = tamysArgs(invocation);
            const r = await runVector(tamysBin, args, outputPath);
            if (r.rejected || !r.ranClean || !r.wroteReport) {
                return { args, rows: [] as string[], naming: '', failure: `the engine did not write a report (exit ${r.exitCode})` };
            }
            const raw = JSON.parse((await readFile(outputPath)).toString('utf8')) as {
                summary?: { job_outcomes?: { step_naming?: unknown } };
            };
            const report = readReport(await readFile(outputPath), outputPath, r.exitCode);
            return {
                args,
                rows: report.ranked_changes.map((row) => row.summary),
                naming: JSON.stringify(raw.summary?.job_outcomes?.step_naming ?? null),
                failure: '',
            };
        };
        const named = await namingCell(true);
        const unnamed = await namingCell(false);
        const expected = 'failed step: 3 "Lint the tree" (31s)';
        let verdict = named.failure || unnamed.failure;
        if (verdict === '' && !named.rows.some((row) => row.includes(expected))) {
            verdict = `with the provenance declared, no row reads ${expected}: ${JSON.stringify(named.rows)} (step_naming ${named.naming})`;
        } else if (verdict === '' && (unnamed.rows.some((row) => row.includes('failed step:')) || !unnamed.naming.includes('"provenance_undeclared":1'))) {
            verdict = `the control without provenance named a step or did not count it undeclared: ${JSON.stringify(unnamed.rows)} (step_naming ${unnamed.naming})`;
        }
        process.stdout.write(
            `preflight naming cell [a failed target job's listed failed step]: ${verdict === '' ? 'named' : 'BROKEN'}\n`,
        );
        if (verdict !== '') failures.push(`  naming cell: ${verdict}.\n      vector: ${named.args.join(' ')}`);
    }

    // ── G) DN-89.D34 on the Action path — a value in a step banner joins its declared step ───────
    // Both runs declare `run: git diff ${{ github.sha }}`, and each banner renders its own commit.
    // With BOTH graphs on the wire — each the producer's output for its own run, the baseline one
    // passed as `--baseline-job-graph` — the two banners are one declared step and the pair reads
    // no change. The control drops the baseline graph and must read the split the route repairs
    // (a new and a vanished step), so a route that stopped engaging cannot pass as one that holds.
    {
        const bannerLog = (sha: string): Buffer =>
            logOf([
                Buffer.concat([bytes(0xef, 0xbb, 0xbf), utf8(`${STAMP}Current runner version: '2.335.1'`)]),
                utf8(`${STAMP}Complete job name: build`),
                utf8(`${STAMP}##[group]Run git diff ${sha}`),
                utf8(`${STAMP}git diff ${sha}`),
                utf8(`${STAMP}diff output line`),
                utf8(`${STAMP}##[endgroup]`),
                utf8(`${STAMP}##[group]Run make test`),
                utf8(`${STAMP}ok: 12 passed`),
                utf8(`${STAMP}##[endgroup]`),
                utf8(`${STAMP}Post job cleanup.`),
            ]);
        const templateBaseline = join(work, 'template-baseline.log');
        const templateChanged = join(work, 'template-changed.log');
        await writeFile(templateBaseline, bannerLog('a'.repeat(40)));
        await writeFile(templateChanged, bannerLog('b'.repeat(40)));
        const workflow = ['jobs:', '  build:', '    steps:', '      - run: git diff ${{ github.sha }}', '      - run: make test'].join('\n');
        const graphOf = (id: number) =>
            joinDeclaredJobs(parseWorkflowJobs(workflow), [
                { id, name: 'build', conclusion: 'success', run_attempt: 1, steps: [], runner_id: 61, runner_name: 'r' },
            ]);
        const changedGraph = { path: join(work, 'template-changed-graph.json'), jobs: graphOf(902) };
        const baselineGraph = { path: join(work, 'template-baseline-graph.json'), jobs: graphOf(903) };
        await writeFile(changedGraph.path, JSON.stringify(changedGraph.jobs));
        await writeFile(baselineGraph.path, JSON.stringify(baselineGraph.jobs));
        const templateCell = async (withBaseline: boolean) => {
            const outputPath = join(work, `report-template-${withBaseline ? 'both' : 'changed'}.json`);
            const invocation: TamysInvocation = {
                tamysBin,
                baselineLog: templateBaseline,
                changedLog: templateChanged,
                baselineLabel: 'preflight-baseline',
                changedLabel: 'preflight-changed',
                baselineOutcome: 'success',
                changedOutcome: 'success',
                failOn: 'none',
                outputPath,
                changedTransport: JOB_LOG_TRANSPORT,
                baselineTransport: JOB_LOG_TRANSPORT,
                changedJobGraph: changedGraph,
                ...(withBaseline ? { baselineJobGraph: baselineGraph } : {}),
            };
            const args = tamysArgs(invocation);
            const r = await runVector(tamysBin, args, outputPath);
            if (r.rejected || !r.ranClean || !r.wroteReport) {
                return { args, total: -1, failure: `the engine did not write a report (exit ${r.exitCode})` };
            }
            const report = readReport(await readFile(outputPath), outputPath, r.exitCode);
            return { args, total: report.summary.total_changes, failure: '' };
        };
        const joined = await templateCell(true);
        const split = await templateCell(false);
        let verdict = joined.failure || split.failure;
        if (verdict === '' && split.total === 0) {
            verdict = 'the control without the baseline graph reads no change, so this cell proves nothing';
        } else if (verdict === '' && joined.total !== 0) {
            verdict = `with both graphs the pair still reads ${joined.total} change(s), where one declared step renders two values`;
        }
        process.stdout.write(
            `preflight template cell [a value in a step banner, both graphs]: ${verdict === '' ? `joined (control: ${split.total} changes)` : 'BROKEN'}\n`,
        );
        if (verdict !== '') failures.push(`  template cell: ${verdict}.\n      vector: ${joined.args.join(' ')}`);
    }

    // ── H) the frame's two copies of engine text (W469, W446) — still the pinned engine's words ──
    // The comment's visible frame states the claim boundary and the n-gram disclosure itself,
    // because the JSON carries the first nowhere and the second only as numbers. Both are copies of
    // engine text, so the pinned engine's own markdown must carry each verbatim. The pair binds the
    // engine's n-gram cap (4096 keys) in one window: 6 000 distinct templates in shuffled order, so
    // the disclosure is really rendered, and an empty line cannot pass as an agreeing one.
    {
        const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
        const lineOf = (index: number): string =>
            `step ${[0, 1, 2, 3].map((digit) => words[Math.floor(index / 10 ** digit) % 10]).join(' ')} done`;
        const all = Array.from({ length: 6000 }, (_, index) => lineOf(index % 10_000));
        // A fixed permutation: stride 7 is coprime with 6 000, so every line appears once.
        const shuffled = all.map((_, index) => all[(index * 7) % all.length]!);
        const capBaseline = join(work, 'ngram-baseline.log');
        const capChanged = join(work, 'ngram-changed.log');
        await writeFile(capBaseline, `${all.slice(0, 3000).join('\n')}\n`);
        await writeFile(capChanged, `${shuffled.join('\n')}\n`);
        const outputPath = join(work, 'report-ngram.json');
        const invocation: TamysInvocation = {
            tamysBin,
            baselineLog: capBaseline,
            changedLog: capChanged,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: '',
            changedOutcome: '',
            failOn: 'none',
            outputPath,
            changedTransport: LOG_FILE_TRANSPORT,
            baselineTransport: LOG_FILE_TRANSPORT,
        };
        const args = tamysArgs(invocation);
        const r = await runVector(tamysBin, args, outputPath);
        let verdict = '';
        if (r.rejected || !r.ranClean || !r.wroteReport) {
            verdict = `the engine did not write a report (exit ${r.exitCode})`;
        } else {
            const report = readReport(await readFile(outputPath), outputPath, r.exitCode);
            const markdown = report.markdown ?? '';
            const disclosure = ngramRefusalLine(report);
            if (disclosure === '') {
                verdict = 'no window refused, so this pair no longer exercises the disclosure — re-derive it';
            } else if (!markdown.includes(disclosure)) {
                verdict = `the engine's markdown does not carry the frame's n-gram sentence "${disclosure}"`;
            } else if (!markdown.includes(CLAIM_BOUNDARY)) {
                verdict = "the engine's markdown does not carry the frame's CLAIM_BOUNDARY verbatim";
            }
        }
        process.stdout.write(`preflight text cell [the frame's copies of engine text]: ${verdict === '' ? 'verbatim' : 'BROKEN'}\n`);
        if (verdict !== '') failures.push(`  text cell: ${verdict}.\n      vector: ${args.join(' ')}`);
    }

    // ── I) the narration process's vector (DN-158.D4) — `tamys explain --report … --format md -o …` ──
    // The real argv and the real environment builder, over a report the pinned engine wrote above.
    // The endpoint is https on a loopback port nothing listens on: the engine accepts it, its one
    // call is refused at connect, and the narration fails soft — exit 0 and the output file written,
    // empty — which is the shape the Action reads as "no narrative".
    {
        const outputPath = join(work, 'narrative.md');
        const args = narrationArgs(bothCellOutput, outputPath);
        const env = narrationEnv({ apiKey: 'preflight-no-key', endpoint: 'https://127.0.0.1:9/v1/messages', model: 'preflight-model' });
        let stderr = '';
        let exitCode = 0;
        try {
            stderr = (await execFileAsync(tamysBin, args, { env, maxBuffer: 32 * 1024 * 1024 })).stderr;
        } catch (e) {
            const err = e as { stderr?: string; code?: number; signal?: string };
            stderr = err.stderr ?? '';
            exitCode = err.code ?? (err.signal ? 134 : 1);
        }
        let wrote = true;
        try {
            await access(outputPath);
        } catch {
            wrote = false;
        }
        const verdict =
            exitCode !== 0
                ? `exit ${exitCode}`
                : !wrote
                  ? `exit 0 and no file at ${outputPath}`
                  : /unknown option|unknown|unrecognized/i.test(stderr)
                    ? 'a flag was refused'
                    : '';
        process.stdout.write(
            `preflight narration cell [explain --report --format md -o]: ${verdict === '' ? 'accepted' : 'REJECTED'}\n`,
        );
        if (verdict !== '') {
            if (stderr.trim()) {
                process.stdout.write(`--- engine stderr ---\n${stderr.trimEnd()}\n---------------------\n`);
            }
            failures.push(`  narration cell: ${verdict}.\n      vector: ${args.join(' ')}`);
        }
    }

    if (failures.length > 0) {
        process.stderr.write(
            `\nPREFLIGHT FAILED — engine ${tamysBin} (TAMYS_VERSION ${TAMYS_VERSION})\n` +
                `${failures.join('\n')}\n` +
                `\nA forwarded flag or value outruns the pin, or the pin's behaviour moved under us.\n` +
                `Either the engine must ship the capability first and TAMYS_VERSION move with it, or the\n` +
                `forwarding comes out.\n`,
        );
        process.exitCode = 1;
        return;
    }

    process.stdout.write(
        `preflight OK — the pinned engine accepted all ${VERDICT_CELLS.length} verdict cells, ` +
            `all ${GRAPH_CELLS.length} graph cells and all ${TRANSPORT_CELLS.length} transport cells, kept ` +
            `the output contract on all ${HOSTILE_CELLS.length} hostile pairs, peeled the target-job ` +
            "stack with its probe agreeing, framed a target job's declared success, named a failed " +
            "target job's listed failed step, joined a banner's value to its declared step across both " +
            "graphs, still writes the frame's copies of its text verbatim, took the narration vector, and its " +
            "half-pair behaviour is still " +
            `'${PINNED_ENGINE_HALF_PAIR}'.\n`,
    );
}

await main();
