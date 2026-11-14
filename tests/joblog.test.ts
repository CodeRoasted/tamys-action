// target-job log sourcing (DN-89.D38): the job log is acquired as BYTES, declared under the API
// job-log stack, and never rewritten; capture is a SELECTION of whole lines whose markers are
// read behind the delivery head. Plus the job lookup's fail-loud contract (missing / ambiguous /
// not-completed), the per-input byte ceiling, and the acquired-grain line.
//
// Arms A1 (the target-job half), A2, A3, A4 and A5 of DN-89.D38 live here. Every arm drives the
// one public seam, `fetchTargetJobLog`, against a client that behaves like the real one: asked
// for the body unparsed, it streams the served bytes in small chunks; asked the default way, it
// hands back the body DECODED as text, as GitHub's `text/plain` makes octokit do (measured at
// gate G1, coderoast-corpora f7149a2: 741 383 bytes as a string against 741 386 on the wire).
// So a regression of the request shows up as wrong bytes, not only as a wrong option.
//
// The fixtures are written by hand rather than taken from a real job log: the four hazards A2
// names (a mark at offset 0, a CRLF line, an ill-formed byte, a run of spaces after a stamp) are
// not all present in any one served log, and G1 already holds the real-bytes evidence for the
// request. Every byte is built from a code point or a literal below; nothing is read from disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acquiredGrainLine, fetchTargetJobLog, type FetchJobLogParams } from '../src/joblog.js';
import { MAX_CHANGED_LOG_BYTES } from '../src/types.js';

// A real head as the job-log API serves it: an RFC 3339 stamp with seven fraction digits, then
// one space (the shape of the engine's own stack test, tamys_cli_transport_stack_peel_test.cpp).
const T = '2026-06-21T12:19:42.7928236Z ';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ILL_FORMED = Buffer.from([0xff]);

// The stack DN-89.D38 §2 rules for an API-served job log, spelled out rather than imported: the
// arm must fail if the Action's constant drifts, so it may not read that constant.
const JOB_LOG_STACK = ['utf8-bom-line-prefix', 'api-rfc3339-line-prefix'];

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');
const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);
// One line with its LF terminator.
const ln = (...parts: Buffer[]): Buffer => cat(...parts, utf8('\n'));
// One stamped line, LF-terminated.
const st = (payload: string): Buffer => ln(utf8(T), utf8(payload));
// One stamped line, CRLF-terminated.
const stCrlf = (payload: string): Buffer => cat(utf8(T), utf8(payload), utf8('\r\n'));

// Small on purpose, and odd: chunk boundaries then fall inside the mark, inside a stamp and
// between a CR and its LF, so an Action that decodes or splits per chunk breaks visibly.
const CHUNK_BYTES = 5;

function streamOf(bytes: Uint8Array, chunkBytes: number): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (let at = 0; at < bytes.byteLength; at += chunkBytes) {
                controller.enqueue(bytes.slice(at, at + chunkBytes));
            }
            controller.close();
        },
    });
}

interface DownloadRequest {
    owner: string;
    repo: string;
    job_id: number;
    request?: { parseSuccessResponseBody?: boolean };
}

interface Job {
    id: number;
    name: string;
    status: string;
    conclusion?: string | null;
    run_attempt?: number;
}

// `log` may be a FUNCTION OF THE JOB ID, and that is not a convenience: a fixed body makes every
// job in the run indistinguishable, so an arm asserting on the returned bytes cannot tell the
// RIGHT job from the WRONG one. Keying the log by id makes the returned bytes name the row the
// lookup actually resolved.
function fetchParams(
    jobs: Job[],
    log: Uint8Array | ((jobId: number) => Uint8Array),
    over: Partial<FetchJobLogParams> = {},
    requests: DownloadRequest[] = [],
    chunkBytes: number = CHUNK_BYTES,
): FetchJobLogParams {
    const octokit = {
        rest: {
            actions: {
                downloadJobLogsForWorkflowRun: async (args: DownloadRequest) => {
                    requests.push(args);
                    const served = typeof log === 'function' ? log(args.job_id) : log;
                    return {
                        data:
                            args.request?.parseSuccessResponseBody === false
                                ? streamOf(served, chunkBytes)
                                : new TextDecoder('utf-8').decode(served),
                    };
                },
            },
        },
    };
    return {
        octokit: octokit as unknown as FetchJobLogParams['octokit'],
        owner: 'o',
        repo: 'r',
        jobs,
        jobName: 'build',
        capture: 'auto',
        ...over,
    };
}

