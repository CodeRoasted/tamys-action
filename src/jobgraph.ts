// The CHANGED run's declared `needs:` job graph — this Action's producer of the ADR-22.D13
// wire (`--changed-job-graph`, a JSON file behind a flag). The engine folds a required-check
// aggregator row into the member that actually failed, but only from a DECLARED graph: `needs:`
// is a static list in the workflow file that cannot carry expressions, which is what makes the
// edge a declaration rather than a guess (ADR-22.D5 — acquisition derives, never infers).
//
// The acquisition mirrors the crawler's (insight-eidos tamys/src/crawl/job_graph.cpp) because the
// two are the SAME producer contract over different transports, and a divergence between them
// would be a silent fork of one wire. Same rules, stated where they bind below: verbatim `name:`,
// the exactly-one conclusion refusal, key-less quoted renderings, and the jobs listing read on
// every workflow, edge or none.
//
// THE RENDERING GRAMMAR IS STATED HERE ONCE IN TYPESCRIPT (DN-127.D1): the separator, the matrix-leg
// opener, the expression delimiters, the one template matcher and its guard, and the reach under the
// collision refusal. Its C++ statement is insight-eidos `tamys/src/job_rendering.hpp`; one case table,
// copied byte for byte into both repositories (here `tests/fixtures/job_rendering_cases.json`) and
// compared by a superproject check, keeps the two one rule.
//
// ⚠ WHY js-yaml AND NOT A SUBSET PARSER OF OUR OWN — the choice IS the point. The input is a
// workflow file a contributor can influence, and a hand-rolled reader would be a second reader of
// a format we do not own, over hostile-capable bytes, inside the one path whose whole
// justification is "declarations and no heuristic". js-yaml v4's `load` uses the expression-free
// default schema (no code execution, no !!js types), and the bytes arrive under the contents
// API's own response cap.
//
// READ AT EVERY GRAIN. The graph has three readers in the engine: the job-grain claim frame (a
// row's own job's declared conclusion, DN-89.D15), step naming (a listed step declared failed,
// named on its job's row, DN-140.D5), and the `needs:` fold. The first two are correct on one
// job's log. The fold needs rows from two jobs, and the engine refuses a fold whose aggregator and
// member claim one row (DN-118.O3, part 3), so a `target-job` diff mints no fold row; DN-118.D4
// kept the read off that grain until the pinned engine carried that refusal, and is withdrawn.
//
// FAIL-SOFT BY DESIGN, and absent ≠ empty: every acquisition failure (no runner coordinate for the
// executed workflow file, an unreadable file, a denied `contents: read`, a failed jobs listing) resolves to ABSENT — no flag,
// fold inert, run unaffected — with one log line naming the reason, because a fold that silently
// stopped firing reads exactly like a clean run. A workflow that genuinely declares zero jobs is
// DECLARED-EMPTY (`[]`), a different fact the engine acts on.

import type { getOctokit } from '@actions/github';
import { load, YAMLException } from 'js-yaml';

type Octokit = ReturnType<typeof getOctokit>;

// One declared step's text on the wire: its `run:` text WHOLE and verbatim, or its `uses:`
// reference (DN-89.D34). The engine cuts a `run:` text's first line itself, so this producer holds
// no spelling of the expression delimiters for it.
export type DeclaredStep = { run: string } | { uses: string };

// One job as the workflow file declares it (pre-join): the mapping key, the verbatim `name:`,
// the `needs:` edges by key, its two species — `callsWorkflow` true exactly when the body
// declares a job-level `uses:` (DN-118.O3), `declaresMatrix` true exactly when it declares
// `strategy.matrix`, whatever its value (DN-127.D1) — and its declared steps in document order.
export interface DeclaredJobRecord {
    key: string;
    name: string;
    needs: string[];
    callsWorkflow: boolean;
    declaresMatrix: boolean;
    steps: DeclaredStep[];
}

// One step as the run's listing row lists it (the REST job object's `steps[]`): the platform's
// number, its rendered name, its native conclusion (`null` while not concluded) and its two RFC 3339
// times (`null` when the row carries none).
export interface ListingStep {
    number: number;
    name: string;
    conclusion: string | null;
    started_at?: string | null;
    completed_at?: string | null;
}

// One job as the run's listing renders it — the REST job object, reduced to what the wire states
// and what decides a state: the row's identity at its attempt (`id`, `run_attempt`), the platform's
// own name and NATIVE conclusion (`null` while the job has not concluded), the steps it RAN, and the
// two runner fields, read only to decide `listed_steps`' state and never shipped (DN-140.D3).
export interface RenderedJob {
    id: number;
    name: string;
    conclusion: string | null;
    run_attempt?: number;
    steps?: ListingStep[];
    runner_id?: number | null;
    runner_name?: string | null;
}

