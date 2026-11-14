// Job-log sourcing — the zero-plumbing way to feed Tamys (`target-job` input).
// Instead of tee-ing a build step into a file, a later job (`needs: <build>`)
// points Tamys at the finished job by NAME; the action downloads that job's log
// from the GitHub API AS BYTES, declares the delivery stack those bytes carry,
// and (optionally) selects the user-marked capture sections. No shell plumbing in
// the build job, and no byte of any line rewritten (DN-89.D38).
//
// THE ACTION NEVER PEELS A DELIVERY LAYER. The API stamps every line with an RFC
// 3339 time and opens each job segment with a byte-order mark; those are the
// declared stack `utf8-bom-line-prefix,api-rfc3339-line-prefix`, and the ENGINE
// peels them under that declaration (ADR-23.D8). The hand-rolled strip this file
// once carried removed one space after a stamp, dropped every CR and the first
// line's mark, and was invisible to the engine (DN-89.D38).
//
// Capture markers — plain lines the build steps emit (`echo`):
//   TAMYS_CAPTURE            open an anonymous section
//   TAMYS_CAPTURE <name>     open a named section (independent baseline lineages
//                           from one job: ci vs release, etc.)
//   TAMYS_CAPTURE_END        close the open section
// A line is a marker when its PAYLOAD is exactly one of those, the payload being
// what is left behind the delivery head (`markerPayload`). Matching is exact on the
// whole payload, so the runner's script-echo of `echo "TAMYS_CAPTURE ci"` in the
// ##[group] header can never false-match. The `capture` input selects: `auto`
// (default — if any sections exist use them all, else the whole log), `off` (whole
// log always), or a section name (only that section's parts; absent ⇒ config
// error, fail loud). A selection forwards whole lines, byte for byte, each with its
// own terminator; marker lines are not forwarded.
//
// The target job must be COMPLETED (the API serves logs for finished jobs), so
// the Tamys invocation lives in a job that `needs:` it — which is also what makes
// `changed-outcome: ${{ needs.<job>.result }}` trivial for the caller.

import type { getOctokit } from '@actions/github';
import { MAX_CHANGED_LOG_BYTES } from './types.js';

type Octokit = ReturnType<typeof getOctokit>;

// The stack an API-served job log carries, outermost first (DN-89.D36, DN-89.D38 §2). Both rows
// work line by line and the mark row declines on a line with no mark, so the declaration is
// true whether or not a mark arrived, on every job segment.
export const JOB_LOG_TRANSPORT: readonly string[] = ['utf8-bom-line-prefix', 'api-rfc3339-line-prefix'];

// ── The repeated acceptors (DN-89.D38 §3, arm A5) ──────────────────────────────────────────
//
// The head reader repeats canon's two rows in TypeScript, to find a marker's payload behind the
// head; it never removes the head. Its obligation runs ONE way: it must accept every head the
// rows accept, because a refused head is a missed marker and, under `auto`, the whole log diffed
// with no message. Accepting a head the rows refuse costs nothing — a marker never reaches the
// engine. The rows, at insight-canon `core/api/canon.transport.cppm` and the grammar's one owner
// `rfc3339_datetime_length` (`core/api/canon.api.cppm`):
//   utf8-bom-line-prefix     exactly one EF BB BF at the head, nothing stripped after it;
//   api-rfc3339-line-prefix  a full RFC 3339 datetime exactly 28 bytes long at the head, then every
//                            space and tab after it.
const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf] as const;
const STAMP_WIDTH = 28;
const STAMP_SHAPE = 'dddd-dd-ddTdd:dd:dd';
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const DOT = 0x2e;
const PLUS = 0x2b;
const MINUS = 0x2d;
const COLON = 0x3a;
const ZULU = 0x5a;