const BUILD_JOB: Job[] = [{ id: 7, name: 'build', status: 'completed', conclusion: 'success' }];

async function acquire(log: Uint8Array, capture: string): Promise<Buffer> {
    const out = await fetchTargetJobLog(fetchParams(BUILD_JOB, log, { capture }));
    return Buffer.from(out.bytes);
}

// The first differing offset and a window of both sides in hex, so a red names the byte.
function byteDiff(actual: Uint8Array, expected: Uint8Array): string {
    const a = Buffer.from(actual);
    const e = Buffer.from(expected);
    let at = 0;
    while (at < a.length && at < e.length && a[at] === e[at]) at += 1;
    const from = Math.max(0, at - 8);
    return (
        `lengths actual ${a.length} expected ${e.length}; first difference at byte ${at}\n` +
        `  actual   [${from}..]: ${a.subarray(from, at + 16).toString('hex')}\n` +
        `  expected [${from}..]: ${e.subarray(from, at + 16).toString('hex')}`
    );
}

function assertSameBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
    assert.ok(Buffer.from(actual).equals(Buffer.from(expected)), `${what}\n${byteDiff(actual, expected)}`);
}

// ── A3: the request ─────────────────────────────────────────────────────────────────────────
//
// The download is requested with its success body UNPARSED, the option gate G1 measured on the
// live endpoint. Asserted on the request the Action issues; whether the HTTP layer then keeps
// the bytes is G1's, not this arm's.

test('A3: the job log is requested with its success body unparsed', async () => {
    const requests: DownloadRequest[] = [];
    await fetchTargetJobLog(fetchParams(BUILD_JOB, st('hello'), { capture: 'off' }, requests));
    assert.equal(requests.length, 1, `expected one download, saw ${requests.length}`);
    const [request] = requests;
    assert.equal(request?.job_id, 7, 'the download names the resolved job');
    assert.equal(
        request?.request?.parseSuccessResponseBody,
        false,
        `the download must ask for the body unparsed; it asked ${JSON.stringify(request?.request)}`,
    );
});

// ── A2: bytes in, equal bytes out ───────────────────────────────────────────────────────────
//
// With nothing to select, the bytes handed to the engine are the served bytes. The fixture
// holds every byte a text decode or a stamp strip destroys: the mark at offset 0, a CRLF line,
// an ill-formed byte, three spaces after a stamp, and a last line with no terminator.

const SERVED_WITHOUT_SECTIONS = cat(
    ln(BOM, utf8(T), utf8('Current runner version: 2.335.1')),
    stCrlf('##[group]Run make ci'),
    ln(utf8(T), utf8('compiler said '), ILL_FORMED, utf8(' here')),
    st('   Compiling widget v0.1.0'),
    utf8(T),
    utf8('Cleaning up orphan processes'),
);

test('A2: capture off — the engine receives the served bytes, byte for byte', async () => {
    assertSameBytes(
        await acquire(SERVED_WITHOUT_SECTIONS, 'off'),
        SERVED_WITHOUT_SECTIONS,
        'capture off rewrote the served bytes (a decode drops the mark and replaces 0xff; a strip drops stamps and CRs)',
    );
});

test('A2: capture auto on a log without sections — the served bytes, byte for byte', async () => {
    assertSameBytes(
        await acquire(SERVED_WITHOUT_SECTIONS, 'auto'),
        SERVED_WITHOUT_SECTIONS,
        'auto with no section rewrote the served bytes',
    );
});

