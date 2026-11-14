// Baseline resolution (bibles/tamys_action.md § 3) — the user is King of the
// baseline. The `baseline` input selects the source; the default (`auto`) stays
// the turnkey zero-config behavior: the latest `success` run of THIS workflow on
// the PR's base branch (push: the pushed branch; tag: the repo default branch),
// pulling its baseline-log artifact. No source ⇒ honest cold start (null).
//
// Grammar (the `baseline` input):
//   auto                — last green same-workflow run on the contextual branch
//                         (PR base / pushed branch / default branch for tag refs).
//   branch=<name>       — same resolver, explicit branch.
//   artifact=<name>     — newest non-expired artifact with that exact name,
//                         repo-wide, established by a bounded scan of every
//                         page (newestNamedArtifact). Decouples the baseline
//                         from "this workflow ran on that branch": named
//                         baselines (a main-seeded
//                         `tamys-baseline-main-build`, a per-PR
//                         `tamys-baseline-build-pr-123`) resolve from ANY event —
//                         tags and PRs included.
//   path=<file>         — a local file (self-hosted / bring-your-own baseline).
//   none                — forced cold start (seed-only runs).

import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
    BASELINE_META_FILE,
    MAX_BASELINE_ARTIFACT_BYTES,
    MAX_BASELINE_UNPACKED_BYTES,
    TRANSPORT_CATALOGUE,
    type BaselineProvenance,
    type BaselineSubject,
} from './types.js';
import { sameSubject, subjectLabel } from './subject.js';

type Octokit = ReturnType<typeof getOctokit>;

export type BaselineSpec =
    | { kind: 'auto' }
    | { kind: 'none' }
    | { kind: 'branch'; branch: string }
    | { kind: 'artifact'; name: string }
    | { kind: 'path'; file: string };

// A malformed selector is a CONFIG error — fail loud at parse time, never a
// silent fallback to auto (the caller `core.setFailed`s on the throw). Distinct
// from the API-error degrade below, which protects fork PRs' read-only tokens.
export function parseBaselineSpec(raw: string): BaselineSpec {
    const value = (raw || 'auto').trim();
    if (value === 'auto') return { kind: 'auto' };
    if (value === 'none') return { kind: 'none' };
    const eq = value.indexOf('=');
    if (eq > 0) {
        const key = value.slice(0, eq).trim();
        const arg = value.slice(eq + 1).trim();
        if (arg) {
            if (key === 'branch') return { kind: 'branch', branch: arg };
            if (key === 'artifact') return { kind: 'artifact', name: arg };
            if (key === 'path') return { kind: 'path', file: arg };
        }
    }
    throw new Error(
        `invalid \`baseline\` input "${raw}" — expected auto | none | branch=<name> | ` +
            `artifact=<name> | path=<file>`,
    );
}

// The `baseline-max-age` grammar: `<n>h` | `<n>d` (hours | days), n a positive
// integer. Empty ⇒ no bound (null). Malformed is a CONFIG error — fail loud at
// parse time, same posture as parseBaselineSpec, never a silent "unbounded".
export function parseMaxAgeHours(raw: string): number | null {
    const value = (raw || '').trim().toLowerCase();
    if (!value) return null;
    const match = /^(\d+)(h|d)$/.exec(value);
    if (!match) {
        throw new Error(
            `invalid \`baseline-max-age\` input "${raw}" — expected <n>h or <n>d (e.g. 72h, 7d), ` +
                'or empty for no bound',
        );
    }
    const amount = Number(match[1]);
    if (amount <= 0) {
        throw new Error(`invalid \`baseline-max-age\` input "${raw}" — the bound must be positive`);
    }
    return match[2] === 'd' ? amount * 24 : amount;
}

// Whole hours between the baseline's created_at stamp and `nowMs`, floored; null
// when the stamp is absent/unparseable (a `path=` baseline, a pre-sidecar
// artifact) — an UNKNOWN age is reported as unknown, never coerced to 0 (which
// would read as "fresh", the exact silent degradation this exists to kill).
export function baselineAgeHours(createdAt: string, nowMs: number): number | null {
    if (!createdAt) return null;
    const stamp = Date.parse(createdAt);
    if (Number.isNaN(stamp)) return null;
    const deltaMs = nowMs - stamp;
    if (deltaMs < 0) return 0; // clock skew between GitHub and the runner — clamp, don't go negative
    return Math.floor(deltaMs / (60 * 60 * 1000));
}