function isDigit(bytes: Uint8Array, at: number): boolean {
    const byte = bytes[at];
    return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

// The zone's byte length at `at`: 1 for `Z`, a signed `hh:mm` or `hhmm` offset's own, 0 when no
// zone starts there, and null when a signed offset is malformed.
function zoneLength(bytes: Uint8Array, at: number): number | null {
    const head = bytes[at];
    if (head === undefined) return 0;
    if (head === ZULU) return 1;
    if (head !== PLUS && head !== MINUS) return 0;
    let cursor = at + 1;
    if (!isDigit(bytes, cursor) || !isDigit(bytes, cursor + 1)) return null;
    cursor += 2;
    if (bytes[cursor] === COLON) cursor += 1;
    if (!isDigit(bytes, cursor) || !isDigit(bytes, cursor + 1)) return null;
    return cursor + 2 - at;
}

// The byte length of a complete RFC 3339 datetime starting at `start`, or 0 when none does.
function datetimeLength(bytes: Uint8Array, start: number): number {
    let at = start;
    if (at + STAMP_SHAPE.length > bytes.length) return 0;
    for (const shape of STAMP_SHAPE) {
        if (shape === 'd' ? !isDigit(bytes, at) : bytes[at] !== shape.charCodeAt(0)) return 0;
        at += 1;
    }
    if (bytes[at] === DOT) {
        const fraction = at + 1;
        let end = fraction;
        while (isDigit(bytes, end)) end += 1;
        if (end === fraction) return 0;
        at = end;
    }
    const zone = zoneLength(bytes, at);
    return zone === null ? 0 : at + zone - start;
}

// Where a line's PAYLOAD starts: past at most one byte-order mark, then, when the stamp row
// accepts the head, past the stamp and the spaces and tabs after it.
export function payloadOffset(line: Uint8Array): number {
    let at = 0;
    if (BYTE_ORDER_MARK.every((byte, index) => line[index] === byte)) at = BYTE_ORDER_MARK.length;
    if (datetimeLength(line, at) === STAMP_WIDTH) {
        at += STAMP_WIDTH;
        while (line[at] === SPACE || line[at] === TAB) at += 1;
    }
    return at;
}

// ── Lines, markers and selection ────────────────────────────────────────────────────────────

// One line of the served bytes: an LF-delimited range (getline semantics, ADR-14.D7) WITH its
// terminator, and the payload the marker test reads — the head and a trailing CR set aside.
interface ServedLine {
    bytes: Uint8Array;
    payload: string;
}

function splitLines(bytes: Uint8Array): ServedLine[] {
    const lines: ServedLine[] = [];
    let start = 0;
    while (start < bytes.length) {
        const feed = bytes.indexOf(LINE_FEED, start);
        const end = feed < 0 ? bytes.length : feed + 1;
        const line = bytes.subarray(start, end);
        let contentEnd = feed < 0 ? line.length : line.length - 1;
        if (contentEnd > 0 && line[contentEnd - 1] === CARRIAGE_RETURN) contentEnd -= 1;
        // The payload is decoded only to be COMPARED with the ASCII marker words; a decode that
        // replaces an ill-formed byte cannot make a marker of a non-marker, and the forwarded
        // bytes are the slice above, never this text.
        const payload = Buffer.from(line.subarray(payloadOffset(line), Math.max(contentEnd, 0))).toString('utf8');
        lines.push({ bytes: line, payload });
        start = end;
    }
    return lines;
}

const MARKER_OPEN = 'TAMYS_CAPTURE';
const MARKER_CLOSE = 'TAMYS_CAPTURE_END';

interface CaptureSection {
    name: string; // '' for an anonymous section
    lines: Uint8Array[];
}

function extractCaptureSections(lines: ServedLine[]): CaptureSection[] {
    const sections: CaptureSection[] = [];
    let open: CaptureSection | null = null;
    for (const line of lines) {
        if (line.payload === MARKER_OPEN || line.payload.startsWith(`${MARKER_OPEN} `)) {
            open = { name: line.payload.slice(MARKER_OPEN.length).trim(), lines: [] };
            continue;
        }
        if (line.payload === MARKER_CLOSE) {
            if (open) sections.push(open);
            open = null;
            continue;
        }
        if (open) open.lines.push(line.bytes);
    }
    // An unterminated section still counts — the job may have died mid-capture,
    // and that tail is exactly what a red-build diff needs to see.
    if (open) sections.push(open);
    return sections;
}

// `capture`: 'auto' | 'off' | <section name>. Returns the bytes to diff: the served bytes
// unchanged and unsplit when nothing is selected, else the selected lines byte for byte.
export function selectCapture(served: Uint8Array, capture: string): Uint8Array {
    const mode = capture || 'auto';
    if (mode === 'off') return served;
    const sections = extractCaptureSections(splitLines(served));
    if (mode === 'auto') {
        return sections.length === 0 ? served : Buffer.concat(sections.flatMap((section) => section.lines));
    }
    const named = sections.filter((section) => section.name === mode);
    if (named.length === 0) {
        const seen = [...new Set(sections.map((s) => s.name || '(anonymous)'))];
        throw new Error(
            `capture section "${mode}" not found in the target job's log ` +
                `(sections seen: ${seen.length ? seen.join(', ') : 'none'}). ` +
                `Emit it with \`echo "TAMYS_CAPTURE ${mode}"\` … \`echo "TAMYS_CAPTURE_END"\`.`,
        );
    }
    return Buffer.concat(named.flatMap((section) => section.lines));
}

// One row of this run's jobs listing, reduced to what the lookup reads.
export interface JobRow {
    id: number;
    name: string;
    status: string;
    conclusion?: string | null;
    run_attempt?: number;
}

export interface FetchJobLogParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    /** This run's jobs listing, every page — read once per run (`readRunJobs`, DN-160.D2). */
    jobs: readonly JobRow[];
    jobName: string;
    capture: string; // 'auto' | 'off' | <section name>
}