test('A2: capture off passes sections through too — markers are selected only when asked', async () => {
    const served = cat(st('setup'), st('TAMYS_CAPTURE ci'), st('line a'), st('TAMYS_CAPTURE_END'), st('outside'));
    assertSameBytes(await acquire(served, 'off'), served, 'capture off must not select');
});

// ── A1, the target-job half: the acquisition declares its stack ─────────────────────────────

test('A1: a target-job acquisition declares the API job-log stack, mark row first', async () => {
    const out = await fetchTargetJobLog(fetchParams(BUILD_JOB, st('hello'), { capture: 'off' }));
    assert.deepEqual(
        [...out.transport],
        JOB_LOG_STACK,
        `the target-job path declares ${JSON.stringify(out.transport)}`,
    );
});

// ── A4: selection on stamped bytes ──────────────────────────────────────────────────────────
//
// A marker is found behind a stamp, behind a mark and a stamp, and on a CRLF line, for a named,
// an anonymous and an unterminated section. Forwarded lines keep their stamps, marks and CRs.
// Marker lines are not forwarded. Three controls are NOT markers and are forwarded as content.

test('A4: a named section behind stamps — its lines forwarded with their stamps, markers dropped', async () => {
    const served = cat(
        ln(BOM, utf8(T), utf8('Current runner version: 2.335.1')),
        st('TAMYS_CAPTURE ci'),
        st('building'),
        st('   indented by three'),
        st('TAMYS_CAPTURE_END'),
        st('teardown'),
    );
    assertSameBytes(
        await acquire(served, 'ci'),
        cat(st('building'), st('   indented by three')),
        'the named section was not selected whole',
    );
});

test('A4: an anonymous section opened behind a mark AND a stamp, at offset 0', async () => {
    const served = cat(ln(BOM, utf8(T), utf8('TAMYS_CAPTURE')), st('payload'), st('TAMYS_CAPTURE_END'), st('after'));
    assertSameBytes(await acquire(served, 'auto'), st('payload'), 'the mark-led opener was missed');
});

test('A4: markers on CRLF lines — the CR is set aside for the test and kept on forwarded lines', async () => {
    const served = cat(stCrlf('TAMYS_CAPTURE ci'), stCrlf('kept with its CR'), stCrlf('TAMYS_CAPTURE_END'), stCrlf('after'));
    assertSameBytes(
        await acquire(served, 'ci'),
        stCrlf('kept with its CR'),
        'a CRLF marker was missed, or its CR leaked into the section name',
    );
});

test('A4: an unterminated section still captures its tail (a job that died mid-capture)', async () => {
    const served = cat(st('before'), st('TAMYS_CAPTURE ci'), st('last gasp'), utf8(T), utf8('no terminator'));
    assertSameBytes(
        await acquire(served, 'ci'),
        cat(st('last gasp'), utf8(T), utf8('no terminator')),
        'the unterminated tail was not selected byte for byte',
    );
});

test('A4: auto selects every section in order; a named capture selects only its own', async () => {
    const served = cat(
        st('setup'),
        st('TAMYS_CAPTURE ci'),
        st('line a'),
        st('TAMYS_CAPTURE_END'),
        st('between'),
        st('TAMYS_CAPTURE release'),
        st('line b'),
        st('TAMYS_CAPTURE_END'),
    );
    assertSameBytes(await acquire(served, 'auto'), cat(st('line a'), st('line b')), 'auto lost a section or reordered');
    assertSameBytes(await acquire(served, 'release'), st('line b'), 'the named capture took the wrong section');
    await assert.rejects(acquire(served, 'nightly'), /capture section "nightly" not found/);
});