// A conclusion the producer WITHHOLDS, with the reason it states (DN-89.D26). `listing_not_read` is
// the fourth reason on the wire and this producer never writes it: the Action reads the listing
// whenever the workflow file resolved, and a failed listing makes the whole graph ABSENT.
export type WithheldConclusion = { withheld: 'no_rendering' | 'concluded_per_rendering' | 'not_concluded' };

// A job's or a listed step's conclusion on the wire: the platform's native token verbatim, or
// withheld with its reason. The empty string is never written — it is the silence DN-89.D26 refuses.
export type WireConclusion = string | WithheldConclusion;

// One listed step on the wire, exactly five members (DN-140.D2). Times are whole seconds since the
// Unix epoch, UTC, or withheld `not_timed` when the row carries none or carries one this producer
// does not convert.
export interface WireListedStep {
    number: number;
    name: string;
    conclusion: string | { withheld: 'not_concluded' };
    started_at: number | { withheld: 'not_timed' };
    completed_at: number | { withheld: 'not_timed' };
}

// A rendering's `listed_steps` in the three states a LIVE producer writes (DN-140.D3): the steps the
// row lists, `[]` when it lists none and no runner was assigned (no step can have run), or withheld
// `emptied_by_platform` when it lists none though a runner was assigned. The fourth state,
// `not_acquired`, belongs to re-spelled corpus graphs; a live producer writing it is a defect.
export type WireListedSteps = WireListedStep[] | { withheld: 'emptied_by_platform' };

// The ADR-22.D13 wire entry for a DECLARATION. ALL SEVEN FIELDS ALWAYS TRAVEL — `key` and `display`
// are required by the engine and never defaulted from each other (a graph keyed on the wrong
// coordinate folds nothing and reads exactly like a clean run). `display` is the declaration's
// anchor, resolved or not, and the engine refuses an empty one (DN-127.D7). `conclusion` is stated
// or withheld with its reason (DN-89.D26). `calls_workflow`, `declares_matrix` and `declared_steps`
// are required here and refused on a rendering, each violation an engine wiring error (DN-118.O3,
// DN-127.D1, DN-89.D34); `declared_steps` names its provenance, the workflow file, so it is never
// read as the listing's steps (DN-140.D2).
export interface DeclaredJobEntry {
    key: string;
    display: string;
    needs: string[];
    conclusion: WireConclusion;
    calls_workflow: boolean;
    declares_matrix: boolean;
    declared_steps: DeclaredStep[];
}

// The wire entry for a RENDERING the listing quoted: an empty `key`, no species, because a
// rendering is not a declaration, and the three members only a rendering carries — the listing
// row's `job_id`, its `run_attempt` and its `listed_steps` (DN-140.D2), each refused on a keyed
// entry. Its conclusion is stated, or withheld `not_concluded`, the one reason a rendering may carry.
export interface RenderedJobEntry {
    key: '';
    display: string;
    needs: string[];
    conclusion: string | { withheld: 'not_concluded' };
    job_id: number;
    run_attempt: number;
    listed_steps: WireListedSteps;
}

export type DeclaredJobWire = DeclaredJobEntry | RenderedJobEntry;

// Whether a graph states a verdict the engine must interpret through a vocabulary: a stated job
// conclusion on any entry (`job`), or a stated listed-step conclusion on a rendering (`step`). A
// graph whose every conclusion is withheld states none and needs no vocabulary (ADR-22.D10).
export function statesAJobConclusion(jobs: readonly DeclaredJobWire[]): boolean {
    return jobs.some((job) => typeof job.conclusion === 'string');
}

export function statesAListedStepConclusion(jobs: readonly DeclaredJobWire[]): boolean {
    return jobs.some(
        (job) =>
            'listed_steps' in job &&
            Array.isArray(job.listed_steps) &&
            job.listed_steps.some((step) => typeof step.conclusion === 'string'),
    );
}

// The reusable-workflow rendering separator (arm R, ADR-22.D13), the platform's matrix-leg opener
// (arm M), and the delimiters of one expression span: a span opens at `${{` and closes at the
// first `}}` after it, and an opener no closer follows is literal bytes (DN-127.D1).
const REUSABLE_SEPARATOR = ' / ';
const MATRIX_LEG_OPENER = ' (';
const EXPRESSION_OPEN = '${{';
const EXPRESSION_CLOSE = '}}';

// The four arms of DN-127.D1, in the order a declaration's claim is named.
export type Arm = 'E' | 'R' | 'M' | 'T';

// One declaration as the grammar reads it: its anchor (the declared `name:`, else its key) and its
// two species.
export interface Declaration {
    anchor: string;
    callsWorkflow: boolean;
    declaresMatrix: boolean;
}