export interface TargetJobLog {
    /**
     * The bytes the engine diffs: the served body unchanged, or the capture's selected lines byte
     * for byte. Never decoded, never re-terminated (DN-89.D38 §1, §3).
     */
    bytes: Uint8Array;
    /** The delivery stack these bytes carry, outermost first — `--changed-transport` (DN-89.D38 §2). */
    transport: readonly string[];
    /**
     * Which listing row the bytes were fetched by, and that row's attempt — the log's provenance,
     * declared beside it as `--changed-log-job-id` / `--changed-log-attempt` (DN-140.D4). The bytes
     * carry neither. `runAttempt` is null when the row does not state one, and is then not declared.
     */
    jobId: number;
    runAttempt: number | null;
    /**
     * The target job's conclusion ('success' | 'failure' | 'cancelled' | …) — GitHub's
     * NATIVE verdict token. `changed-outcome: auto` forwards it verbatim to the engine
     * (`--changed-outcome`), which maps it through the GitHub semantic package
     * (ADR-17.D5) — the adapter never translates.
     */
    conclusion: string | null;
    /** The resolved job's name as the run lists it (a reusable-workflow row keeps its caller prefix). */
    jobName: string;
    /** Every job this run lists, across all pages — the denominator of the acquired grain. */
    runJobCount: number;
}

// What one Tamys step acquired, for the grain statement every run log carries (ADR-14.D8).
export type AcquiredGrain =
    | { kind: 'job'; jobName: string; runJobCount: number }
    | { kind: 'file'; path: string };

// The Action's contract is the diff of the RUN; what ships acquires ONE job. The line states
// the grain actually acquired — "1 job of 7" — on the info channel that already reports a
// missing permission, so the boundary is read in the log rather than inferred from a cross-job
// fold that never appears.
export function acquiredGrainLine(grain: AcquiredGrain): string {
    if (grain.kind === 'file') {
        return (
            `Tamys: grain — diffing the \`log:\` file "${grain.path}"; no job log was acquired from ` +
            'this run, so this diff covers exactly what the workflow captured into that file.'
        );
    }
    const others = grain.runJobCount - 1;
    const unread = others === 1 ? 'the log of the other 1 is' : `the logs of the other ${others} are`;
    return (
        `Tamys: grain — acquired 1 job of the ${grain.runJobCount} this run lists ("${grain.jobName}"); ` +
        `${unread} not read, so this diff covers that one job, not the whole run.`
    );
}

