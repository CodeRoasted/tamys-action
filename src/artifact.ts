// Artifact transport:
//   • publishBaselineLog       — self-publishing the baseline (contract § 3, step 6),
//                                via @actions/artifact's runtime-token path.
//   • publishReport            — the full report as this run's `tamys-report-*` artifact,
//                                on every run that has one (ADR-14.D12), same path.
//   • writeRenderedComment     — `render` mode: write the escaped comment body + meta
//                                into $RUNNER_TEMP/tamys-comment/. The CONSUMER's
//                                workflow uploads that dir (actions/upload-artifact),
//                                so the unprivileged build job needs no API write.
//   • downloadRenderedComment  — `post` mode: pull that body off the TRIGGERING run
//                                via `findBy` (cross-run REST), size-bounded.

import * as core from '@actions/core';
import { DefaultArtifactClient, type ArtifactClient } from '@actions/artifact';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
    BASELINE_META_FILE,
    CONTEXT_VERSION,
    MAX_RENDERED_ARTIFACT_BYTES,
    MAX_RENDERED_BODY_BYTES,
    RENDERED_BODY_FILE,
    RENDERED_META_FILE,
    TAMYS_COMMENT_ARTIFACT_NAME,
    TAMYS_REPORT_JSON_FILE,
    TAMYS_REPORT_MARKDOWN_FILE,
    type BaselineMeta,
    type BaselineSubject,
    type RenderedCommentMeta,
} from './types.js';

// GitHub's default artifact retention (90d) bounds baseline availability; older
// base runs fall back to cold start (contract § 3, "Retention caveat").
const RETENTION_DAYS = 90;

// Publishes the ingested log, the bytes this run diffed, PLUS the stamped provenance sidecar
// (BASELINE_META_FILE) carrying this run's native CI verdict token — what the NEXT run forwards as
// `--baseline-outcome` (ADR-17.D5: the outcome-bearing fixture pins its side-input) — the stack
// those bytes were declared under, which it forwards as `--baseline-transport` (DN-89.D38), and the
// subject those bytes are, which it checks against its own (DN-160.D1 (3)). `name` has no default:
// a shared constant is how two jobs came to publish one lineage (DN-160.D1).
export async function publishBaselineLog(
    logPath: string,
    outcomeToken: string,
    transport: readonly string[],
    subject: BaselineSubject,
    name: string,
    client: Pick<ArtifactClient, 'uploadArtifact'> = new DefaultArtifactClient(),
): Promise<void> {
    const meta: BaselineMeta = {
        context_version: CONTEXT_VERSION,
        outcome_token: outcomeToken,
        transport: [...transport],
        subject: { job: subject.job, capture: subject.capture },
    };
    const metaPath = path.join(path.dirname(logPath), BASELINE_META_FILE);
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');
    await client.uploadArtifact(name, [logPath, metaPath], path.dirname(logPath), {
        retentionDays: RETENTION_DAYS,
    });
}

// Uploads the full report under `name`: the engine's report.json byte for byte, and its
// markdown as report.md when the report carries one (a reader opens it without a JSON
// viewer). It is the content the comment already projects, so it crosses no trust boundary
// the comment does not — the unprivileged fork `render` job included. The upload rides the
// same @actions/artifact client as publishBaselineLog (the runner's runtime token, never the
// `github-token`). Retention is the repository's default. Throws on failure; the caller then
// leaves the comment without a pointer to it.
export async function publishReport(
    reportJsonPath: string,
    markdown: string | undefined,
    name: string,
    client: Pick<ArtifactClient, 'uploadArtifact'> = new DefaultArtifactClient(),
): Promise<void> {
    const dir = await fs.mkdtemp(path.join(path.dirname(reportJsonPath), 'tamys-report-'));
    const jsonPath = path.join(dir, TAMYS_REPORT_JSON_FILE);
    await fs.copyFile(reportJsonPath, jsonPath);
    const files = [jsonPath];
    if (markdown !== undefined) {
        const markdownPath = path.join(dir, TAMYS_REPORT_MARKDOWN_FILE);
        await fs.writeFile(markdownPath, markdown, 'utf8');
        files.push(markdownPath);
    }
    await client.uploadArtifact(name, files, dir);
}