// One declaration reaching one rendering: its index in the declarations read, and the arm.
export interface Reach {
    declaration: number;
    arm: Arm;
}

// A text's expression spans, as [start, end) pairs, in order.
function expressionSpans(text: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    let at = 0;
    for (;;) {
        const open = text.indexOf(EXPRESSION_OPEN, at);
        if (open < 0) return spans;
        const close = text.indexOf(EXPRESSION_CLOSE, open + EXPRESSION_OPEN.length);
        if (close < 0) return spans;
        spans.push([open, close + EXPRESSION_CLOSE.length]);
        at = close + EXPRESSION_CLOSE.length;
    }
}

// The literal pieces of a text between its expression spans: one more than the spans.
function literalPieces(text: string): string[] {
    const pieces: string[] = [];
    let at = 0;
    for (const [open, end] of expressionSpans(text)) {
        pieces.push(text.slice(at, open));
        at = end;
    }
    pieces.push(text.slice(at));
    return pieces;
}

// Whether a text holds a byte outside its expression spans that is neither a space nor a tab; a
// text holding none declares no byte of its rendering (the one guard, DN-127.D1).
function declaresAByte(text: string): boolean {
    return literalPieces(text).some((piece) => /[^ \t]/.test(piece));
}

// THE ONE TEMPLATE MATCHER: whether `rendered` is a rendering of the declared `text` — every byte
// outside the text's spans equal and `rendered` consumed whole, each span standing for any byte
// sequence, the empty one included. Glob semantics: literal bytes match themselves, never a
// pattern; leftmost matching of each middle piece is exact for that one wildcard. A text that
// declares no byte matches nothing.
function matchesTemplate(text: string, rendered: string): boolean {
    if (!declaresAByte(text)) return false;
    const pieces = literalPieces(text);
    if (pieces.length === 1) return rendered === pieces[0];
    const head = pieces[0]!;
    const tail = pieces[pieces.length - 1]!;
    if (rendered.length < head.length + tail.length || !rendered.startsWith(head) || !rendered.endsWith(tail)) {
        return false;
    }
    let middle = rendered.slice(head.length, rendered.length - tail.length);
    for (const piece of pieces.slice(1, -1)) {
        const found = middle.indexOf(piece);
        if (found < 0) return false;
        middle = middle.slice(found + piece.length);
    }
    return true;
}

// The first arm, in E, R, M, T order, by which `declaration` claims `rendered`; null when it claims
// it by none, and for an empty anchor, which declares nothing (DN-127.D1, DN-118.O3).
function claim(rendered: string, declaration: Declaration): Arm | null {
    const anchor = declaration.anchor;
    if (!anchor) return null;
    if (rendered === anchor) return 'E';
    if (declaration.callsWorkflow && rendered.startsWith(anchor + REUSABLE_SEPARATOR)) return 'R';
    if (declaration.declaresMatrix && !anchor.includes(EXPRESSION_OPEN) && rendered.startsWith(anchor + MATRIX_LEG_OPENER)) {
        return 'M';
    }
    if (expressionSpans(anchor).length > 0 && matchesTemplate(anchor, rendered)) return 'T';
    return null;
}

// Every declaration that REACHES `rendered`, in declaration order, each with its arm. Arms E and R
// reach whatever else claims the rendering; arms M and T reach it only when no other declaration
// claims it by any arm, since its bytes cannot say whose it is (DN-127.D1).
export function reach(rendered: string, declarations: Declaration[]): Reach[] {
    const claims: Reach[] = [];
    declarations.forEach((declaration, index) => {
        const arm = claim(rendered, declaration);
        if (arm !== null) claims.push({ declaration: index, arm });
    });
    if (claims.length <= 1) return claims;
    return claims.filter((each) => each.arm === 'E' || each.arm === 'R');
}

// A YAML scalar's text, or '' for anything that is not a scalar — a workflow file is free to
// contain shapes we must not throw on. Verbatim for strings: a `name:` carrying a `${{ }}`
// expression is kept as written, and the join reads it as a template (arm T); this producer never
// renders an expression.
function scalarText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The `needs:` edges a job body declares. GitHub accepts a bare scalar or a sequence — both
// shapes, one meaning.
function declaredNeeds(body: Record<string, unknown>): string[] {
    const declared = body['needs'];
    if (declared === undefined || declared === null) return [];
    if (!Array.isArray(declared)) {
        const key = scalarText(declared);
        return key ? [key] : [];
    }
    const needs: string[] = [];
    for (const entry of declared) {
        const key = scalarText(entry);
        if (key) needs.push(key);
    }
    return needs;
}

