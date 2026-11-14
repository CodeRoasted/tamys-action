// The Action entrypoint — resolves the baseline, invokes the engine, renders the
// frame, ALWAYS writes the job summary + machine-readable outputs (so the result is
// retrievable whatever the comment config), then posts to the configured surface (PR
// sticky comment / push commit comment, each level-gated) and seeds the next baseline.
// Orchestration only; all content is the engine's and all copy is the frame's
// (bibles/tamys_action.md § 2.2 / § 3 / § 8).

import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildAnnotationCommands } from './annotations.js';
import {
    baselineAgeHours,
    parseBaselineSpec,
    parseMaxAgeHours,
    resolveBaseline,
    staleBaselineWarning,
    type BaselineSpec,
    type Lineage,
} from './baseline.js';
import { acquiredGrainLine, fetchTargetJobLog, type AcquiredGrain } from './joblog.js';
import {
    executedWorkflowCoordinate,
    readRunJobs,
    resolveBaselineJobGraph,
    resolveChangedJobGraph,
    type DeclaredJobWire,
} from './jobgraph.js';
import {
    derivedBaselineName,
    derivedReportName,
    ownJob,
    unestablishedWarning,
    type SubjectResolution,
} from './subject.js';
import { upsertStickyComment, upsertCommitComment } from './comment.js';
import { publishBaselineLog, publishReport, writeRenderedComment } from './artifact.js';
import { renderComment } from './frame.js';
import { runPoster } from './poster.js';
import { resolveTamys } from './resolve-tamys.js';
import { narrateReport, readNarrationInputs } from './narrate.js';
import { parseFailOn, runTamys } from './tamys.js';
import {
    parseCommentLevel,
    resolvedOutcomeBlocksSeeding,
    selectState,
    shouldComment,
    State,
    type CommentLevel,
} from './verdict.js';
import {
    CONTEXT_VERSION,
    MAX_CHANGED_LOG_BYTES,
    MAX_ENGINE_LINE_BYTES,
    TAMYS_COMMENT_DIR,
    type ReportArtifact,
    type TamysCommentContext,
    type TamysReport,
} from './types.js';

// Three modes (contract § 6.1):
//   comment (default) — render + post the sticky comment inline. Same-repo PRs and
//                       the proven path; the advisory gate fails the build.
//   render            — render the escaped body to $RUNNER_TEMP/tamys-comment/ and
//                       NEVER post (no write token, untrusted-parse context). The
//                       consumer's workflow uploads it; the gate does NOT fail the
//                       build (else the upload step is skipped and the comment is
//                       lost). The unprivileged fork build job.
//   post              — run NO engine: download the rendered artifact off the
//                       triggering run and upsert the comment. The privileged
//                       workflow_run poster (→ poster.ts). OFF until a consumer
//                       wires the fork topology.
type Mode = 'comment' | 'render' | 'post';
function readMode(): Mode {
    const raw = (core.getInput('mode') || 'comment').toLowerCase();
    return raw === 'render' || raw === 'post' ? raw : 'comment';
}

// The current run's NATIVE CI verdict token, verbatim (ADR-17.D5 — forwarded as
// `--changed-outcome`; the engine's dialect package maps it, the adapter never
// translates). `auto` (the default) uses the target job's own API `conclusion`
// ('success'|'failure'|'cancelled'|…) — zero caller plumbing; without a target job it
// degrades to no token (the engine's ladder falls to the console tail, then Unknown).
// Set it explicitly from `${{ needs.<job>.result }}` when sourcing via `log:`.
function readChangedOutcome(): string {
    return (core.getInput('changed-outcome') || 'auto').trim();
}

// Each comment surface carries its OWN level (no shared floor): pr-comment defaults to
// `always` (the green "✅ no change" reassurance stays); commit-comment and annotations default to
// `never`. Values: never | regression | drift | always; any other fails the run (parseCommentLevel).
function readCommentLevel(input: string, fallback: CommentLevel): CommentLevel {
    return parseCommentLevel(input, core.getInput(input), fallback);
}