// ── render → post cross-boundary body (contract § 6.1) ───────────────────────

// `render` mode: write the already-escaped comment body + its head_sha provenance
// into `dir` (= $RUNNER_TEMP/tamys-comment/). The action does NOT upload — the
// consumer's `actions/upload-artifact@v4` step publishes the dir as the
// `tamys-comment` artifact (examples/fork-safe/build.yml), keeping the unprivileged
// build job free of any GitHub write.
export async function writeRenderedComment(
    body: string,
    headSha: string,
    dir: string,
    shouldPost: boolean,
): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const meta: RenderedCommentMeta = {
        context_version: CONTEXT_VERSION,
        head_sha: headSha,
        should_post: shouldPost,
    };
    await fs.writeFile(path.join(dir, RENDERED_BODY_FILE), body, 'utf8');
    await fs.writeFile(path.join(dir, RENDERED_META_FILE), JSON.stringify(meta), 'utf8');
}

export interface RenderedComment {
    body: string;
    headSha: string;
    shouldPost: boolean; // the render-side pr-comment verdict (absent in the meta ⇒ true, back-compat)
}

export interface DownloadRenderedParams {
    token: string; // needs actions:read (the privileged poster has it)
    owner: string;
    repo: string;
    workflowRunId: number; // the TRIGGERING run (github.event.workflow_run.id)
    destDir: string;
}

// Poster side: pull the rendered-body artifact off the TRIGGERING run via
// @actions/artifact `findBy` (cross-run REST). Bounds the size BEFORE downloading
// (gate on the metadata `size`), then again on the inflated body, and verifies the
// artifact digest. Returns the inert body + its stamped head_sha, or null (with a
// warning) on absence / oversize / digest mismatch — the poster then posts
// nothing. Runs no engine, parses no log.
export async function downloadRenderedComment(
    params: DownloadRenderedParams,
): Promise<RenderedComment | null> {
    const { token, owner, repo, workflowRunId, destDir } = params;
    const client = new DefaultArtifactClient();
    const findBy = {
        token,
        workflowRunId,
        repositoryOwner: owner,
        repositoryName: repo,
    };

    let artifact: { id: number; size?: number; digest?: string };
    try {
        ({ artifact } = await client.getArtifact(TAMYS_COMMENT_ARTIFACT_NAME, { findBy }));
    } catch {
        core.info(
            `Tamys poster: no "${TAMYS_COMMENT_ARTIFACT_NAME}" artifact on run ${workflowRunId} — nothing to post.`,
        );
        return null;
    }

    // Pre-download bound: refuse on the metadata size, before any bytes transfer.
    if (artifact.size !== undefined && artifact.size > MAX_RENDERED_ARTIFACT_BYTES) {
        core.warning(
            `Tamys poster: rendered artifact is ${artifact.size}B (compressed), over the ` +
                `${MAX_RENDERED_ARTIFACT_BYTES}B cap — refusing to download.`,
        );
        return null;
    }

    const { digestMismatch } = await client.downloadArtifact(artifact.id, {
        path: destDir,
        expectedHash: artifact.digest,
        findBy,
    });
    if (digestMismatch) {
        core.warning('Tamys poster: rendered artifact digest mismatch — refusing to post.');
        return null;
    }

    const body = await fs.readFile(path.join(destDir, RENDERED_BODY_FILE), 'utf8');
    // Post-inflate bound: a body over GitHub's comment limit could not post anyway.
    if (Buffer.byteLength(body, 'utf8') > MAX_RENDERED_BODY_BYTES) {
        core.warning(
            `Tamys poster: rendered body exceeds GitHub's ${MAX_RENDERED_BODY_BYTES}-char ` +
                'comment limit — refusing to post.',
        );
        return null;
    }
    const meta = JSON.parse(
        await fs.readFile(path.join(destDir, RENDERED_META_FILE), 'utf8'),
    ) as RenderedCommentMeta;
    return { body, headSha: meta.head_sha, shouldPost: meta.should_post ?? true };
}