test('A4 controls: a script echo, an echoed command and TAMYS_CAPTURE_ENDX are content, never markers', async () => {
    const served = cat(
        st('##[group]Run echo "TAMYS_CAPTURE ci"'),
        st('echo TAMYS_CAPTURE ci'),
        st('##[endgroup]'),
        st('TAMYS_CAPTURE ci'),
        st('building'),
        st('TAMYS_CAPTURE_ENDX'),
        st('still inside'),
        st('TAMYS_CAPTURE_END'),
        st('outside'),
    );
    // Were either echo a marker, the section would open early and `##[endgroup]` would be
    // forwarded; were TAMYS_CAPTURE_ENDX a close, `still inside` would be lost.
    assertSameBytes(
        await acquire(served, 'ci'),
        cat(st('building'), st('TAMYS_CAPTURE_ENDX'), st('still inside')),
        'a control was read as a marker',
    );
});

// ── A5: the repeated acceptors ──────────────────────────────────────────────────────────────
//
// The Action reads the head that canon's two rows accept, `utf8-bom-line-prefix` then
// `api-rfc3339-line-prefix`, to find a marker's payload, and its obligation runs one way: it
// must accept EVERY head the rows accept, because a refused head is a missed marker and, under
// `auto`, the whole log diffed with no message. Accepting a head the rows refuse costs nothing.
//
// The table is shared by literal, not by file: the engine-side witness
// `ActionStampHeadMirror.CanonsStackPeelsEveryHeadToItsPayload` (insight-eidos,
// tamys/tests/contract/action_stamp_head_mirror_test.cpp) peels these same heads through canon's
// declared stack and asserts the payload starts right after each one. This repository is public
// and that one private, so the two hold a copy each. Two witnesses catch canon changing its
// grammar; they do NOT catch one lane editing one copy out of agreement with the other.

// The real shapes the API serves: a stamp, and a mark then a stamp on a job segment's opener.
const REAL_HEADS: ReadonlyArray<{ name: string; head: Buffer }> = [
    { name: 'stamp and one space', head: utf8(T) },
    { name: 'mark, stamp and one space', head: cat(BOM, utf8(T)) },
];

// Heads canon's rows also accept, which the API is not known to serve: the stamp row takes any
// RFC 3339 datetime exactly 28 bytes long and then strips every space and tab after it, and the
// mark row takes one mark with nothing after it.
const GRAMMAR_HEADS: ReadonlyArray<{ name: string; head: Buffer }> = [
    { name: 'stamp and three spaces', head: utf8('2026-06-21T12:19:42.7928236Z   ') },
    { name: 'stamp and a tab', head: utf8('2026-06-21T12:19:42.7928236Z\t') },
    { name: 'stamp and no separator', head: utf8('2026-06-21T12:19:42.7928236Z') },
    { name: 'stamp with a colon offset', head: utf8('2026-06-21T12:19:42.12+02:00 ') },
    { name: 'stamp with a bare offset', head: utf8('2026-06-21T12:19:42.123-0200 ') },
    { name: 'stamp with no zone and eight fraction digits', head: utf8('2026-06-21T12:19:42.12345678 ') },
    { name: 'mark, offset stamp and mixed blanks', head: cat(BOM, utf8('2026-06-21T12:19:42.12+02:00\t \t')) },
    { name: 'mark alone', head: BOM },
    { name: 'no head at all', head: Buffer.alloc(0) },
];

for (const { name, head } of [...REAL_HEADS, ...GRAMMAR_HEADS]) {
    test(`A5: a marker behind a head canon accepts is found — ${name}`, async () => {
        const served = cat(
            st('before'),
            ln(head, utf8('TAMYS_CAPTURE ci')),
            st('inside'),
            ln(head, utf8('TAMYS_CAPTURE_END')),
            st('after'),
        );
        assertSameBytes(
            await acquire(served, 'ci'),
            st('inside'),
            `the head [${head.toString('hex')}] hid the markers behind it`,
        );
    });
}

test('A5 control: after a mark with no stamp, a space is payload — the line is content, not a marker', async () => {
    // The mark row strips nothing after the mark, so canon's payload here starts with the space.
    const markThenSpace = ln(BOM, utf8(' TAMYS_CAPTURE ci'));
    const served = cat(st('TAMYS_CAPTURE ci'), markThenSpace, st('TAMYS_CAPTURE_END'));
    assertSameBytes(
        await acquire(served, 'ci'),
        markThenSpace,
        'the payload was located past the space the mark row leaves in place',
    );
});