// The steps a job body declares, each `run:` text or `uses:` reference verbatim, read for its
// `run:` first; a step declaring neither declares no text (DN-89.D34).
function declaredSteps(body: Record<string, unknown>): DeclaredStep[] {
    const declared = body['steps'];
    if (!Array.isArray(declared)) return [];
    const steps: DeclaredStep[] = [];
    for (const step of declared) {
        if (!isPlainMap(step)) continue;
        const run = step['run'];
        const uses = step['uses'];
        if (run !== undefined && run !== null && !isPlainMap(run) && !Array.isArray(run)) {
            steps.push({ run: scalarText(run) });
        } else if (uses !== undefined && uses !== null && !isPlainMap(uses) && !Array.isArray(uses)) {
            steps.push({ uses: scalarText(uses) });
        }
    }
    return steps;
}

// Workflow YAML → the declared jobs, in document order (deterministic for a given file). Throws
// with the reason on an unreadable or jobs-less file — the caller turns that into ABSENT with the
// reason logged, never into a failed run.
export function parseWorkflowJobs(yaml: string): DeclaredJobRecord[] {
    let root: unknown;
    try {
        root = load(yaml);
    } catch (error) {
        const message = error instanceof YAMLException ? error.message : String(error);
        throw new Error(`workflow YAML is unreadable: ${message}`);
    }
    if (!isPlainMap(root)) {
        throw new Error('workflow file is not a YAML mapping');
    }
    const jobs = root['jobs'];
    if (!isPlainMap(jobs)) {
        throw new Error('workflow file declares no `jobs:` mapping');
    }

    const declared: DeclaredJobRecord[] = [];
    for (const [key, body] of Object.entries(jobs)) {
        if (!key) continue; // an empty key names nothing `needs:` could reference
        const job: DeclaredJobRecord = {
            key,
            name: '',
            needs: [],
            callsWorkflow: false,
            declaresMatrix: false,
            steps: [],
        };
        if (isPlainMap(body)) {
            job.name = scalarText(body['name']);
            job.needs = declaredNeeds(body);
            job.callsWorkflow = Object.prototype.hasOwnProperty.call(body, 'uses'); // DN-118.O3
            // The key's PRESENCE, whatever its value: a literal mapping and an expression both
            // declare a matrix, and a `strategy:` without it declares none (DN-127.D1).
            const strategy = body['strategy'];
            job.declaresMatrix = isPlainMap(strategy) && Object.prototype.hasOwnProperty.call(strategy, 'matrix');
            job.steps = declaredSteps(body);
        }
        // A job whose body is null or a scalar declares no name and no edges, and it is still
        // KEPT: its key is a legitimate target of another job's `needs:`.
        declared.push(job);
    }
    return declared;
}

// A listing row this producer cannot state truthfully on the wire. Thrown by `renderingOf`; the
// resolver turns it into an ABSENT graph with the reason logged, never into a wire the engine
// refuses (which would fail the run) and never into a guessed value.
export class ListingRowRefusal extends Error {}

// A listing row's conclusion as the wire states it: its token, or withheld `not_concluded` when
// the row carries none — the platform's `null` translated, never passed through (DN-89.D26).
function rowConclusion(row: RenderedJob): string | { withheld: 'not_concluded' } {
    return typeof row.conclusion === 'string' && row.conclusion !== ''
        ? row.conclusion
        : { withheld: 'not_concluded' };
}

// The one spelling GitHub's listing writes for a step time, `YYYY-MM-DDTHH:MM:SSZ`, at fixed
// offsets: the separators and each field's offset and width.
const LISTING_TIME_LENGTH = 20;
const LISTING_TIME_SEPARATORS: ReadonlyArray<[number, string]> = [
    [4, '-'],
    [7, '-'],
    [10, 'T'],
    [13, ':'],
    [16, ':'],
    [19, 'Z'],
];
const LISTING_TIME_FIELDS: ReadonlyArray<[number, number]> = [
    [0, 4],
    [5, 2],
    [8, 2],
    [11, 2],
    [14, 2],
    [17, 2],
];
const EPOCH_YEAR = 1970;
const LAST_HOUR = 23;
const LAST_MINUTE = 59;
const MS_PER_SECOND = 1000;