// When (whether) this run PUBLISHES its log as the next baseline (the
// `create_baseline` half of "user King of the baseline"):
//   auto (default) — PRs always seed; pushes are GREEN-GATED (a red build never
//                    overwrites the last-green baseline — it still diffs against
//                    the prior green).
//   always | never — the explicit overrides.
type PublishMode = 'auto' | 'always' | 'never';
function readPublishMode(): PublishMode {
    const raw = (core.getInput('publish-baseline') || 'auto').toLowerCase();
    return raw === 'always' || raw === 'never' ? raw : 'auto';
}

// The human label of a non-default configured source, for the cold-start copy
// ("Tamys diffs each run against <source>"). Undefined for auto — the frame's
// default base-branch copy stays.
function baselineSourceLabel(spec: BaselineSpec): string | undefined {
    switch (spec.kind) {
        case 'branch':
            return `the last green run on \`${spec.branch}\``;
        case 'artifact':
            return `the \`${spec.name}\` baseline artifact`;
        case 'path':
            return `the local baseline file \`${spec.file}\``;
        default:
            return undefined;
    }
}

// Machine-readable verdict — set on EVERY run (PR or push), before any comment decision, so a
// later step can branch on Tamys's result without parsing a comment (contract § 3). The run
// verdicts are the engine-resolved class pair (UNKNOWN when unresolved) + the §6.1
// strictly-worse predicate — the same canonical fields the frame and the gate read.
function setTamysOutputs(state: State, report: TamysReport | null): void {
    core.setOutput('state', state); // cold-start | clean | drift | regression
    core.setOutput('total-changes', report?.summary.total_changes ?? 0);
    core.setOutput('significant-changes', report?.summary.significant_changes ?? 0);
    core.setOutput('regression', state === State.Regression);
    core.setOutput('baseline-outcome', report?.summary.baseline_outcome ?? 'UNKNOWN');
    core.setOutput('changed-outcome', report?.summary.changed_outcome ?? 'UNKNOWN');
    core.setOutput('outcome-regressed', report?.summary.outcome_regressed === true);
}

// Baseline-age outputs, set on every run beside the verdict outputs: '' = unknown
// (cold start, path= baseline) — never 0, which would claim "fresh".
function setBaselineAgeOutputs(ageHours: number | null, stale: boolean): void {
    core.setOutput('baseline-age-hours', ageHours ?? '');
    core.setOutput('baseline-stale', stale);
}

// A GitHub write that may be denied on a fork PR (read-only token, contract § 6) or for a missing
// scope (e.g. commit comments need contents: write). Surface it — never silently no-op — but don't
// fail the run: the exit-code gate still holds without the comment.
async function tryWrite(label: string, write: () => Promise<unknown>): Promise<void> {
    try {
        await write();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(
            `Tamys: could not ${label} (${message}). Likely a fork PR's read-only token or a missing ` +
                `scope (contract § 6) — the advisory gate still applies; the comment/baseline did not update.`,
        );
    }
}