// ── job lookup ───────────────────────────────────────────────────────────────────────────────

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

// DN-140.D4: the log's provenance is the listing row it was fetched by — its id, and its attempt
// when the row states one — returned beside the bytes, since the bytes carry neither.
test('fetchTargetJobLog: returns the job id the log was fetched by and the row\'s attempt (DN-140.D4)', async () => {
    const jobs: Job[] = [
        { id: 7, name: 'lint', status: 'completed', conclusion: 'success' },
        { id: 8, name: 'build', status: 'completed', conclusion: 'failure', run_attempt: 2 },
    ];
    const requests: DownloadRequest[] = [];
    const out = await fetchTargetJobLog(fetchParams(jobs, (jobId) => st(`log-of-job-${jobId}`), {}, requests));
    assert.equal(out.jobId, 8, `provenance names job ${out.jobId}`);
    assert.equal(requests[0]?.job_id, out.jobId, 'the declared id is the id the log was fetched by');
    assert.equal(out.runAttempt, 2);
    const unstated = await fetchTargetJobLog(fetchParams(BUILD_JOB, st('x')));
    assert.equal(unstated.runAttempt, null, 'a row stating no attempt declares none');
});

test('fetchTargetJobLog: exact name match, completed job, served bytes + conclusion returned', async () => {
    const out = await fetchTargetJobLog(fetchParams(BUILD_JOB, cat(st('hello'), st('world'))));
    assertSameBytes(out.bytes, cat(st('hello'), st('world')), 'the resolved job log was not returned whole');
    assert.equal(out.conclusion, 'success');
});

// ⚠ THIS ARM ONCE COULD NOT SEE WHICH JOB IT RESOLVED. It asserted the log against a mock that
// returned the SAME log for every `job_id`, with both fixture jobs declaring `success` — so "the
// suffix matched uniquely" was satisfied by matching the WRONG row, and by a lookup that ignored
// the name entirely. The log is keyed by id and the two candidate rows declare OPPOSITE
// conclusions, so a wrong resolution fails on two independent axes at once. Verified by mutation
// when it was repaired — inverting the lookup's precedence (rendering before exact) leaves the
// old form green and reds this one.
test('fetchTargetJobLog: the "caller / name" rendering resolves, and the EXACT name wins over it', async () => {
    // A caller workflow with its own `build` job that ALSO calls a reusable workflow exposing an
    // inner `build`. Both names are legal in one run, and that collision is the entire reason the
    // lookup tries the exact name FIRST.
    const jobs: Job[] = [
        { id: 7, name: 'ci / build', status: 'completed', conclusion: 'failure' },
        { id: 8, name: 'build', status: 'completed', conclusion: 'success' },
        { id: 9, name: 'lint', status: 'completed', conclusion: 'success' },
    ];
    const byId = (jobId: number) => st(`log-of-job-${jobId}`);

    const exact = await fetchTargetJobLog(fetchParams(jobs, byId));
    assert.equal(text(exact.bytes), `${T}log-of-job-8\n`);
    assert.equal(exact.conclusion, 'success');

    // …and with no exact job in the run, the rendering resolves — to THAT row, not merely to one.
    const rendered = await fetchTargetJobLog(
        fetchParams(
            jobs.filter((job) => job.name !== 'build'),
            byId,
        ),
    );
    assert.equal(text(rendered.bytes), `${T}log-of-job-7\n`);
    assert.equal(rendered.conclusion, 'failure');
});

test('fetchTargetJobLog: missing, ambiguous, and not-completed jobs all THROW with actionable messages', async () => {
    const none = Buffer.alloc(0);
    await assert.rejects(
        fetchTargetJobLog(fetchParams([{ id: 1, name: 'other', status: 'completed' }], none)),
        /not found in this run/,
    );
    await assert.rejects(
        fetchTargetJobLog(
            fetchParams(
                [
                    { id: 1, name: 'a / build', status: 'completed' },
                    { id: 2, name: 'b / build', status: 'completed' },
                ],
                none,
            ),
        ),
        /ambiguous/,
    );
    await assert.rejects(
        fetchTargetJobLog(fetchParams([{ id: 1, name: 'build', status: 'in_progress' }], none)),
        /has not completed .* `needs:`/,
    );
});