// Whole seconds since the Unix epoch for a listing time, or null when the text is not the one
// spelling above — a fractional second, an offset, an out-of-range field and an impossible date
// all included — so no float and no rounding reaches the wire (DN-140.D2). The crawler's
// `epoch_seconds` (insight-eidos `tamys/src/crawl/job_graph.cpp`) applies the same rule; every value
// here is an integer well inside 2^53, so `Date.UTC` and the division by 1000 are exact.
export function epochSeconds(text: string): number | null {
    if (text.length !== LISTING_TIME_LENGTH) return null;
    if (!LISTING_TIME_SEPARATORS.every(([at, separator]) => text[at] === separator)) return null;
    const values: number[] = [];
    for (const [at, width] of LISTING_TIME_FIELDS) {
        const field = text.slice(at, at + width);
        if (!/^[0-9]+$/.test(field)) return null;
        values.push(Number(field));
    }
    const [year, month, day, hour, minute, second] = values as [number, number, number, number, number, number];
    if (year < EPOCH_YEAR || hour > LAST_HOUR || minute > LAST_MINUTE || second > LAST_MINUTE) return null;
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const date = new Date(ms);
    // `Date.UTC` rolls an impossible day or month over into the next; the round trip refuses it.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return ms / MS_PER_SECOND;
}

function listingTime(text: string | null | undefined): number | { withheld: 'not_timed' } {
    const seconds = typeof text === 'string' ? epochSeconds(text) : null;
    return seconds === null ? { withheld: 'not_timed' } : seconds;
}