// The warning annotation for a baseline past its `baseline-max-age` bound. It states what the
// resolver SEARCHED and what that scope leaves out, never a cause it did not measure: the branch
// resolver (`auto` / `branch=`) reads one branch's runs of this workflow, so "no run re-seeded"
// is a repo-wide claim only the named-artifact resolver has measured. A `path=` baseline carries
// no stamp, so its age is unknown and never stale; its arm exists for the type's exhaustiveness.
export function staleBaselineWarning(
    meta: BaselineProvenance,
    ageHours: number,
    bound: string,
): string {
    const head = `Tamys: STALE baseline — ${ageHours}h old, past the ${bound} bound.`;
    const tail = 'This diff compares against that aged snapshot and shrinks in meaning as the gap grows.';
    switch (meta.kind) {
        case 'run': {
            const baselineName = meta.label ?? '';
            return (
                `${head} It is the \`${baselineName}\` stored by run ${meta.run_id}, the newest green run of ` +
                `this workflow on \`${meta.branch}\`. This resolver reads that branch's runs only: a ` +
                `\`${baselineName}\` stored since by a run on any other ref (a tag, another branch) is not ` +
                `considered — \`baseline: artifact=${baselineName}\` reads the newest one repo-wide. ${tail}`
            );
        }
        case 'artifact':
            return (
                `${head} It is the newest live \`${meta.label ?? ''}\` artifact in the repository, stored by ` +
                `run ${meta.run_id}: no run has stored a newer one inside the bound (under ` +
                '`publish-baseline: auto` a run whose target job is red never seeds). ' +
                tail
            );
        case 'path':
            return `${head} It is the local file \`${meta.label ?? ''}\`. ${tail}`;
    }
}

export interface ResolvedBaseline {
    logPath: string;
    meta: BaselineProvenance;
    /**
     * The baseline run's native CI verdict token, read from the artifact's stamped
     * sidecar (ADR-17.D5) — forwarded verbatim as `--baseline-outcome`. Empty when
     * the sidecar is absent (a `path=` baseline, or an artifact stamped before the
     * sidecar existed): the engine's ladder then falls to the console tail → Unknown.
     */
    outcomeToken: string;
    /**
     * The stack the stored bytes were declared under, from the sidecar, verbatim and in order —
     * forwarded as `--baseline-transport`; `[]` declares none. UNDEFINED only for a `path=`
     * baseline, whose delivery the Action does not know: that side stays undeclared and the
     * engine deduces it (DN-89.D38 §4).
     */
    transport?: readonly string[];
}

export interface ResolveParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    runId: number; // this run, to discover this workflow's id (and to never self-resolve)
    spec: BaselineSpec;
    /** Branch for `auto`: PR base / pushed branch / default branch on tag refs. */
    contextBranch: string;
    /**
     * The lineage this run belongs to: the artifact name the branch-run resolvers look for (= what
     * this pipeline publishes) and the subject the stored bytes must be. Null when this run's job
     * is not established (DN-160.D1, the unestablished job): no remote baseline is then read, and `path=` and `none`
     * are unaffected.
     */
    lineage: Lineage | null;
    workDir: string;
}

export interface Lineage {
    artifactName: string;
    subject: BaselineSubject;
}

export async function resolveBaseline(params: ResolveParams): Promise<ResolvedBaseline | null> {
    if (params.spec.kind === 'none') {
        core.info('Tamys: baseline=none — forced cold start (seed-only run).');
        return null;
    }
    if (params.spec.kind === 'path') {
        // An explicit local file is a hard contract: missing/unreadable is a config
        // error, not a cold start — the user pointed at it deliberately.
        const logPath = path.join(params.workDir, 'baseline.log');
        await fs.copyFile(params.spec.file, logPath);
        return {
            logPath,
            meta: {
                kind: 'path',
                sha: '',
                run_id: '',
                run_url: '',
                branch: '',
                created_at: '',
                label: params.spec.file,
            },
            outcomeToken: '', // no provenance sidecar for a local file — console tail / Unknown
        };
    }
    if (params.lineage === null) {
        core.info('Tamys: no baseline is read from the repository — this run\'s job is not established.');
        return null;
    }
    const lineage = params.lineage;
    // Remote resolution is ADVISORY (contract § 3, § 6 fork posture). A fork PR gets a
    // READ-ONLY token that 403s on the runs/artifacts API, and any transient API/transport
    // error must degrade to an honest cold start — NEVER fail the render/comment job (which
    // would turn a green PR red). The diff is an enhancement; its absence is a cold start,
    // not an error. The strict resolver below throws on such errors; we swallow them here.
    try {
        return await resolveRemoteStrict(params, lineage);
    } catch (error) {
        if (error instanceof BaselineRefusal) {
            core.warning(`Tamys: ${error.message} — proceeding cold start (current log only, no diff).`);
            return null;
        }
        const reason = error instanceof Error ? error.message : String(error);
        core.warning(
            `Tamys: baseline lookup failed (${reason}) — proceeding cold start (current log only, ` +
                `no diff). On a fork PR this is expected: the read-only token cannot read the ` +
                `repo's run/artifact history.`,
        );
        return null;
    }
}

// The API answered, and its answer cannot establish a baseline: the resolution refuses rather
// than guess. Distinct from an API error, whose warning explains a fork's read-only token.
class BaselineRefusal extends Error {}