// Resolve the job by name within THIS run's listing and download its log. The current log
// is load-bearing (no log ⇒ no diff at all), so failures here THROW — unlike
// baseline resolution, which degrades to a cold start.
export async function fetchTargetJobLog(params: FetchJobLogParams): Promise<TargetJobLog> {
    const { octokit, owner, repo, jobs, jobName, capture } = params;
    // Exact name first; a reusable-workflow job renders under the rendering grammar ADR-22.D13
    // states (cited, never restated — tests/joblog.test.ts carries its mirror witness). The query
    // is this consumer's own: the user names the INNER job and the caller prefix is unknown here,
    // so the fallback matches by unique SUFFIX.
    let matches = jobs.filter((job) => job.name === jobName);
    if (matches.length === 0) {
        matches = jobs.filter((job) => job.name.endsWith(`/ ${jobName}`));
    }
    if (matches.length === 0) {
        throw new Error(
            `target-job "${jobName}" not found in this run (jobs: ${jobs.map((j) => j.name).join(', ')})`,
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `target-job "${jobName}" is ambiguous in this run (${matches.map((j) => j.name).join(' | ')}) — use the full job name`,
        );
    }
    const job = matches[0]!;
    if (job.status !== 'completed') {
        throw new Error(
            `target-job "${job.name}" has not completed (status: ${job.status}) — run Tamys in a job that \`needs:\` it`,
        );
    }

    // The body is requested UNPARSED, whatever content type GitHub serves: the log redirect is
    // served `text/plain`, which makes the client decode it, and a decode drops the first line's
    // mark and replaces every ill-formed byte (measured at DN-89.D38's gate G1, coderoast-corpora
    // `f7149a2`: 741 383 bytes as a string against 741 386 on the wire). A declaration describes
    // BYTES, so the bytes are what the engine receives.
    const download = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id,
        request: { parseSuccessResponseBody: false },
    });
    const served = await readServedBytes(download.data, job.name);
    return {
        bytes: selectCapture(served, capture),
        transport: JOB_LOG_TRANSPORT,
        jobId: job.id,
        runAttempt: statedAttempt(job.run_attempt),
        conclusion: job.conclusion ?? null,
        jobName: job.name,
        runJobCount: jobs.length,
    };
}

// A listing row's attempt when it states a whole one from 1, else null (nothing declared).
function statedAttempt(attempt: number | undefined): number | null {
    return typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : null;
}

function overCeiling(jobName: string, bytes: number): Error {
    return new Error(
        `the log of job "${jobName}" is ${bytes} bytes, over the ${MAX_CHANGED_LOG_BYTES} ` +
            'byte per-input ceiling Tamys declares. Bound what you compare with the ' +
            'TAMYS_CAPTURE / TAMYS_CAPTURE_END markers and set the `capture` input — a marked ' +
            'section is diffed on its own, and is usually the part you actually care about.',
    );
}

// The unparsed body as bytes, bounded WHILE it arrives: the stream is read chunk by chunk and
// cancelled the moment the count passes the per-input ceiling, so an oversized log is refused
// before it is held whole, not after. A body the client already decoded to text is refused: its
// bytes are gone, and the declaration would describe bytes the engine never receives.
async function readServedBytes(body: unknown, jobName: string): Promise<Uint8Array> {
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const bytes =
            body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        if (bytes.byteLength > MAX_CHANGED_LOG_BYTES) throw overCeiling(jobName, bytes.byteLength);
        return bytes;
    }
    if (!(body instanceof ReadableStream)) {
        throw new Error(
            `the log of job "${jobName}" arrived as ${typeof body === 'string' ? 'decoded text' : typeof body}, ` +
                'not as bytes: the request for its unparsed body was not honoured, and a decoded log ' +
                'is not the bytes its transport declaration describes',
        );
    }
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_CHANGED_LOG_BYTES) {
            await reader.cancel();
            throw overCeiling(jobName, total);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
