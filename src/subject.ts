// The subject of a diff, and the artifact names derived from it (DN-160.D1, DN-160.D2).
//
// A baseline lineage belongs to ONE job: the bytes a run stores are one job's log (one capture
// section of it), and the next run of that job must find them, never another job's. The subject is
// that job, named by its RENDERED name (DN-118.D5: the reusable-call prefix and the matrix values
// are identity), and the `capture` value that selected the bytes. The default baseline name and the
// report's name are derived from the subject plus the `comment-tag`, so two jobs that run the
// Action with no input publish two lineages; the stored sidecar carries the subject, so a pairing
// across jobs is seen when it happens anyway.
//
// Where the job comes from:
//   • `target-job` mode — the row `fetchTargetJobLog` resolved, by name.
//   • `log:` mode — this step's OWN row of the run's listing: the one row not `completed` whose
//     `runner_name` equals the runner's `RUNNER_NAME` (DN-129.D1 (2)(c)). `GITHUB_JOB` is not an
//     identity (inside a called workflow it is the callee's key, and matrix legs share it), and the
//     artifact API names no job.
// A job that cannot be established names no lineage: the run reads and writes no remote baseline,
// and uploads no report, rather than fall back to a shared constant — that fallback is the defect
// this module exists to close (DN-160.D1, the unestablished job).

import { createHash } from 'crypto';
import type { ListedJob, RunJobs } from './jobgraph.js';
import { BASELINE_ARTIFACT_PREFIX, TAMYS_REPORT_ARTIFACT_PREFIX, type BaselineSubject } from './types.js';

// Whether this run's job is named, and when it is not, why — the cause the one warning states.
export type SubjectResolution =
    | { kind: 'established'; subject: BaselineSubject }
    | { kind: 'unestablished'; cause: string };

// `log:` mode: this step's own row of the listing, by its runner.
export function ownJob(listing: RunJobs, runnerName: string | undefined): SubjectResolution {
    if (listing.kind === 'failed') {
        const message = listing.error instanceof Error ? listing.error.message : String(listing.error);
        return { kind: 'unestablished', cause: `the run's jobs listing could not be read (${message})` };
    }
    if (!runnerName) {
        return { kind: 'unestablished', cause: 'RUNNER_NAME is absent or empty, so no listing row can be matched to this step' };
    }
    const rows = listing.jobs.filter((job: ListedJob) => job.status !== 'completed' && job.runner_name === runnerName);
    if (rows.length !== 1) {
        const found = rows.length === 0 ? 'no row' : `${rows.length} rows (${rows.map((job) => `"${job.name}"`).join(', ')})`;
        return {
            kind: 'unestablished',
            cause:
                `the run's jobs listing holds ${found} not completed on runner "${runnerName}", ` +
                `where exactly one names this step's job (${listing.jobs.length} rows listed)`,
        };
    }
    return { kind: 'established', subject: { job: rows[0]!.name, capture: '' } };
}

// The one warning a run whose job is unestablished prints (DN-160.D1, the unestablished job).
export function unestablishedWarning(cause: string): string {
    return (
        `Tamys: this run's job could not be established — ${cause}. A baseline lineage belongs to one ` +
        'job, so this run reads no baseline from the repository, publishes none, and uploads no report ' +
        'artifact (a `path=` baseline still diffs). Grant the job `actions: read` so the Action can read ' +
        "the run's jobs listing."
    );
}

// The key the digest is taken over: the subject plus the comment tag, which namespaces a second
// Tamys step in one job (it already names the comment marker). The tag is in the NAME, not in the
// stored subject: it changes which comment the diff lands in, never a byte of it.
function lineageKey(subject: BaselineSubject, commentTag: string): string {
    return JSON.stringify([subject.job, subject.capture, commentTag]);
}

// Every run of characters outside this set becomes one `-`: what remains holds no character
// `@actions/artifact` rejects in a name.
const SLUG_REFUSED = /[^A-Za-z0-9._-]+/g;
const SLUG_LENGTH = 40;
const DIGEST_HEX = 16;

function trimDashes(text: string): string {
    return text.replace(/^-+|-+$/g, '');
}

// The slug is for a reader scanning the run's artifacts and identifies nothing; the digest is the
// identity. A `capture` of `auto` or `off` names no section, so it does not reach the slug.
function slugOf(subject: BaselineSubject, commentTag: string): string {
    const parts = [subject.job];
    if (subject.capture !== '' && subject.capture !== 'auto' && subject.capture !== 'off') parts.push(subject.capture);
    if (commentTag !== '') parts.push(commentTag);
    return trimDashes(trimDashes(parts.join(' ').replace(SLUG_REFUSED, '-')).slice(0, SLUG_LENGTH));
}

function derivedName(prefix: string, subject: BaselineSubject, commentTag: string): string {
    const digest = createHash('sha256').update(lineageKey(subject, commentTag), 'utf8').digest('hex').slice(0, DIGEST_HEX);
    const slug = slugOf(subject, commentTag);
    return slug === '' ? `${prefix}-${digest}` : `${prefix}-${slug}-${digest}`;
}

// The default `baseline-name`: pure and total over the key, so the same job with the same inputs
// derives the same name on every run — what lets `auto` find the previous one.
export function derivedBaselineName(subject: BaselineSubject, commentTag: string): string {
    return derivedName(BASELINE_ARTIFACT_PREFIX, subject, commentTag);
}

// The report artifact's name (ADR-14.D12), over the same key, plus the run attempt: nothing resolves
// a report by name, its one reader follows the comment's pointer, and after a re-run a name alone
// would match two reports (DN-160.D4, the report carries its attempt). An explicit `baseline-name` does not rename it.
export function derivedReportName(subject: BaselineSubject, commentTag: string, runAttempt: number): string {
    return `${derivedName(TAMYS_REPORT_ARTIFACT_PREFIX, subject, commentTag)}-${runAttempt}`;
}

// A subject as one phrase, for a refusal or a declaration: the job, and the capture when it selected
// anything other than the whole `log:` file.
export function subjectLabel(subject: BaselineSubject): string {
    return subject.capture === '' ? `job "${subject.job}"` : `job "${subject.job}" (capture: ${subject.capture})`;
}

export function sameSubject(left: BaselineSubject, right: BaselineSubject): boolean {
    return left.job === right.job && left.capture === right.capture;
}