// Strict resolution: THROWS on an API/transport error (the caller degrades to cold start).
// Returns null for the legitimately-empty cases (no green base run, no/expired/empty baseline
// artifact) — those are normal cold starts, distinct from an error.
async function resolveRemoteStrict(params: ResolveParams, lineage: Lineage): Promise<ResolvedBaseline | null> {
    const { octokit, owner, repo, runId, spec, contextBranch, workDir } = params;
    const { artifactName, subject } = lineage;

    if (spec.kind === 'artifact') {
        // Named baseline: the newest live artifact with that exact name, repo-wide, never one
        // this very run published (re-run safety) — established by a bounded scan.
        const scan = await newestNamedArtifact(octokit, owner, repo, spec.name, runId);
        if (scan.kind === 'refused') {
            throw new BaselineRefusal(scan.reason);
        }
        if (scan.kind === 'none') {
            core.info(`Tamys: no live \`${spec.name}\` baseline artifact in the repo yet — cold start.`);
            return null;
        }
        const producerRun = scan.artifact.workflow_run;
        const where = producerRun ? `run ${producerRun.id}` : `artifact ${scan.artifact.id}'s run`;
        const walk = await walkCandidates(octokit, owner, repo, scan.candidates, subject, true);
        const chosen = namedChoice(walk, spec.name, where, subject);
        const meta: BaselineProvenance = {
            kind: 'artifact',
            sha: producerRun?.head_sha ?? '',
            run_id: producerRun ? String(producerRun.id) : '',
            run_url: producerRun
                ? `https://github.com/${owner}/${repo}/actions/runs/${producerRun.id}`
                : '',
            branch: producerRun?.head_branch ?? '',
            created_at: chosen.candidate.artifact.created_at ?? '',
            label: spec.name,
        };
        // An artifact the listing names no producing run for has no workflow to compare: its
        // footnote carries no run either, so nothing on the report claims a same-workflow pair.
        if (producerRun?.id !== undefined) {
            const crossWorkflow = await crossWorkflowOf(octokit, owner, repo, producerRun.id, runId);
            if (crossWorkflow) meta.cross_workflow = crossWorkflow;
        }
        // A named baseline is the user's explicit choice: another job's bytes are diffed and
        // DECLARED, as another workflow's are (DN-160.D1, the stored job).
        if (!sameSubject(chosen.stored, subject)) meta.cross_subject = { baseline: chosen.stored, changed: subject };
        return { ...(await chosen.candidate.extract(workDir)), meta };
    }

    // Branch-run resolution (auto / branch=<name>): the last green run of THE SAME
    // workflow (not just any workflow) on the branch — a PR diffs against its own
    // pipeline's last green run.
    const branch = spec.kind === 'branch' ? spec.branch : contextBranch;
    const thisRun = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
    const workflowId = thisRun.data.workflow_id;

    const baseRun = await newestGreenRun(octokit, owner, repo, workflowId, branch, runId);
    if (!baseRun) {
        core.info(`Tamys: no green run of this workflow on \`${branch}\` yet — cold start.`);
        return null;
    }

    // Every live entry of the name the base run holds: a run holds one per job that stored it, and
    // one per re-run attempt of each (DN-160.D4). The listing is read by name, so one page covers
    // them unless a page cannot hold them all — then the candidates are not established.
    const { data } = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: baseRun.id,
        name: artifactName,
        per_page: ARTIFACTS_PAGE_SIZE,
    });
    if (data.total_count > data.artifacts.length) {
        throw new BaselineRefusal(
            `green base run ${baseRun.id} counts ${data.total_count} artifacts named \`${artifactName}\` and one page ` +
                `holds ${data.artifacts.length}, so its candidates cannot be established. ${SHARED_NAME_REMEDY}`,
        );
    }
    const live = data.artifacts.filter((candidate) => candidate.name === artifactName && !candidate.expired);
    if (live.length === 0) {
        core.info(
            `Tamys: green base run ${baseRun.id} has no live \`${artifactName}\` artifact ` +
                `(first adoption, or aged past retention) — cold start.`,
        );
        return null;
    }
    const where = `green base run ${baseRun.id}`;
    const walk = await walkCandidates(octokit, owner, repo, newestFirst(live, artifactName), subject, false);
    // The Action chose this pairing, so a walk that finds no entry of this job is the Action's to
    // refuse, never a diff to declare (DN-160.D1, the stored job; DN-160.D4, no match).
    if (walk.kind !== 'matched') {
        throw new BaselineRefusal(unmatchedReason(walk, artifactName, where, subject));
    }
    warnIfShared(walk, artifactName, where, subject);
    const meta: BaselineProvenance = {
        kind: 'run',
        sha: baseRun.head_sha,
        run_id: String(baseRun.id),
        run_url: baseRun.html_url,
        branch,
        // The age stamp is the STORED snapshot's, as on the named-artifact path: a run keeps its
        // `created_at` across re-runs, so the run's stamp would age a re-run's fresh bytes by the
        // gap between attempts. The run's stamp orders runs (newerFirst); it does not date bytes.
        created_at: walk.candidate.artifact.created_at ?? '',
        label: artifactName,
    };
    return { ...(await walk.candidate.extract(workDir)), meta };
}