function isWholeAtLeastOne(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

// A listing row's `listed_steps`, in the state DN-140.D3 decides from the row itself: its steps
// when it lists any; otherwise `[]` when no runner was assigned (`runner_id` null or 0 and
// `runner_name` null or empty) and withheld `emptied_by_platform` when one was. A row that lists
// steps the wire cannot carry — a number below 1 or not strictly increasing, an empty name, a
// completion before its start — is refused, naming the job and the step.
function listedSteps(row: RenderedJob): WireListedSteps {
    const steps = row.steps ?? [];
    if (steps.length === 0) {
        const runnerAssigned = (row.runner_id ?? 0) !== 0 || (row.runner_name ?? '') !== '';
        return runnerAssigned ? { withheld: 'emptied_by_platform' } : [];
    }
    const listed: WireListedStep[] = [];
    let previous = 0;
    for (const step of steps) {
        if (!isWholeAtLeastOne(step.number) || step.number <= previous) {
            throw new ListingRowRefusal(
                `job "${row.name}" lists step number ${String(step.number)} after ${previous}; the wire ` +
                    'carries strictly increasing whole step numbers from 1',
            );
        }
        if (typeof step.name !== 'string' || step.name === '') {
            throw new ListingRowRefusal(`job "${row.name}" lists step ${step.number} with no name`);
        }
        const started = listingTime(step.started_at);
        const completed = listingTime(step.completed_at);
        if (typeof started === 'number' && typeof completed === 'number' && completed < started) {
            throw new ListingRowRefusal(
                `job "${row.name}" lists step ${step.number} completing at ${step.completed_at} before it ` +
                    `started at ${step.started_at}`,
            );
        }
        listed.push({
            number: step.number,
            name: step.name,
            conclusion:
                typeof step.conclusion === 'string' && step.conclusion !== ''
                    ? step.conclusion
                    : { withheld: 'not_concluded' },
            started_at: started,
            completed_at: completed,
        });
        previous = step.number;
    }
    return listed;
}

// One listing row, QUOTED as a rendering: the platform's name and conclusion at the platform's own
// grain, the row's job id and attempt, and the steps it ran (DN-140.D2). A live listing row always
// carries `id` and `run_attempt`; one that does not is refused rather than written `not_acquired`,
// which only a re-spelled corpus graph may carry (DN-140.D3).
export function renderingOf(row: RenderedJob): RenderedJobEntry {
    if (!isWholeAtLeastOne(row.id)) {
        throw new ListingRowRefusal(`job "${row.name}" carries no job id the wire can state (${String(row.id)})`);
    }
    if (!isWholeAtLeastOne(row.run_attempt)) {
        throw new ListingRowRefusal(
            `job "${row.name}" carries no run attempt the wire can state (${String(row.run_attempt)})`,
        );
    }
    return {
        key: '',
        display: row.name,
        needs: [],
        conclusion: rowConclusion(row),
        job_id: row.id,
        run_attempt: row.run_attempt,
        listed_steps: listedSteps(row),
    };
}

// The declared jobs joined with the run's rendered listing — the acquirer resolves the mapping
// because it is the party holding both the YAML and the jobs listing (the engine never guesses
// across the two). Throws `ListingRowRefusal` on a listing row the wire cannot carry.
export function joinDeclaredJobs(
    declared: DeclaredJobRecord[],
    rendered: RenderedJob[],
): DeclaredJobWire[] {
    // What the log renders each job under, per GitHub's own rule: the declared `name:`, else the
    // key. On a caller, a matrix job or a template it is an ANCHOR, not a single row's name — the
    // engine expands it over the renderings at match time; the set is never stored (it would
    // snapshot a rendering only the platform authors, and the staleness would be silent).
    const declarations: Declaration[] = declared.map((job) => ({
        anchor: job.name || job.key,
        callsWorkflow: job.callsWorkflow,
        declaresMatrix: job.declaresMatrix,
    }));
    const members: RenderedJob[][] = declared.map(() => []);
    for (const row of rendered) {
        for (const reached of reach(row.name, declarations)) members[reached.declaration]!.push(row);
    }
    const joined: DeclaredJobWire[] = [];
    declared.forEach((job, index) => {
        const anchor = declarations[index]!.anchor;
        const reaching = members[index]!;
        // `display` is the ANCHOR, ALWAYS — resolved or not (DN-127.D7). The engine re-derives
        // resolution from its own reach over every keyed entry, so a declaration that reached
        // nothing must still travel with what it claims: hiding it would hand a rendering it
        // contests to its rival. Whether it reached anything is the conclusion's statement.
        //
        // ⚠ A CONCLUSION IS DECLARED FOR EXACTLY ONE RENDERED JOB, OR NOT AT ALL. When a declared
        // job fans out, GitHub emits N conclusions and NO row for the caller; rolling those N into
        // one would make us the author of a verdict the platform did not state (ADR-20.D23 — the
        // refusal stands, stated as `concluded_per_rendering`; the fan-out's verdicts travel below
        // at the grain the platform declared them). A declaration no row reaches is withheld
        // `no_rendering`: the join found no row, which is a fact, not a silence (DN-89.D26).
        joined.push({
            key: job.key,
            display: anchor,
            needs: job.needs,
            conclusion:
                reaching.length === 0
                    ? { withheld: 'no_rendering' }
                    : reaching.length === 1
                      ? rowConclusion(reaching[0]!)
                      : { withheld: 'concluded_per_rendering' },
            calls_workflow: job.callsWorkflow,
            declares_matrix: job.declaresMatrix,
            declared_steps: job.steps,
        });
    });
    // The rendered rows, QUOTED — the platform's own verdicts at the platform's own grain. NO
    // `key`, and that is the type doing the work: `key` is what `needs:` references, and a
    // rendering is not referenceable — nothing may declare an edge to one. Reachable only by
    // containment under a declared anchor, which keeps the causal graph exactly as big as the
    // producer declared it.
    for (const row of rendered) {
        joined.push(renderingOf(row));
    }
    return joined;
}

// `$GITHUB_WORKFLOW_REF` ("owner/repo/.github/workflows/ci.yml@refs/…") → the in-repo workflow
// file path. `github.context.workflow` is the display name, which is not addressable. Null when
// the value is not of that shape (a source that cannot answer declares nothing).
function workflowPathFromRef(workflowRef: string): string | null {
    const at = workflowRef.lastIndexOf('@refs/');
    if (at < 0) return null;
    const withOwner = workflowRef.slice(0, at);
    const path = withOwner.split('/').slice(2).join('/');
    return path || null;
}

// A commit id as git spells it: SHA-1 (40 hex) or SHA-256 (64 hex). A branch or tag name is
// refused, because the contents API would resolve it to wherever the name points NOW.
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// The two runner variables that name the workflow file a run executed. Passed as the runner
// sets them (`process.env`), so no caller can substitute a ref of its own choosing.
export interface RunnerWorkflowEnv {
    readonly GITHUB_WORKFLOW_REF?: string | undefined;
    readonly GITHUB_WORKFLOW_SHA?: string | undefined;
}

// The file to read and the commit to read it at, or the reason neither can be named.
export type WorkflowCoordinate =
    | { readonly kind: 'executed'; readonly path: string; readonly sha: string }
    | { readonly kind: 'refused'; readonly reason: string };

// WHICH declaration the fold may follow, placed where a test executes it (ADR-22.D17). It lived in
// main.ts until 2026-09-27, read a PR's workflow at `base.sha`, and no test ran it.
//
// The runner is the one declarer of the executed file: `GITHUB_WORKFLOW_REF` names its path and
// `GITHUB_WORKFLOW_SHA` the commit it was loaded from. On `pull_request` that commit is the PR's
// MERGE commit, which carries every edit the PR makes to the workflow, from a fork too; on
// `pull_request_target` it is the base. No ref from the event payload is used, on any event:
// `pull_request.base.sha` names a file that did not run on `pull_request`, `head.sha` is not the
// merge commit either, and `github.context.sha` is right on `push` and wrong elsewhere. A second
// declarer that agrees on some events is how the base read shipped.
//
// The executed file is also the TRUSTED one, on every event. The threat is a declaration that did
// not run steering the report's fold. On the file that did run, a contributor controls nothing
// beyond the run they authored: the jobs, their names, their `needs:` and every log byte Tamys reads
// come from that same file. So there is no second, "safer" ref — reading the base on a PR is the
// threat itself, not a defence against it.
//
// NO FALLBACK: an absent or malformed variable refuses the coordinate, and the graph is ABSENT.
export function executedWorkflowCoordinate(env: RunnerWorkflowEnv): WorkflowCoordinate {
    const refusals: string[] = [];
    const workflowRef = env.GITHUB_WORKFLOW_REF ?? '';
    const workflowSha = env.GITHUB_WORKFLOW_SHA ?? '';
    const path = workflowRef ? workflowPathFromRef(workflowRef) : null;
    if (!workflowRef) {
        refusals.push('GITHUB_WORKFLOW_REF is absent or empty');
    } else if (!path) {
        refusals.push(`GITHUB_WORKFLOW_REF "${workflowRef}" names no workflow path`);
    }
    if (!workflowSha) {
        refusals.push('GITHUB_WORKFLOW_SHA is absent or empty');
    } else if (!COMMIT_ID.test(workflowSha)) {
        refusals.push(`GITHUB_WORKFLOW_SHA "${workflowSha}" is not a commit id`);
    }
    if (refusals.length > 0 || !path) {
        return { kind: 'refused', reason: refusals.join('; ') };
    }
    return { kind: 'executed', path, sha: workflowSha };
}

// This run's jobs listing, read ONCE per run before the baseline is resolved (DN-160.D2): the
// subject's job is named from it, and the changed side's graph joins the same rows. A failed read
// is carried with its error, so each consumer states it in its own terms.
export type RunJobs = { kind: 'listed'; jobs: ListedJob[] } | { kind: 'failed'; error: unknown };

export async function readRunJobs(octokit: Octokit, owner: string, repo: string, runId: number): Promise<RunJobs> {
    try {
        const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
            owner,
            repo,
            run_id: runId,
            filter: 'latest',
            per_page: 100,
        });
        return { kind: 'listed', jobs };
    } catch (error) {
        return { kind: 'failed', error };
    }
}