async function run(): Promise<void> {
    const mode = readMode();
    if (mode === 'post') {
        // Privileged poster: no engine, no log — download the rendered artifact and
        // upsert the comment. Fully handled in poster.ts.
        await runPoster();
        return;
    }

    const targetJob = core.getInput('target-job');
    const logInput = core.getInput('log');
    if (!targetJob && !logInput) {
        core.setFailed(
            'Tamys needs a log to diff: set `target-job: <job name>` (zero-plumbing — run Tamys in a ' +
                'job that `needs:` it) or `log: <file>` (a log you captured yourself).',
        );
        return;
    }
    // Every enumerated input is parsed BEFORE any API work: an invalid value is a config error
    // that fails the run here, never a silent default taken after the diff has run.
    const failOn = parseFailOn(core.getInput('fail-on'));
    const rawChangedOutcome = readChangedOutcome();
    const prComment = readCommentLevel('pr-comment', 'always');
    const commitComment = readCommentLevel('commit-comment', 'never');
    // The shipped default lives in `action.yml`; this fallback only governs an invocation that
    // bypasses the manifest.
    const annotationsLevel = readCommentLevel('annotations', 'never');
    // The narration inputs, the key masked as it is read (DN-158.D4).
    const narrationInputs = readNarrationInputs();
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tamys-'));
    // This run's jobs listing, read ONCE (DN-160.D2): the target job is looked up in it, this step's
    // own job is named from it, and the changed side's graph joins the same rows.
    const listing = await readRunJobs(octokit, owner, repo, github.context.runId);
    // What this run diffs — the job and the capture — which names its baseline lineage and its
    // report (subject.ts, DN-160.D1).
    let subjectResolution: SubjectResolution;
    const changedLog = path.join(workDir, 'changed.log');
    // The native verdict token this run forwards to the engine ('' = none — the
    // engine's run-outcome ladder (ADR-17.D5) falls to the console tail, then Unknown).
    let changedOutcome = rawChangedOutcome === 'auto' ? '' : rawChangedOutcome;
    // The grain this step acquired (ADR-14.D8), stated in the grain line below.
    let grain: AcquiredGrain;
    // The delivery stack of the bytes in changed.log, declared from how they were acquired
    // (DN-89.D38): the API job-log stack for `target-job`, none for a `log:` file. It is also what
    // the published baseline records, since the baseline IS these bytes.
    let changedTransport: readonly string[];
    // Which job and attempt the changed log is, known only when this step fetched one job's log by
    // its id (DN-140.D4); a `log:` file declares neither.
    let changedLogProvenance: { jobId: number; attempt: number | null } | undefined;
    if (targetJob) {
        // Zero-plumbing sourcing: pull the finished build job's log off the API as
        // BYTES (run Tamys in a job that `needs:` it), its delivery stack declared,
        // capture sections selected. Load-bearing — a failure here fails the step (the
        // caller's continue-on-error keeps the advisory guarantee).
        const capture = core.getInput('capture') || 'auto';
        if (listing.kind === 'failed') {
            const message = listing.error instanceof Error ? listing.error.message : String(listing.error);
            throw new Error(`target-job "${targetJob}" cannot be looked up: the run's jobs listing could not be read (${message})`);
        }
        const jobLog = await fetchTargetJobLog({
            octokit,
            owner,
            repo,
            jobs: listing.jobs,
            jobName: targetJob,
            capture,
        });
        subjectResolution = { kind: 'established', subject: { job: jobLog.jobName, capture } };
        await fs.writeFile(changedLog, jobLog.bytes);
        changedTransport = jobLog.transport;
        changedLogProvenance = { jobId: jobLog.jobId, attempt: jobLog.runAttempt };
        if (rawChangedOutcome === 'auto') {
            changedOutcome = jobLog.conclusion ?? ''; // GitHub's native token, verbatim
        }
        core.info(
            `Tamys: sourced the log from job "${targetJob}" (capture: ${capture}, changed-outcome: ${changedOutcome || '(none)'}).`,
        );
        grain = { kind: 'job', jobName: jobLog.jobName, runJobCount: jobLog.runJobCount };
    } else {
        // Bounded off the filesystem, before the copy — the cheapest possible refusal, and the
        // one place where the size is known without reading anything. The engine refuses this
        // same input at exit 3 regardless; catching it here saves the copy and lets the message
        // name the `log:` input the user actually wrote.
        const logStat = await fs.stat(logInput);
        if (logStat.size > MAX_CHANGED_LOG_BYTES) {
            core.setFailed(
                `Tamys: the \`log:\` input "${logInput}" is ${logStat.size} bytes, over the ` +
                    `${MAX_CHANGED_LOG_BYTES} byte per-input ceiling. Check it with \`wc -lc\` ` +
                    '(the engine also enforces a 1000000-line ceiling and a ' +
                    `${MAX_ENGINE_LINE_BYTES}-byte per-line ceiling). Capture less: ` +
                    'tee only the part of the build you want compared, or use `target-job` with ' +
                    'the TAMYS_CAPTURE markers.',
            );
            return;
        }
        await fs.copyFile(logInput, changedLog); // the captured current-run log = changed.log
        // A file the workflow wrote carries no delivery layer (ADR-14.D9): declared none.
        changedTransport = [];
        grain = { kind: 'file', path: logInput };
        // A `log:` file is this step's own job's bytes: its row is found by its runner.
        subjectResolution = ownJob(listing, process.env.RUNNER_NAME);
    }
    core.info(acquiredGrainLine(grain));

    // PR vs push differ ONLY in the comment surface (sticky vs commit), its level, the baseline
    // branch, and the head sha. The diff, the job summary, the outputs, and the gate are shared.
    const pr = github.context.payload.pull_request;
    const isTagRef = github.context.ref.startsWith('refs/tags/');
    // The contextual branch for `auto` baseline resolution: the PR's base, the pushed
    // branch — or, on a TAG ref (no branch to resolve against), the repo's default
    // branch, so a tag-on-main run diffs against main's last green out of the box.
    const defaultBranch =
        (github.context.payload.repository?.default_branch as string | undefined) ?? 'main';
    const baseBranch = pr
        ? (pr.base.ref as string)
        : isTagRef
          ? defaultBranch
          : github.context.ref.replace(/^refs\/heads\//, '');
    const headSha = pr ? (pr.head.sha as string) : github.context.sha;

    // Baseline selection + publication — the user is King of the baseline. A malformed
    // selector throws here (config error → failed run), never a silent auto fallback.
    const baselineSpec = parseBaselineSpec(core.getInput('baseline'));
    const publishMode = readPublishMode();
    const commentTag = core.getInput('comment-tag') || undefined;
    // The lineage: an explicit `baseline-name` verbatim (the user is King of the baseline), else the
    // name derived from the subject; the report's name is always derived. A run whose job is not
    // established has neither, and says why once (DN-160.D1, the unestablished job).
    let lineage: Lineage | null = null;
    let reportName: string | null = null;
    if (subjectResolution.kind === 'established') {
        const { subject } = subjectResolution;
        lineage = {
            artifactName: core.getInput('baseline-name') || derivedBaselineName(subject, commentTag ?? ''),
            subject,
        };
        // The runner states the attempt; a run that does not cannot name its report apart from another
        // attempt's, so it uploads none and says so.
        const runAttempt = github.context.runAttempt;
        if (Number.isSafeInteger(runAttempt) && runAttempt >= 1) {
            reportName = derivedReportName(subject, commentTag ?? '', runAttempt);
        } else {
            core.warning(
                `Tamys: GITHUB_RUN_ATTEMPT is not a run attempt ("${process.env.GITHUB_RUN_ATTEMPT ?? ''}"), so the ` +
                    'report artifact cannot be named apart from another attempt\'s and is not uploaded.',
            );
        }
        core.info(
            `Tamys: this run diffs job "${subject.job}"${subject.capture ? ` (capture: ${subject.capture})` : ''}; ` +
                `its baseline lineage is \`${lineage.artifactName}\`` +
                (reportName === null ? '.' : `, its report artifact \`${reportName}\`.`),
        );
    } else {
        core.warning(unestablishedWarning(subjectResolution.cause));
    }

    // The staleness bound (parsed BEFORE resolution — a malformed bound is a config
    // error and must fail before any API work, like a malformed baseline selector).
    // The manifest ships `72h`; an empty value disables the bound entirely.
    const maxAgeRaw = core.getInput('baseline-max-age');
    const maxAgeHours = parseMaxAgeHours(maxAgeRaw);

    const baseline = await resolveBaseline({
        octokit,
        owner,
        repo,
        runId: github.context.runId,
        spec: baselineSpec,
        contextBranch: baseBranch,
        lineage,
        workDir,
    });

    // Baseline age — measured here (envelope side) so the frame stays pure. Over a
    // red streak the green-gated re-seed stops and the baseline ages without limit;
    // the report then degrades exactly when it is most needed. The age is ALWAYS
    // surfaced (footnote + output); the bound turns "old" into a loud STALE banner
    // plus a warning annotation — never a silent degrade, and never a FAILED step:
    // we cannot assume a consumer's build cadence, so a repo that ships weekly is
    // not misconfigured and an instrument that reds its build is wrong about its
    // own subject. The bound WARNS; `fail-on` remains the only failing axis.
    const ageHours = baseline ? baselineAgeHours(baseline.meta.created_at, Date.now()) : null;
    const baselineStale =
        baseline != null && maxAgeHours != null && ageHours != null && ageHours > maxAgeHours;
    if (baselineStale) {
        core.warning(staleBaselineWarning(baseline.meta, ageHours, maxAgeRaw));
    } else if (maxAgeHours != null && baseline && ageHours == null) {
        core.warning(
            `Tamys: baseline-max-age=${maxAgeRaw} is set but the resolved baseline carries no ` +
                'created_at stamp (a `path=` baseline or a pre-sidecar artifact) — the bound cannot be ' +
                'checked. The age is UNKNOWN, not fresh.',
        );
    }

    const context: TamysCommentContext = {
        context_version: CONTEXT_VERSION,
        head_sha: headSha,
        pr_number: pr ? (pr.number as number) : undefined,
        base_branch: baseBranch,
        baseline: baseline?.meta,
        baseline_source: baselineSourceLabel(baselineSpec),
        comment_tag: commentTag,
        baseline_age_hours: ageHours ?? undefined,
        baseline_age_bound: maxAgeHours != null ? maxAgeRaw.trim() : undefined,
        baseline_stale: baselineStale || undefined,
    };

    // Diff — or cold start (contract § 3): no baseline ⇒ the engine is NOT invoked.
    let gateExit = 0;
    let report: TamysReport | null = null;
    let narrationHost: string | undefined;
    const reportJsonPath = path.join(workDir, 'report.json');
    if (baseline) {
        const tamysBin = await resolveTamys(core.getInput('tamys-binary'), workDir);
        // The CHANGED run's declared job graph (jobgraph.ts — the ADR-22.D13 wire), read at every
        // grain. Each job's declared conclusion frames the rows of that job (DN-89.D15), and a
        // listed step the platform declares failed is named on its job's row (DN-140.D5); both are
        // correct on one job's log. The `needs:` fold needs rows from two jobs, and the engine
        // refuses a fold whose aggregator and member claim one row (DN-118.O3), so a one-job diff
        // mints no fold row — the reason DN-118.D4's gate on this read was withdrawn once the
        // pinned engine carried that refusal. Fail-soft: acquisition failure ⇒ null ⇒ no flag,
        // with the reason logged, and the run is untouched.
        //
        // The file is read where the RUNNER says the run loaded it, never at a ref taken from the
        // event payload: a PR's base is not the executed file on `pull_request` (the merge commit
        // is), and the executed file is the trusted one on every event. The argument, and the
        // refusal of any fallback, live at `executedWorkflowCoordinate` (ADR-22.D17).
        const changedJobGraph = await resolveChangedJobGraph({
            octokit,
            owner,
            repo,
            listing,
            workflow: executedWorkflowCoordinate(process.env),
            info: core.info,
        });
        // The BASELINE run's declared job graph, when the baseline came from a run (a `path=` file
        // names none): read after the fact at that run's own executed commit and attempt, so each
        // side's step banners are classed by that side's own declared texts (DN-89.D34).
        const baselineRunId = Number(baseline.meta.run_id);
        let baselineJobGraph: DeclaredJobWire[] | null = null;
        if (baseline.meta.kind !== 'path' && Number.isSafeInteger(baselineRunId) && baselineRunId > 0) {
            baselineJobGraph = await resolveBaselineJobGraph({ octokit, owner, repo, baselineRunId, info: core.info });
        } else {
            core.info('Tamys: no baseline job graph — the baseline names no run it was published by.');
        }
        const result = await runTamys({
            tamysBin,
            baselineLog: baseline.logPath,
            changedLog,
            baselineLabel: baseline.meta.sha.slice(0, 7),
            changedLabel: headSha.slice(0, 7),
            baselineOutcome: baseline.outcomeToken,
            changedOutcome,
            failOn,
            outputPath: reportJsonPath,
            changedTransport,
            baselineTransport: baseline.transport,
            changedLogProvenance,
            changedJobGraph: changedJobGraph
                ? { path: path.join(workDir, 'changed-job-graph.json'), jobs: changedJobGraph }
                : undefined,
            baselineJobGraph: baselineJobGraph
                ? { path: path.join(workDir, 'baseline-job-graph.json'), jobs: baselineJobGraph }
                : undefined,
        });
        gateExit = result.exitCode;
        // The optional narrative, drawn by a second process over the report the diff process
        // just wrote and readReport validated; the key never enters the diff process (DN-158.D4).
        const narrated = await narrateReport({
            mode,
            inputs: narrationInputs,
            tamysBin,
            reportPath: reportJsonPath,
            outputPath: path.join(workDir, 'narrative.md'),
            report: result.report,
        });
        report = narrated.report;
        narrationHost = narrated.host;
    } else {
        core.info(`Tamys: cold start — no baseline on \`${baseBranch}\` yet.`);
    }
    // The full report as this run's artifact, on every run that has one, BEFORE the comment is
    // rendered: the comment names the artifact only once it exists, so a failed upload leaves a
    // comment without the pointer, never a pointer to nothing. A failure is a warning, never a
    // failed step — the comment, summary and gate do not depend on it.
    let reportArtifact: ReportArtifact | undefined;
    if (report && reportName !== null) {
        const name = reportName;
        try {
            await publishReport(reportJsonPath, report.markdown, name);
            reportArtifact = {
                name,
                run_url: `${github.context.serverUrl}/${owner}/${repo}/actions/runs/${github.context.runId}`,
            };
            core.info(`Tamys: uploaded the full report as the \`${name}\` artifact.`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            core.warning(
                `Tamys: could not upload the \`${name}\` report artifact (${message}). The comment ` +
                    'does not point at it; the full report is still this step\'s `report-path` output.',
            );
        }
    }
    const body = renderComment(report, { ...context, report_artifact: reportArtifact, narration_host: narrationHost });
    const state = selectState(report);

    // ALWAYS retrievable: the job summary + machine-readable outputs are written every run,
    // before any comment decision — so the result is in the job info whatever the comment config.
    await core.summary.addRaw(body).write();
    setTamysOutputs(state, report);
    setBaselineAgeOutputs(ageHours, baselineStale);

    // Expose the deterministic report.json on a STABLE, cross-step path (workDir is an
    // mkdtemp that's gone after this step). A later step on the SAME runner can then
    // narrate it via `tamys explain --report` — so the narrative explains THIS run's real
    // diff, not a re-diff against an empty baseline (the §3.6 decoupled-narration seam).
    // §3.6-safe: report.json is exactly the content already in the comment/summary — no
    // credential, no courtesy. Empty `report-path` on cold start (no report produced).
    let reportPathOut = '';
    if (report) {
        reportPathOut = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tamys-report.json');
        await fs.copyFile(reportJsonPath, reportPathOut);
    }
    core.setOutput('report-path', reportPathOut);

    // Inline check-run annotations (bibles/tamys_action.md § 3.1, ADR-14): emit the
    // level-gated `::error|warning|notice::` workflow commands on stdout. They carry no write
    // token, so this fires in BOTH the inline `comment` job and the UNPRIVILEGED fork `render`
    // job (mode=post returned at the top — no report), surfacing drift on a fork PR's checks
    // where GitHub's failure-explain is silent. The encode in annotations.ts is the trust
    // boundary; nothing privileged happens here. Own axis, DEFAULT `never`: three renderings of
    // one result is two too many, and annotations compete with the compiler's own in the gutter
    // where a real build error must stay findable. The capability is whole and one input away
    // (`annotations: drift`).
    for (const command of buildAnnotationCommands(report, annotationsLevel)) {
        process.stdout.write(`${command}\n`);
    }

    // One seeding rule for BOTH modes (the `create_baseline` half): `auto` keeps
    // the proven semantics — PRs always seed, pushes/tags are verdict-gated,
    // class-aware (ADR-17.D5): a run the ENGINE resolved as FAILURE, UNSTABLE,
    // or incomplete (ABORTED, CANCELLED) never overwrites the last-good baseline. Unknown stays
    // permissive (no signal ≠ bad — the `log:`-input path without outcome wiring
    // must keep seeding, exactly as the old 'unknown' did). On a cold start (no
    // report) the native token is the only signal: GitHub's own 'success' is the
    // one token this GitHub adapter reads for its OWN seeding decision — the
    // engine-facing verdict always goes through the engine.
    const badResolvedOutcome =
        report != null && resolvedOutcomeBlocksSeeding(report.summary.changed_outcome);
    const badColdStartToken =
        report == null && changedOutcome !== '' && changedOutcome.toLowerCase() !== 'success';
    const runOutcomeBad = badResolvedOutcome || badColdStartToken;
    const shouldSeed =
        publishMode === 'always' ? true : publishMode === 'never' ? false : pr ? true : !runOutcomeBad;
    // Seeds the lineage under its name with the subject stamped. A run whose job is not established
    // has no lineage and seeds nothing; its warning already said so (DN-160.D1, the unestablished job).
    const seed = async (): Promise<void> => {
        if (lineage === null) return;
        const { artifactName, subject } = lineage;
        if (!shouldSeed) {
            core.info(
                `Tamys: publish-baseline=${publishMode}${runOutcomeBad ? ' (run verdict not SUCCESS)' : ''} — kept ` +
                    `the previous \`${artifactName}\` baseline (did not re-seed).`,
            );
            return;
        }
        await tryWrite('publish the baseline artifact', () =>
            publishBaselineLog(changedLog, changedOutcome, changedTransport, subject, artifactName),
        );
    };

    if (mode === 'render') {
        // Fork build job (contract § 6.1): write the escaped body for the workflow_run poster; NEVER
        // post or fail the build from here. The fork build is always a PR, so gate on `pr-comment` and
        // STAMP the verdict into the artifact — the poster honours it, so pr-comment controls fork-PR
        // comments exactly like inline ones (no shared floor; render always writes so the upload never
        // errors — the poster simply skips when the flag is false).
        const shouldPost = shouldComment(state, prComment);
        const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
        const commentDir = path.join(runnerTemp, TAMYS_COMMENT_DIR);
        await writeRenderedComment(body, headSha, commentDir, shouldPost);
        core.info(`Tamys: render mode — wrote the comment body (pr-comment=${prComment} ⇒ post=${shouldPost}); the workflow uploads it.`);
        await seed();
        return;
    }

    // Comment surface, level-gated. Below the level ⇒ no comment — the result is still in the job
    // summary + outputs above. Each surface has its own level (req: no shared floor).
    if (pr) {
        if (shouldComment(state, prComment)) {
            await tryWrite('post the PR comment', () =>
                upsertStickyComment({ octokit, owner, repo, prNumber: pr.number as number, body }),
            );
        } else {
            core.info(`Tamys: pr-comment=${prComment} — verdict ${state} below threshold, no comment (result in the job summary).`);
        }
    } else if (shouldComment(state, commitComment)) {
        await tryWrite('post the commit comment (needs contents: write)', () =>
            upsertCommitComment({ octokit, owner, repo, commitSha: headSha, body }),
        );
        core.info(`Tamys: push — commit comment upserted on ${headSha.slice(0, 7)} (commit-comment: ${commitComment}).`);
    } else {
        core.info(`Tamys: push — commit-comment=${commitComment}, verdict ${state} below threshold (result in the job summary).`);
    }

    // Seed the next baseline under the lineage's name (rule computed above).
    await seed();

    // Advisory gate (contract § 8): the exit code carries the verdict; the comment never says "we
    // blocked your merge". Applies to PR and push alike; render mode returned above (failing it
    // would skip the consumer's artifact upload, losing the rendered comment).
    if (gateExit !== 0) {
        core.setFailed(`Tamys gate (--fail-on ${failOn}) tripped — see the comment / job summary for what changed.`);
    }
}

run().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
});