// What a user does when two jobs meet on one baseline name (DN-160.D1, the shared-name remedy).
const SHARED_NAME_REMEDY =
    'Give each job that runs Tamys its own `baseline-name`, or leave it unset so each job derives its own; ' +
    'a matrix job whose `name:` is a literal needs the matrix value in its `name:` or in `baseline-name`';

// The most candidates one resolution downloads (DN-160.D4, the download ceiling): a bound of 4 × the compressed
// cap on the walk. Only a name two jobs share drives the walk past its first download — a re-run's
// newest entry is the job's own latest attempt.
export const MAX_LINEAGE_CANDIDATES = 4;

// The fields of an artifact the walk reads, common to the run listing and the repository listing.
interface ArtifactEntry {
    id: number;
    created_at?: string | null;
    size_in_bytes?: number;
}

// Newest first: `created_at` descending, ties to the larger id (ADR-14.D4's order). Among several,
// an entry with no parseable stamp cannot be placed, so the candidates are not established; one
// entry has no order to establish, and its unknown age is reported as unknown.
function newestFirst<T extends ArtifactEntry>(entries: readonly T[], name: string): T[] {
    if (entries.length <= 1) return [...entries];
    const stamped = entries.map((entry) => {
        const createdMs = Date.parse(entry.created_at ?? '');
        if (Number.isNaN(createdMs)) {
            throw new BaselineRefusal(
                `artifact ${entry.id} named \`${name}\` carries an unparseable created_at ` +
                    `"${String(entry.created_at)}", so the newest cannot be established`,
            );
        }
        return { entry, createdMs };
    });
    stamped.sort((left, right) => right.createdMs - left.createdMs || right.entry.id - left.entry.id);
    return stamped.map(({ entry }) => entry);
}

// One downloaded candidate: its sidecar read, its log not yet written. A candidate the walk does not
// take is dropped with its bytes, so at most one other candidate is held beside the one being read.
interface OpenedCandidate {
    artifact: ArtifactEntry;
    /** The stored subject, or null when the sidecar records none (written before 0.4.0). */
    stored: BaselineSubject | null;
    extract(workDir: string): Promise<{ logPath: string; outcomeToken: string; transport: string[] }>;
}

type Walk =
    | { kind: 'matched'; candidate: OpenedCandidate; others: BaselineSubject[] }
    | {
          kind: 'unmatched';
          /** Each downloaded candidate's stored subject, newest first, null for none recorded. */
          seen: (BaselineSubject | null)[];
          /** The newest candidate, kept only when the caller may still take it (`artifact=`). */
          newest: OpenedCandidate | null;
          /** How many candidates were never read, the ceiling having been reached. */
          unread: number;
      };

// The newest-first walk (DN-160.D4): download one candidate at a time and read its sidecar;
// the first whose subject equals this run's is the baseline, and the walk stops there. A sidecar
// with no subject never matches. `keepNewest` holds the newest candidate for a caller that may
// still take it when nothing matches; every other candidate not taken is discarded before the
// next is read.
async function walkCandidates(
    octokit: Octokit,
    owner: string,
    repo: string,
    candidates: readonly ArtifactEntry[],
    subject: BaselineSubject,
    keepNewest: boolean,
): Promise<Walk> {
    const seen: (BaselineSubject | null)[] = [];
    let newest: OpenedCandidate | null = null;
    const read = candidates.slice(0, MAX_LINEAGE_CANDIDATES);
    for (const artifact of read) {
        const opened = await openCandidate(octokit, owner, repo, artifact);
        if (opened.stored !== null && sameSubject(opened.stored, subject)) {
            return { kind: 'matched', candidate: opened, others: seen.filter((each): each is BaselineSubject => each !== null) };
        }
        seen.push(opened.stored);
        if (keepNewest && newest === null) newest = opened;
    }
    return { kind: 'unmatched', seen, newest, unread: candidates.length - read.length };
}

function distinctJobs(subjects: readonly (BaselineSubject | null)[]): BaselineSubject[] {
    const distinct: BaselineSubject[] = [];
    for (const each of subjects) {
        if (each !== null && !distinct.some((known) => sameSubject(known, each))) distinct.push(each);
    }
    return distinct;
}