export interface ResolveJobGraphParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    /** This run's jobs listing, as `readRunJobs` read it. */
    listing: RunJobs;
    /** The executed workflow file, from `executedWorkflowCoordinate(process.env)`. */
    workflow: WorkflowCoordinate;
    info: (message: string) => void;
}

// The graph, or null = ABSENT (no flag, fold inert) with the reason logged. Never throws: the
// graph is an enrichment, and a run must not fail because its enrichment could not be acquired.
export async function resolveChangedJobGraph(
    params: ResolveJobGraphParams,
): Promise<DeclaredJobWire[] | null> {
    const { octokit, owner, repo, listing, workflow, info } = params;

    if (workflow.kind === 'refused') {
        info(
            `Tamys: no declared job graph — ${workflow.reason}. The diff still runs; aggregator ` +
                'rows do not fold.',
        );
        return null;
    }
    const { path, sha } = workflow;

    let declared: DeclaredJobRecord[];
    try {
        declared = await readWorkflowJobs(octokit, owner, repo, path, sha);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        info(
            `Tamys: no declared job graph — could not read ${path} at ${sha} ` +
                `(${message}). The diff still runs; aggregator rows do not fold.`,
        );
        return null;
    }
    // The coordinate is stated on every successful read, so a run's log says which commit its fold
    // followed — the one fact a reader needs to check a fold row against the workflow that ran.
    const edgeCount = declared.reduce((sum, job) => sum + job.needs.length, 0);
    info(
        `Tamys: declared job graph read from ${path} at ${sha} (GITHUB_WORKFLOW_SHA, the commit ` +
            `this run executed): ${declared.length} jobs, ${edgeCount} \`needs:\` edges.`,
    );

    // The listing is joined whenever the workflow file resolved, `needs:` edge or none: a job's
    // conclusion is the platform's own declaration, and the report reads it at the job's own grain
    // (a failing row on a job that concluded `success` states that job's precedence). A graph with
    // entries and no edge is an ordinary graph; the fold finds no aggregator in it and mints
    // nothing.
    if (listing.kind === 'failed') {
        info(`Tamys: no declared job graph — ${listingFailure(listing.error)}.`);
        return null;
    }
    try {
        return joinDeclaredJobs(declared, listing.jobs.map(listingRow));
    } catch (error) {
        info(`Tamys: no declared job graph — ${listingFailure(error)}.`);
        return null;
    }
}