// ── ADR-22.D13 — the RENDERING GRAMMAR, mirrored ──────────────────────────────
//
// A reusable-workflow job renders as `"<caller job> / <inner name>"`. That grammar is
// stated ONCE (ADR-22.D13) and consumed here and in the engine, and the two consumers
// cannot share a literal: this repo is PUBLIC, the engine repo is PRIVATE, and the only
// artifact they both hold is the published binary — which carries no source text. Literal
// single-sourcing was costed and is unreachable.
//
// So the mechanism is TWO INDEPENDENT WITNESSES OVER THE SAME LITERAL EXAMPLE. The engine
// side is `TamysCrawlJobGraph.TheAnchorMatchesItsExactRenderingAndEveryFanOutRowUnderIt`,
// on these exact names, measured off a real run. If GitHub changes the rendering, both go
// red, and neither repo depends on the other to notice.
//
// ⚠ THE HONEST BOUND, AND IT MUST NOT BE SOFTENED: two witnesses catch a PLATFORM change.
// They do NOT catch one lane editing one comment out of agreement with the other — nothing
// reachable does, short of a shared artifact, which was named with its cost and refused.
// Do not describe this pair as "keeping the two repos in sync". It keeps them both honest
// about GitHub.
//
// ⚠ AND IT PINS IDENTITY, NEVER A COUNT. "one match" is satisfied by matching the WRONG
// job. Here the log is keyed by id and the two fan-out siblings declare OPPOSITE
// conclusions, so resolving the wrong one fails on both axes.

const RUST_CI_FAN_OUT: Job[] = [
    { id: 11, name: 'Lint', status: 'completed', conclusion: 'success' },
    { id: 12, name: 'unit', status: 'completed', conclusion: 'failure' },
    { id: 13, name: 'rust-ci / Format', status: 'completed', conclusion: 'success' },
    { id: 14, name: 'rust-ci / cargo shear', status: 'completed', conclusion: 'failure' },
];

function fanOutParams(jobName: string): FetchJobLogParams {
    // The log IS the identity: keyed by job_id, so the returned bytes name which row the lookup
    // actually resolved.
    return fetchParams(RUST_CI_FAN_OUT, (jobId) => st(`log-of-job-${jobId}`), { jobName, capture: 'off' });
}

test('ADR-22.D13 mirror: an inner name resolves through the "<caller> / <inner>" rendering, and it is THAT job', async () => {
    const out = await fetchTargetJobLog(fanOutParams('cargo shear'));
    // Identity, twice, on two independent axes. `rust-ci / Format` is the sibling under the
    // same anchor and declares the OPPOSITE conclusion, so a wrong pick cannot pass both.
    assert.equal(text(out.bytes), `${T}log-of-job-14\n`);
    assert.equal(out.conclusion, 'failure');
});

test('ADR-22.D13 mirror: the full rendering resolves exactly, and the separator is load-bearing', async () => {
    // The exact-name path takes precedence and lands on the same row — the anchor's own
    // rendering is a legal name in its own right.
    const exact = await fetchTargetJobLog(fanOutParams('rust-ci / Format'));
    assert.equal(text(exact.bytes), `${T}log-of-job-13\n`);
    assert.equal(exact.conclusion, 'success');

    // ⚠ AND THE GRAMMAR IS A SEPARATOR, NOT A SUFFIX. Were the fallback a bare `endsWith`,
    // any job whose name merely ENDS in the inner name would match — the fan-out would stop
    // being a declared containment and become a substring coincidence.
    await assert.rejects(fetchTargetJobLog(fanOutParams('shear')), /not found in this run/);
});