// Why a walk that matched nothing is refused (DN-160.D4, the download ceiling and no match).
function unmatchedReason(
    walk: Extract<Walk, { kind: 'unmatched' }>,
    name: string,
    where: string,
    subject: BaselineSubject,
): string {
    const read = walk.seen.length;
    if (walk.unread > 0) {
        return (
            `${where} holds ${read + walk.unread} live artifacts named \`${name}\`; the Action reads at most ` +
            `${MAX_LINEAGE_CANDIDATES}, and none of those stores ${subjectLabel(subject)}. ${SHARED_NAME_REMEDY}`
        );
    }
    const stamped = distinctJobs(walk.seen);
    if (stamped.length === 0) {
        return `the ${read === 1 ? 'artifact' : `${read} artifacts`} named \`${name}\` in ${where} ${read === 1 ? 'is' : 'are'} not used: ${UNRECORDED_SUBJECT}`;
    }
    return (
        `no artifact named \`${name}\` in ${where} stores ${subjectLabel(subject)}: ${read === 1 ? 'it stores' : `the ${read} read store`} ` +
        `${stamped.map(subjectLabel).join(', ')}${stamped.length < read ? ' and a log with no job recorded' : ''}. ${SHARED_NAME_REMEDY}`
    );
}

// A match found behind another job's entry is exact, so it is used, but the shared name costs a
// download on every run and is said once (DN-160.D4, a match behind another job).
function warnIfShared(
    walk: Extract<Walk, { kind: 'matched' }>,
    name: string,
    where: string,
    subject: BaselineSubject,
): void {
    const others = distinctJobs(walk.others);
    if (others.length === 0) return;
    core.warning(
        `Tamys: the baseline name \`${name}\` is shared in ${where}: ${subjectLabel(subject)} found its own ` +
            `baseline behind the one stored by ${others.map(subjectLabel).join(', ')}. ${SHARED_NAME_REMEDY}.`,
    );
}

// `artifact=`: this job's own entry when the walk found one; else the newest, declared, when every
// candidate stamps one and the same other job; else a refusal — the user named an artifact that
// several jobs stored, or one whose job is unrecorded, and nothing says which was meant
// (DN-160.D4, no match).
function namedChoice(
    walk: Walk,
    name: string,
    where: string,
    subject: BaselineSubject,
): { candidate: OpenedCandidate; stored: BaselineSubject } {
    if (walk.kind === 'matched') {
        warnIfShared(walk, name, where, subject);
        return { candidate: walk.candidate, stored: subject };
    }
    const stamped = distinctJobs(walk.seen);
    const uniform = walk.unread === 0 && stamped.length === 1 && walk.seen.every((each) => each !== null);
    if (!uniform || walk.newest === null) {
        throw new BaselineRefusal(
            stamped.length > 1
                ? `the newest artifacts named \`${name}\` (${where}) were stored by ${stamped.map(subjectLabel).join(', ')}, ` +
                      `none of them ${subjectLabel(subject)}, so which one \`baseline: artifact=${name}\` means cannot be ` +
                      `established. ${SHARED_NAME_REMEDY}`
                : unmatchedReason(walk, name, where, subject),
        );
    }
    return { candidate: walk.newest, stored: stamped[0]! };
}

// The two workflow files when the baseline's producing run belongs to a workflow other than this
// run's, else null (DN-118.D5). Only `artifact=` reaches here: it is repo-wide by design, so it is
// the one resolver that can hand back another workflow's bytes. The engine never pairs across
// workflows (a job's reusable-call prefix is its identity, `ci / build` is not `build`), so the
// report DECLARES the pair instead. Workflows compare by `workflow_id`; the paths only name them.
// An API error here throws like every other read of the strict resolver, so the run degrades to a
// cold start with the reason: a baseline whose workflow cannot be established is never diffed
// without the declaration it may owe.
async function crossWorkflowOf(
    octokit: Octokit,
    owner: string,
    repo: string,
    producerRunId: number,
    runId: number,
): Promise<{ baseline: string; changed: string } | null> {
    const thisRun = (await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data;
    const producer = (await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: producerRunId })).data;
    if (producer.workflow_id === thisRun.workflow_id) return null;
    return { baseline: producer.path, changed: thisRun.path };
}

type ListWorkflowRuns = Octokit['rest']['actions']['listWorkflowRuns'];
type RunsQuery = NonNullable<Parameters<ListWorkflowRuns>[0]>;
type WorkflowRun = Awaited<ReturnType<ListWorkflowRuns>>['data']['workflow_runs'][number];

// The runs endpoint's largest page; one request can then be re-sorted locally.
const RUNS_PAGE_SIZE = 100;

// Newest first by `created_at`, ties broken by the higher run id. Creation, not
// `run_started_at` or `updated_at`: a re-run keeps its run id and `created_at` and moves only
// the attempt stamps, so re-running an older commit's run never displaces the green run of the
// newer commit the branch has since moved to. The baseline is the branch's newest green STATE,
// not its most recently executed attempt.
function newerFirst(left: WorkflowRun, right: WorkflowRun): number {
    const byCreation = createdMs(right) - createdMs(left);
    return byCreation !== 0 ? byCreation : right.id - left.id;
}