// The declared jobs of the workflow file at `path`, read at commit `sha`. Throws the reason —
// the caller turns it into an ABSENT graph with one log line. `contents: read` is the one
// permission this fetch needs; a denial lands in the caller's catch and self-reports, because a
// graph that silently stopped arriving reads as a clean run.
async function readWorkflowJobs(
    octokit: Octokit,
    owner: string,
    repo: string,
    path: string,
    sha: string,
): Promise<DeclaredJobRecord[]> {
    const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: sha,
        mediaType: { format: 'raw' },
    });
    const yaml = response.data;
    if (typeof yaml !== 'string') {
        throw new Error(`the contents API returned no raw file for ${path}`);
    }
    return parseWorkflowJobs(yaml);
}

function listingFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof ListingRowRefusal
        ? `a row of the run's jobs listing cannot be stated on the wire (${message})`
        : `the run's jobs listing failed (${message})`;
}

// The events whose run object names the commit the run EXECUTED, as its `head_sha` (ADR-22.D17's
// EXECUTED state). Every other event is unrecoverable after the fact — `pull_request` executed a
// merge commit the run object does not name, `pull_request_target` the base tip — and an event no
// documentation row was read for is refused with them, fail-closed. The crawler reads the same
// catalog (insight-eidos `tamys/src/crawl/pairer.hpp`, `kExecutedEvents`); this repository is public
// and that one private, so each holds the list.
export const EXECUTED_EVENTS: readonly string[] = [
    'push',
    'workflow_dispatch',
    'schedule',
    'issues',
    'workflow_run',
    'merge_group',
];

export interface ResolveBaselineJobGraphParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    /** The run that published the baseline artifact. */
    baselineRunId: number;
    info: (message: string) => void;
}

// The BASELINE run's declared job graph, for `--baseline-job-graph`: the declared step texts the
// engine classes a step banner by come from both runs' own workflow files, so a value a `${{ }}`
// expression wrote into a banner joins one class instead of splitting into a new and a vanished
// step (DN-89.D34). Acquired after the fact, as the crawler acquires a baseline's: the run object
// names its event, its workflow file, its `head_sha` and its attempt; the file is read at
// `head_sha` only for an EXECUTED event, and the listing at that attempt, so a re-run's later
// attempt never answers for the run's bytes. Null = ABSENT with the reason logged; never throws.
export async function resolveBaselineJobGraph(
    params: ResolveBaselineJobGraphParams,
): Promise<DeclaredJobWire[] | null> {
    const { octokit, owner, repo, baselineRunId, info } = params;
    const absent = (reason: string): null => {
        info(
            `Tamys: no baseline job graph — ${reason}. The diff still runs; a step banner carrying a ` +
                'value is not matched to its declared step across the two runs.',
        );
        return null;
    };
    let run: { event: string; path: string; head_sha: string; run_attempt?: number };
    try {
        run = (await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: baselineRunId })).data;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return absent(`baseline run ${baselineRunId} could not be read (${message})`);
    }
    if (!EXECUTED_EVENTS.includes(run.event)) {
        return absent(
            `baseline run ${baselineRunId} is a \`${run.event}\` run, whose run object does not name the ` +
                'commit it executed',
        );
    }
    if (!run.path) {
        return absent(`baseline run ${baselineRunId} names no workflow file`);
    }
    if (!isWholeAtLeastOne(run.run_attempt)) {
        return absent(`baseline run ${baselineRunId} states no attempt (${String(run.run_attempt)})`);
    }
    let declared: DeclaredJobRecord[];
    try {
        declared = await readWorkflowJobs(octokit, owner, repo, run.path, run.head_sha);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return absent(`could not read ${run.path} at ${run.head_sha} (${message})`);
    }
    info(
        `Tamys: baseline job graph read from ${run.path} at ${run.head_sha} (the commit baseline run ` +
            `${baselineRunId}, a \`${run.event}\` run, executed): ${declared.length} jobs, listing at attempt ` +
            `${run.run_attempt}.`,
    );
    try {
        const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRunAttempt, {
            owner,
            repo,
            run_id: baselineRunId,
            attempt_number: run.run_attempt,
            per_page: 100,
        });
        return joinDeclaredJobs(declared, jobs.map(listingRow));
    } catch (error) {
        return absent(listingFailure(error));
    }
}

export type ListedJob = Awaited<ReturnType<Octokit['rest']['actions']['listJobsForWorkflowRun']>>['data']['jobs'][number];

// The REST job object reduced to the fields `RenderedJob` reads.
export function listingRow(job: ListedJob): RenderedJob {
    return {
        id: job.id,
        name: job.name,
        conclusion: job.conclusion ?? null,
        run_attempt: job.run_attempt,
        steps: job.steps?.map((step) => ({
            number: step.number,
            name: step.name,
            conclusion: step.conclusion,
            started_at: step.started_at,
            completed_at: step.completed_at,
        })),
        runner_id: job.runner_id,
        runner_name: job.runner_name,
    };
}