// ── The changed-path byte ceiling (the T4 cap-asymmetry repair) ──────────────
//
// The BASELINE path has been double-bounded since the adm-zip advisory; this path — the
// other half of the same diff, and the half that grows, because it is the log of the run
// happening right now — had no cap in either sourcing mode. The asymmetry WAS the bug.
// The bound counts the BYTES that arrive, before any line is selected.

// Served in 1 MiB chunks: the ceiling is 128 MiB, and the 5-byte chunks the selection arms use
// would enqueue tens of millions of them. What this pair proves is the count, not the chunking.
const CEILING_CHUNK_BYTES = 1024 * 1024;

function oversizeParams(bytes: number): FetchJobLogParams {
    return fetchParams(BUILD_JOB, Buffer.alloc(bytes, 0x78), { capture: 'off' }, [], CEILING_CHUNK_BYTES);
}

test('target-job: a log over the per-input ceiling is REFUSED, and the message names the way out', async () => {
    await assert.rejects(fetchTargetJobLog(oversizeParams(MAX_CHANGED_LOG_BYTES + 1)), (error: Error) => {
        // The number, so the user can compare it against their own `wc -c`.
        assert.match(error.message, new RegExp(String(MAX_CHANGED_LOG_BYTES)));
        // The remedy — a ceiling with no way past it reads as "unsupported".
        assert.match(error.message, /TAMYS_CAPTURE/);
        return true;
    });
});

test('target-job: exactly AT the ceiling still runs — the boundary is a capacity, not a threshold', async () => {
    // The other direction, and the one that keeps the arm above from passing vacuously: were
    // the comparison `>=`, or the constant wrong, this is what would catch it.
    const out = await fetchTargetJobLog(oversizeParams(MAX_CHANGED_LOG_BYTES));
    assert.equal(out.bytes.byteLength, MAX_CHANGED_LOG_BYTES);
    assert.equal(out.conclusion, 'success');
});

// ── The acquired grain, stated in every run log (ADR-14.D8) ──────────────────
//
// The Action promises the RUN and acquires one JOB. Until run-grain acquisition lands, each
// run log must SAY which grain it acquired — "1 job of 7" — so an operator sees the boundary
// instead of inferring it from a cross-job fold that never appears. The denominator is the
// run's own job listing (every page of it), so the count is read off the platform, never
// assumed.

test("fetchTargetJobLog: returns the resolved job name and the run's full job count", async () => {
    const jobs: Job[] = [
        { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'ci / build', status: 'completed', conclusion: 'success' },
        { id: 3, name: 'test', status: 'completed', conclusion: 'failure' },
        { id: 4, name: 'tamys', status: 'in_progress', conclusion: null },
    ];
    const out = await fetchTargetJobLog(fetchParams(jobs, st('x')));
    assert.equal(out.jobName, 'ci / build', `resolved "${out.jobName}", expected the rendered row "ci / build"`);
    assert.equal(out.runJobCount, 4, `counted ${out.runJobCount} jobs, the run lists 4 (Tamys's own included)`);
});

test('acquiredGrainLine: a target job states "1 job of N" and names what was NOT read', () => {
    assert.equal(
        acquiredGrainLine({ kind: 'job', jobName: 'build', runJobCount: 7 }),
        'Tamys: grain — acquired 1 job of the 7 this run lists ("build"); the logs of the other 6 are ' +
            'not read, so this diff covers that one job, not the whole run.',
    );
    assert.equal(
        acquiredGrainLine({ kind: 'job', jobName: 'build', runJobCount: 2 }),
        'Tamys: grain — acquired 1 job of the 2 this run lists ("build"); the log of the other 1 is ' +
            'not read, so this diff covers that one job, not the whole run.',
    );
});

test('acquiredGrainLine: a `log:` file states that no job log was acquired from the run', () => {
    assert.equal(
        acquiredGrainLine({ kind: 'file', path: 'build.log' }),
        'Tamys: grain — diffing the `log:` file "build.log"; no job log was acquired from this run, so ' +
            'this diff covers exactly what the workflow captured into that file.',
    );
});