function createdMs(run: WorkflowRun): number {
    const stamp = Date.parse(run.created_at);
    if (Number.isNaN(stamp)) {
        throw new Error(`run ${run.id} carries an unparseable created_at "${run.created_at}"`);
    }
    return stamp;
}

// The `created` filter's documented date-time form (GitHub search syntax): seconds, explicit
// offset. Truncating a sub-second stamp floors it, which only widens the window.
function searchStamp(run: WorkflowRun): string {
    return `${new Date(createdMs(run)).toISOString().slice(0, 19)}+00:00`;
}

// The newest green run of the workflow on `branch`, or null when there is none. GitHub's
// runs endpoint takes no sort parameter and documents no ordering, so position 0 of a page
// proves nothing — the answer is ESTABLISHED here, never read off the response order.
//   1. One page at the maximum size, sorted locally. When it holds every green run
//      (`total_count` fits), its newest is the answer: one request, the common case.
//   2. Otherwise the page's own newest stamp S is a floor: the true newest run was created at
//      or after S, so the window `created >= S` contains it. One more request fetches that
//      window, and when IT fits one page its newest is the answer — two requests, exact,
//      whatever order either page arrives in. A full walk of the branch's green history would
//      cost one request per hundred runs against the token's API budget; the window does not.
//   3. A window that does not fit, or that omits the run step 1 already saw, is an answer the
//      API contradicts or cannot bound: refuse (the caller degrades to a cold start with the
//      reason), never guess a newest.
// This run is excluded throughout: a run is never its own baseline.
async function newestGreenRun(
    octokit: Octokit,
    owner: string,
    repo: string,
    workflowId: number,
    branch: string,
    runId: number,
): Promise<WorkflowRun | null> {
    const query: RunsQuery = {
        owner,
        repo,
        workflow_id: workflowId,
        branch,
        status: 'success',
        per_page: RUNS_PAGE_SIZE,
    };
    const page = (await octokit.rest.actions.listWorkflowRuns(query)).data;
    const pageNewest = [...page.workflow_runs].sort(newerFirst)[0];
    if (!pageNewest) return null;
    const candidates =
        page.workflow_runs.length >= page.total_count
            ? page.workflow_runs
            : await windowFrom(octokit, query, pageNewest);
    return candidates.filter((run) => run.id !== runId).sort(newerFirst)[0] ?? null;
}

async function windowFrom(
    octokit: Octokit,
    query: RunsQuery,
    floor: WorkflowRun,
): Promise<WorkflowRun[]> {
    const created = `>=${searchStamp(floor)}`;
    const window = (await octokit.rest.actions.listWorkflowRuns({ ...query, created })).data;
    if (window.workflow_runs.length < window.total_count) {
        throw new BaselineRefusal(
            `cannot establish the newest green run: ${window.total_count} green runs were created at or ` +
                `after ${searchStamp(floor)} and one page holds ${window.workflow_runs.length}`,
        );
    }
    if (!window.workflow_runs.some((run) => run.id === floor.id)) {
        throw new BaselineRefusal(
            `the runs API contradicts itself: run ${floor.id} (created ${floor.created_at}) is absent from ` +
                `the window created ${created}`,
        );
    }
    return window.workflow_runs;
}

type ListArtifactsForRepo = Octokit['rest']['actions']['listArtifactsForRepo'];
type RepoArtifact = Awaited<ReturnType<ListArtifactsForRepo>>['data']['artifacts'][number];

// The artifacts endpoint's largest page, and the most pages one resolution reads: at most
// 1 000 artifacts and 10 requests per run, against the token's hourly API budget.
const ARTIFACTS_PAGE_SIZE = 100;
export const MAX_ARTIFACT_PAGES = 10;

export type NamedArtifactScan =
    | {
          kind: 'found';
          artifact: RepoArtifact;
          /**
           * The live entries of the name the newest's producing run holds, newest first, the newest
           * among them — read from the scan's own pages, with no request of their own (DN-160.D4, the candidates).
           */
          candidates: RepoArtifact[];
      }
    | { kind: 'none' }
    | { kind: 'refused'; reason: string };

// The newest live artifact named `name`, never one produced by run `runId`. The endpoint takes
// `name`, `per_page` and `page` and nothing else — no sort, no `created` filter — and documents
// no order, so position 0 proves nothing and the green-run window has no equivalent here. The
// answer is ESTABLISHED: every page of the name-filtered listing is read at the maximum size and
// the entries sorted locally. Two answers are refused rather than guessed:
//   • more artifacts than MAX_ARTIFACT_PAGES pages hold — known from page 1's `total_count`;
//   • a listing that moves under the scan (`total_count` differs between pages, or a page is
//     short before it is reached): an artifact created mid-scan shifts entries across pages in an order
//     nobody documents, so a moved listing cannot prove its newest.
// `total_count` also counts expired artifacts until GitHub purges them; they are read and
// skipped like any other entry.
export async function newestNamedArtifact(
    octokit: Octokit,
    owner: string,
    repo: string,
    name: string,
    runId: number,
): Promise<NamedArtifactScan> {
    const ceiling = MAX_ARTIFACT_PAGES * ARTIFACTS_PAGE_SIZE;
    const listed: RepoArtifact[] = [];
    let expected: number | null = null;
    for (let page = 1; expected === null || listed.length < expected; page += 1) {
        const { data } = await octokit.rest.actions.listArtifactsForRepo({
            owner,
            repo,
            name,
            per_page: ARTIFACTS_PAGE_SIZE,
            page,
        });
        if (expected === null) {
            expected = data.total_count;
            if (expected > ceiling) {
                return {
                    kind: 'refused',
                    reason:
                        `${expected} artifacts named \`${name}\`; the Action reads at most ${ceiling} to ` +
                        'establish the newest. Lower the repository\'s artifact retention (Settings → ' +
                        'Actions → General) so fewer are kept, or select the baseline with `branch=<name>`',
                };
            }
        } else if (data.total_count !== expected) {
            return {
                kind: 'refused',
                reason:
                    `the artifacts named \`${name}\` moved while they were read: page 1 counted ${expected}, ` +
                    `page ${page} counts ${data.total_count}, so the newest cannot be established`,
            };
        }
        listed.push(...data.artifacts);
        // Only the last page may be short: a short page before `total_count` is reached means
        // the pages no longer tile the listing, and entries between them went unread.
        if (data.artifacts.length < ARTIFACTS_PAGE_SIZE && listed.length < expected) {
            return {
                kind: 'refused',
                reason:
                    `the listing of \`${name}\` ended after ${listed.length} of ${expected} artifacts ` +
                    `(page ${page} held ${data.artifacts.length}), so the newest cannot be established`,
            };
        }
    }
    let newest: { artifact: RepoArtifact; createdMs: number } | null = null;
    for (const artifact of listed) {
        if (artifact.expired || artifact.workflow_run?.id === runId) continue;
        const createdMs = Date.parse(artifact.created_at ?? '');
        if (Number.isNaN(createdMs)) {
            return {
                kind: 'refused',
                reason:
                    `artifact ${artifact.id} named \`${name}\` carries an unparseable created_at ` +
                    `"${String(artifact.created_at)}", so the newest cannot be established`,
            };
        }
        // Newest by `created_at`, ties broken by the larger artifact id.
        if (
            newest === null ||
            createdMs > newest.createdMs ||
            (createdMs === newest.createdMs && artifact.id > newest.artifact.id)
        ) {
            newest = { artifact, createdMs };
        }
    }
    if (newest === null) return { kind: 'none' };
    const producer = newest.artifact.workflow_run?.id;
    const siblings =
        producer === undefined
            ? [newest.artifact]
            : listed.filter((artifact) => !artifact.expired && artifact.workflow_run?.id === producer);
    return { kind: 'found', artifact: newest.artifact, candidates: newestFirst(siblings, name) };
}

// A stored baseline is the bytes its publishing run diffed, so it is comparable only beside the
// stack those bytes were declared under. A sidecar recording none — absent, unreadable, or
// written before 0.3.0 — describes bytes the old Action hand-stripped (one space removed, the
// first line's mark and every CR dropped); diffing them against canon-peeled bytes would rank the
// old defect's residue as change on every indented line. So it is NOT a baseline: one cold start
// per lineage, said why, never a failed check (DN-89.D38 §4; reading the absence as `none` was
// rejected there). A recorded stack that is not a list of catalogue names is refused the same
// way, with its own reason.
const UNRECORDED_TRANSPORT =
    'it was stored by an Action that recorded no transport for its bytes, so it is not comparable ' +
    'with this run (one cold start per baseline lineage; this run re-seeds it)';

function recordedTransport(sidecar: unknown, artifactId: number): string[] {
    const recorded =
        typeof sidecar === 'object' && sidecar !== null && !Array.isArray(sidecar)
            ? (sidecar as Record<string, unknown>)['transport']
            : undefined;
    if (recorded === undefined) {
        throw new BaselineRefusal(`baseline artifact ${artifactId} is not used: ${UNRECORDED_TRANSPORT}`);
    }
    if (
        !Array.isArray(recorded) ||
        !recorded.every((row): row is string => typeof row === 'string' && TRANSPORT_CATALOGUE.includes(row))
    ) {
        throw new BaselineRefusal(
            `baseline artifact ${artifactId} is not used: its ${BASELINE_META_FILE} records a transport ` +
                `that is not a list of catalogue rows (${JSON.stringify(recorded)}; the catalogue is ` +
                `${TRANSPORT_CATALOGUE.join(', ')})`,
        );
    }
    return recorded;
}

// A stored baseline is one job's bytes, and a lineage belongs to one job (DN-160.D1, the stored job). A sidecar
// that names no subject — written before 0.4.0, or not a job name and a capture value — cannot show
// whose bytes it describes, so it never matches: one cold start per lineage, which re-seeds it, on
// the precedent of the transport.
const UNRECORDED_SUBJECT =
    'stored by an Action that recorded no job for its bytes, so not comparable with this run (one cold ' +
    'start per baseline lineage; this run re-seeds it)';

function recordedSubject(sidecar: Record<string, unknown>): BaselineSubject | null {
    const recorded = sidecar['subject'];
    const fields =
        typeof recorded === 'object' && recorded !== null && !Array.isArray(recorded)
            ? (recorded as Record<string, unknown>)
            : {};
    const job = fields['job'];
    const capture = fields['capture'];
    return typeof job === 'string' && job !== '' && typeof capture === 'string' ? { job, capture } : null;
}

// Downloads one candidate and reads its sidecar; its log is written only by `extract`, once the
// walk takes it. The log entry is "the one file that is not the sidecar" — the artifact carries
// exactly the log and BASELINE_META_FILE. The sidecar's subject decides the walk; its transport is
// required of the candidate taken (above); its verdict token may be empty, the engine ladder's
// honest absence rung.
async function openCandidate(
    octokit: Octokit,
    owner: string,
    repo: string,
    artifact: ArtifactEntry,
): Promise<OpenedCandidate> {
    const artifactId = artifact.id;
    const artifactSize = artifact.size_in_bytes;
    // BOUND 1 — pre-download, on the METADATA, so oversized bytes never transfer. Mirrors the
    // poster's pre-download gate rather than inventing a second shape.
    if (artifactSize !== undefined && artifactSize > MAX_BASELINE_ARTIFACT_BYTES) {
        throw new Error(
            `baseline artifact ${artifactId} is ${artifactSize}B compressed, over the ` +
                `${MAX_BASELINE_ARTIFACT_BYTES}B cap — refusing to download`,
        );
    }

    const download = await octokit.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifactId,
        archive_format: 'zip',
    });

    // BOUND 2 — on the BYTES WE ACTUALLY GOT, before the parser sees them. Not redundant with
    // bound 1: `size` is absent on some listings, and this is the gate that stands between a
    // crafted archive and the allocation the advisory describes, which happens DURING parsing.
    const raw = Buffer.from(download.data as ArrayBuffer);
    if (raw.byteLength > MAX_BASELINE_ARTIFACT_BYTES) {
        throw new Error(
            `baseline artifact ${artifactId} downloaded ${raw.byteLength}B compressed, over the ` +
                `${MAX_BASELINE_ARTIFACT_BYTES}B cap — refusing to parse`,
        );
    }

    const zip = new AdmZip(raw);
    const files = zip.getEntries().filter((candidate) => !candidate.isDirectory);

    // BOUND 3 — on the DECLARED UNPACKED TOTAL, before any `getData()` expands anything. The
    // hazard is expansion ratio, so a compressed cap alone does not cover it: a small archive
    // may declare an enormous unpacked size.
    const unpacked = files.reduce((sum, candidate) => sum + (candidate.header?.size ?? 0), 0);
    if (unpacked > MAX_BASELINE_UNPACKED_BYTES) {
        throw new Error(
            `baseline artifact ${artifactId} declares ${unpacked}B unpacked across ${files.length} ` +
                `entries, over the ${MAX_BASELINE_UNPACKED_BYTES}B cap — refusing to extract`,
        );
    }
    const logEntry = files.find((candidate) => path.basename(candidate.entryName) !== BASELINE_META_FILE);
    if (!logEntry) {
        throw new Error(`baseline artifact ${artifactId} carries no log file`);
    }

    const metaEntry = files.find((candidate) => path.basename(candidate.entryName) === BASELINE_META_FILE);
    let sidecar: unknown;
    let unreadable = false;
    if (metaEntry) {
        try {
            sidecar = JSON.parse(metaEntry.getData().toString('utf8'));
        } catch {
            unreadable = true;
        }
    }
    const recorded =
        typeof sidecar === 'object' && sidecar !== null && !Array.isArray(sidecar)
            ? (sidecar as Record<string, unknown>)
            : {};
    return {
        artifact,
        stored: unreadable ? null : recordedSubject(recorded),
        async extract(workDir: string) {
            if (unreadable) {
                throw new BaselineRefusal(
                    `baseline artifact ${artifactId} is not used: its ${BASELINE_META_FILE} is unreadable, so ` +
                        UNRECORDED_TRANSPORT,
                );
            }
            const transport = recordedTransport(sidecar, artifactId);
            const logPath = path.join(workDir, 'baseline.log');
            await fs.writeFile(logPath, logEntry.getData());
            const token = recorded['outcome_token'];
            return { logPath, outcomeToken: typeof token === 'string' ? token : '', transport };
        },
    };
}
