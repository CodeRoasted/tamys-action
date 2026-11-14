// The frame renderer — the governed-copy heart of the Action.
//
// `renderComment(report, context)` is a PURE, DETERMINISIC function: same
// (report, context) ⇒ same string. The only varying inputs are identity stamps
// (head_sha, baseline.sha) which IDENTIFY the run, not its content
// (bibles/tamys_action.md § 4). The frame owns the header, the one-line
// verdict, the state logic, and the footer; the ENGINE owns every row
// (`summary`) and the full <details> body (`markdown`), surfaced verbatim up to
// the comment's byte budget (below) — the Action never re-authors a row
// (contract § 1; PRD-6 — "rows are the engine's, not ours"). Copy below is
// governed by PRD-6 § "Surface: Tamys PR comment".
//
// The comment is a BOUNDED PROJECTION of a report that is never capped
// (ADR-14.D12): GitHub refuses a comment over MAX_RENDERED_BODY_BYTES and posts
// nothing, so the frame composes within that budget by construction and declares
// every elision; the full report is the run's `tamys-report-*` artifact.

import {
    MAX_RENDERED_BODY_BYTES,
    type BaselineSubject,
    type RankedChange,
    type TamysReport,
    type TamysCommentContext,
} from './types.js';
import { polarityGlyph, severityGlyph } from './glyph.js';
import { State, selectState } from './verdict.js';

// Hidden sticky-comment key (contract § 4): list comments, PATCH the marked one
// or POST a new one — one comment per PR (per tag), updated in place. A
// `comment-tag` namespaces the marker so two tamys invocations in one job (e.g.
// vs-main and vs-previous) each keep their own sticky comment; the untagged
// marker is NOT a substring of a tagged one (`:` vs ` `), so lookups stay exact.
export const STICKY_MARKER = '<!-- tamys:pr-comment -->';
export function stickyMarker(tag?: string): string {
    return tag ? `<!-- tamys:pr-comment:${tag} -->` : STICKY_MARKER;
}

// Shared header, every state (PRD-6 § "The four states", verbatim).
const HEADER = '### 🔬 Tamys — structural diff of your CI logs';

// "What is this?" target — the product's Tamys front door (PRD-6 § "Page: Tamys").
const TAMYS_URL = 'https://coderoast.fr/tamys';

// Defensive cap on inline rows so a pathological significant-set cannot bloat the
// comment; the full set always lives in the <details> body. Real CI diffs surface
// a handful (the whole pitch is "3 that matter"), so this rarely engages.
const MAX_INLINE_ROWS = 20;

// Display caps on an inline row's engine strings, counted on their ESCAPED bytes: the
// template IS the row's identity and the engine writes it whole (ADR-14.D7), so one row can
// carry megabytes. The two values are display choices (ADR-14.D12); moving either means
// re-running the budget arms in tests/frame.test.ts. The template id named in an elision
// marker is an engine digest (`h:` + 32 hex = 34 B) and is capped only so the bound below
// holds whatever the engine sends.
const MAX_SUMMARY_DISPLAY_BYTES = 1_024;
const MAX_WHERE_DISPLAY_BYTES = 256;
const MAX_TEMPLATE_ID_DISPLAY_BYTES = 64;

// invariant: the composed body is at most MAX_RENDERED_BODY_BYTES (65 536) when the details
// block is the declared line. Per inline row the frame adds at most 4 B of ordinal, 20 B of
// polarity badge, 9 B of `where` framing and 1 B of newline, and each of the two elision
// markers is at most 144 B plus the artifact name (7 B lead, 13 B of grouped count, 12 B
// "B not shown", 11 B "; template ", 67 B of id, 20 + 11 B naming the artifact, 3 B spare):
// 20 × (1 024 + 256 + 34 + 2 × (144 + 12 + tag)) = 32 520 B + 40 × tag, plus at most 20
// severity sections of about 90 B each, the headline, stale banner, remainder line, declared
// details line, the claim boundary (about 280 B), the n-gram line (under 300 B) and footer (under
// 3 KiB). About 36 KiB for a short `comment-tag`, leaving
// 29 KiB for the envelope strings (branch, labels, tag), which GitHub bounds far below that.

// The report's claim boundary, as every human-readable view of the engine states it under its
// two inputs: insight-eidos `kClaimBoundary` (`tamys/api/tamys.api-report.cppm`), Eqya's wording of
// LIM-25's first two sentences, no figure (W469). The JSON carries no member for it, so the frame
// holds a copy, and preflight reds when the pinned engine's markdown stops carrying it verbatim.
export const CLAIM_BOUNDARY =
    'Tamys compares exactly two runs and keeps no history. On two successful runs, Drift means the ' +
    'logs differ, not that this change caused the difference: a line that comes and goes between ' +
    "your workflow's successful runs reads as Drift, because Tamys has never seen those runs.";

// The engine's n-gram disclosure (ADR-9.D3, W446), rendered from the JSON a report always carries
// (`inputs.<side>.ngram_refusals`) in the engine's own sentence (`ngram_refusal_line`,
// insight-eidos `tamys/src/report/change_report_serialize.cpp`), so a comment that does not embed
// the engine's markdown still states it. '' when no window refused. preflight reds when the pinned
// engine's markdown stops carrying this sentence verbatim.
export function ngramRefusalLine(report: TamysReport): string {
    const sides = [report.inputs.baseline.ngram_refusals ?? [], report.inputs.changed.ngram_refusals ?? []];
    const windows = sides[0]!.length + sides[1]!.length;
    if (windows === 0) return '';
    const refused = sides.flat().reduce((sum, refusal) => sum + refusal.refused, 0);
    const first = (sides[0]!.length > 0 ? sides[0]! : sides[1]!)[0]!;
    return (
        `N-gram limit reached in ${windows} ${windows === 1 ? 'step' : 'steps'} (${first.cap} keys each): ` +
        `${refused} line-to-line ${refused === 1 ? 'transition was' : 'transitions were'} not counted, so path ` +
        `changes in ${windows === 1 ? 'that step' : 'those steps'} may be incomplete`
    );
}

// Locale-independent thousands grouping (deterministic; no toLocaleString).
function groupThousands(value: number): string {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function plural(count: number, singular: string, pluralForm: string): string {
    return count === 1 ? singular : pluralForm;
}

function shortSha(sha: string): string {
    return sha.slice(0, 7);
}

// Deterministic age copy from the envelope-computed whole-hours value: `<h>h` under
// two days, else `<d>d <h>h` (the trailing hours dropped when zero). The frame never
// reads a clock — the hours arrive via context (purity holds).
export function formatAge(hours: number): string {
    if (hours < 48) return `${hours}h`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

// ── Safe embedding ──────────────────────────────────────────────────────────
// The rows (`summary`) and the report body (`markdown`) are the engine's CONTENT
// verbatim, but they derive from real — and on fork PRs, attacker-controlled — CI
// logs. They must be SAFELY EMBEDDED: a log line carrying HTML, backticks, or a
// pipe must not break the comment STRUCTURE. The critical vector is a literal
// `</details>` escaping the collapsed block; the code-fence (```)/inline-code
// backtick that would swallow the trailing `</details>` + footer is the second.
// "Verbatim content, safely embedded" — not raw-concatenated. (GitHub also
// sanitizes comment HTML; this is defence-in-depth at our boundary, and it fixes
// a fidelity bug too — an unescaped `<host>` or the `<*>` mask token would
// otherwise be eaten as a phantom HTML tag.) The rendered TEXT is unchanged: each
// escape maps to the entity that displays the same character, inert.

// HTML structural chars → entities. Neutralizes every HTML tag (incl. the
// </details> breakout). `&` first, so the entities it introduces aren't re-hit.
export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Fully inert an engine string for embedding in markdown: HTML, the structural
// markdown chars that could break the comment frame, AND the link/image syntax
// that would otherwise let attacker-controlled CI-log text post a clickable link
// or auto-loading image under our bot's identity. Each is replaced by the
// numeric entity that DISPLAYS the same character but is inert to the parser:
//   `        → code fence / inline-code span (would swallow following lines)
//   |        → table cell
//   [ ] ( )  → markdown link `[text](url)`, image `![text](url)`, and the
//              reference forms — the bot-comment phishing surface (contract
//              §6.1 item 2): a hidden destination behind innocuous text, or a
//              tracking pixel that loads on render.
// The engine's intentional block formatting (#, *, -, _, and a decorative
// `[BADGE]`) uses none of `|[]()` as live syntax and emits no links of its own
// (line-ref deep links are deferred), so the body's headers/bold/bullets survive
// intact and the bracketed badge renders identically as literal brackets. The
// only cosmetic effect is that any inline-`code` styling renders as literal
// backticks. Residual: a BARE url in log text can still GFM-autolink, but its
// link text == its href (visible, not a hidden destination) — defanging that is
// the item-4 perimeter pass, not this surface.
export function escapeInline(text: string): string {
    return escapeHtml(text)
        .replace(/`/g, '&#96;')
        .replace(/\|/g, '&#124;')
        .replace(/\[/g, '&#91;')
        .replace(/\]/g, '&#93;')
        .replace(/\(/g, '&#40;')
        .replace(/\)/g, '&#41;');
}

// ── The display cut ─────────────────────────────────────────────────────────
// A cut keeps the longest SOURCE prefix, ending on a code-point boundary, whose escaped form
// fits `capBytes`. escapeInline maps each code point on its own (no rule reads a neighbour),
// so the prefix's escaped size is the sum of its code points' escaped sizes — computed by
// calling escapeInline itself, never a second copy of its table. The walk stops at the cap,
// so a megabyte string costs a kilobyte of work plus one byte count.
interface DisplayCut {
    shown: string; // escaped, at most capBytes
    elidedBytes: number; // UTF-8 bytes of the source left out; 0 = shown whole
}

function cutForDisplay(text: string, capBytes: number): DisplayCut {
    let used = 0;
    let prefixEnd = 0;
    for (const codePoint of text) {
        const cost = Buffer.byteLength(escapeInline(codePoint), 'utf8');
        if (used + cost > capBytes) {
            const prefix = text.slice(0, prefixEnd);
            return {
                shown: escapeInline(prefix),
                elidedBytes: Buffer.byteLength(text, 'utf8') - Buffer.byteLength(prefix, 'utf8'),
            };
        }
        used += cost;
        prefixEnd += codePoint.length;
    }
    return { shown: escapeInline(text), elidedBytes: 0 };
}

// The marker after a cut: frame-controlled copy naming how much of the source was left out,
// the row's template (the key a reader looks it up by) and, when this run uploaded it, the
// artifact holding the full text. Composed OUTSIDE any code span, so its own backticks stay
// structure.
function elisionMarker(elidedBytes: number, row: RankedChange, context: TamysCommentContext): string {
    const parts = [`+${groupThousands(elidedBytes)} B not shown`];
    if (row.template_id) {
        const id = cutForDisplay(row.template_id, MAX_TEMPLATE_ID_DISPLAY_BYTES);
        parts.push(`template ${id.shown}${id.elidedBytes > 0 ? '…' : ''}`);
    }
    const artifact = context.report_artifact;
    const home = artifact ? `, full text in the \`${escapeInline(artifact.name)}\` artifact` : '';
    return ` … [${parts.join('; ')}${home}]`;
}

// An engine string as the row shows it: its capped, escaped prefix and the marker ('' when
// it was shown whole).
function displayed(
    text: string,
    capBytes: number,
    row: RankedChange,
    context: TamysCommentContext,
): { shown: string; marker: string } {
    const cut = cutForDisplay(text, capBytes);
    return { shown: cut.shown, marker: cut.elidedBytes > 0 ? elisionMarker(cut.elidedBytes, row, context) : '' };
}

// ── Rows, grouped into collapsible severity sections ────────────────────────
// Severity is what an operator triages on, so it is the SECTION axis: one collapsed
// <details> per severity, hottest first, the heat badge stated ONCE on the heading
// instead of repeated on every row beneath it. The affordance is the same disclosure
// triangle the full report already uses — deliberately not a second, invented one.
// Grouping and collapsing are FRAMING: no row's text is touched (contract § 1).

// The triage ladder, hottest first. A severity the ladder does not know is NOT
// dropped and NOT folded into `low`: it forms its own section after the known tiers,
// in the engine's own first-appearance order, so a new engine tier surfaces as itself
// rather than vanishing into a bucket that would misstate its heat.
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function severityRank(severity: string): number {
    const index = SEVERITY_ORDER.indexOf(severity.toLowerCase());
    return index === -1 ? SEVERITY_ORDER.length : index;
}

interface SeveritySection {
    severity: string; // lowercased wire form; the heading uppercases it
    rows: RankedChange[];
}

// Rows arrive already RANKED by the engine (regressions at the top tier). Grouping
// preserves that order inside each section, and a Map preserves insertion order, so
// two unknown tiers keep the engine's own sequence; `Array#sort` is stable (ES2019),
// so equal ranks never reshuffle. Same report ⇒ same sections, same order.
function groupBySeverity(rows: readonly RankedChange[]): SeveritySection[] {
    const sections = new Map<string, SeveritySection>();
    for (const row of rows) {
        const key = row.severity.toLowerCase();
        const section = sections.get(key);
        if (section) {
            section.rows.push(row);
        } else {
            sections.set(key, { severity: key, rows: [row] });
        }
    }
    return [...sections.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

// One row inside its section. The severity chip is GONE from the row — the heading it
// sits under carries it, and repeating it was the duplication this layout removes.
// What stays is the axis the heading CANNOT carry: polarity (F-1), as the green
// recovery circle plus the direction word. Neutral rows carry neither — an absent
// direction renders nothing, no empty badge. `polarity` is an engine ENUM (trusted);
// the `summary` is engine CONTENT — verbatim up to its display cap, safely embedded
// (escapeInline).
function renderRow(index: number, row: RankedChange, context: TamysCommentContext): string {
    const glyph = polarityGlyph(row.polarity);
    const badge = row.polarity ? `${glyph ? `${glyph} ` : ''}**[${row.polarity}]** ` : '';
    const summary = displayed(row.summary, MAX_SUMMARY_DISPLAY_BYTES, row, context);
    // WHERE attribution (LSRC-23 tier 1): the functional location after the summary,
    // as inline code. `where` is engine CONTENT (canon-extracted, fork-attacker-reachable)
    // → escapeInline; the surrounding backticks are frame-controlled, and an elision marker
    // follows the closing one. Absent ⇒ nothing.
    let where = '';
    if (row.where) {
        const location = displayed(row.where, MAX_WHERE_DISPLAY_BYTES, row, context);
        where = ` · in \`${location.shown}\`${location.marker}`;
    }
    return `${index}. ${badge}${summary.shown}${summary.marker}${where}`;
}

// One severity section. The heading is frame-controlled (a glyph, the severity token,
// a count), so it is composed raw — except the severity token itself, which is
// escapeHtml'd: it is an engine enum today, but it lands inside a <summary> ELEMENT
// here, where an unexpected `</summary>` would break the comment's structure rather
// than merely its text. Cheap at an enum, and it keeps the widened blast radius of the
// new HTML context closed at the boundary.
//
// `disclosed` opens the block. Exactly ONE section is disclosed — the hottest, index 0
// — and the reason is the product's contract rather than taste: the governed headline
// copy ends in a colon ("It slipped through:"), so a comment whose every section is
// collapsed opens with a sentence pointing at nothing. Precision-first means 1 alert =
// 1 true incident, and the incident must be READABLE at the top of the comment. The
// noise the layout was ruled against is the REPEATED per-row chip, not the finding
// itself. Everything below index 0, and the full report, stays collapsed.
function renderSection(section: SeveritySection, disclosed: boolean, context: TamysCommentContext): string {
    const count = section.rows.length;
    const heading =
        `${severityGlyph(section.severity)} <b>${escapeHtml(section.severity.toUpperCase())}</b>` +
        ` — ${count} ${plural(count, 'change', 'changes')}`;
    const rows = section.rows.map((row, i) => renderRow(i + 1, row, context)).join('\n');
    return `<details${disclosed ? ' open' : ''}><summary>${heading}</summary>\n\n${rows}\n\n</details>`;
}

function renderRows(report: TamysReport, context: TamysCommentContext): string {
    const rows = report.ranked_changes;
    const shown = rows.slice(0, MAX_INLINE_ROWS);
    // Index 0 is the hottest section by the ladder — whatever severity that is on this
    // report. Deliberately positional, not a CRITICAL special case: a report whose worst
    // finding is MEDIUM still discloses its worst finding.
    const blocks = groupBySeverity(shown).map((section, i) => renderSection(section, i === 0, context));
    if (rows.length > shown.length) {
        const rest = rows.length - shown.length;
        // Outside every section: the remainder is not a severity, and the cap is
        // global (the top-N of the RANKED set), not per-section.
        blocks.push(`_…and ${groupThousands(rest)} more — see the full report below._`);
    }
    return blocks.join('\n\n');
}

// The collapsed full report: the engine's markdown body, safely embedded. The
// body is escapeInline'd (not raw) so a log line in it cannot close the <details>
// early or open a code fence that swallows the trailing tag + footer; the
// engine's headers/bold/bullets survive (escapeInline leaves #,*,-,_ alone).
// Blank lines around it so GitHub renders the markdown inside the <details>.
// summaryLine is frame-controlled (counts), so it is composed raw.
//
// ALL OR NOTHING: renderComment embeds the body only when the whole comment then fits
// the budget; otherwise the block holds one declared line instead. Never a partial
// markdown — a cut there drops rows without saying which, and can break the block's
// structure.
enum DetailsMode {
    Embed,
    Declare,
}

function renderDetails(report: TamysReport, context: TamysCommentContext, mode: DetailsMode): string {
    const { total_changes, significant_changes } = report.summary;
    const summaryLine = `Full report — ${groupThousands(total_changes)} changes, ${groupThousands(
        significant_changes,
    )} significant`;
    const content =
        mode === DetailsMode.Embed ? escapeInline(report.markdown ?? '') : declaredReportLine(report, context);
    return `<details><summary>${summaryLine}</summary>\n\n${content}\n\n</details>`;
}

// The declared line standing in for a markdown too large to embed: its size, the limit, and
// where it is read whole when this run uploaded it.
function declaredReportLine(report: TamysReport, context: TamysCommentContext): string {
    const bytes = Buffer.byteLength(report.markdown ?? '', 'utf8');
    const line =
        `The full report is ${groupThousands(bytes)} B of markdown, too large to embed in a comment ` +
        `under GitHub's ${groupThousands(MAX_RENDERED_BODY_BYTES)}-character limit.`;
    const artifact = context.report_artifact;
    return artifact
        ? `${line} It is this run's [\`${escapeInline(artifact.name)}\` artifact](${artifact.run_url}).`
        : line;
}

// ── State bodies (PRD-6 § "The four states") ─────────────────────────────

// ① No baseline yet. PRD-6 hardcodes `main`; we substitute the PR's actual
// baseline SOURCE — the base branch by default (which may be master/develop),
// or the configured named source (`baseline_source`) when the user overrode
// selection — the only deviation from the literal copy, and the correct one.
function coldStartBody(context: TamysCommentContext): string {
    const source = context.baseline_source ?? `the last green run on \`${context.base_branch}\``;
    return (
        `🔬 No baseline yet. Tamys diffs each run against ${source}.\n` +
        'Once one lands, every PR gets a structural diff here — nothing to compare this time.'
    );
}

// ② Clean — significant === 0. One block, no <details> (nothing to drill into).
function cleanBody(report: TamysReport): string {
    const baseline = groupThousands(report.inputs.baseline.lines_observed);
    const changed = groupThousands(report.inputs.changed.lines_observed);
    const total = report.summary.total_changes;
    const headline = `✅ No structural change. ${baseline} → ${changed} log lines, same behaviour.`;
    if (total === 0) {
        // Degenerate clean (e.g. identical inputs): nothing was weighed, so the
        // second line would read "weighed 0 surface diffs" — omit it.
        return headline;
    }
    // The gap is never called noise (PRD-6 § "The four states"): the total mixes rows merged
    // into a finding, rows withheld as false absence claims and rows below significance, and
    // only the last is noise (ADR-20.D15). The copy states the observed total and no cause.
    return (
        `${headline}\n` +
        `Tamys weighed ${groupThousands(total)} surface diffs and found no structural change worth a look among them.`
    );
}

// The run-verdict predicate the Drift/Regression headlines branch on: the ENGINE-resolved
// verdict class (`summary.changed_outcome`, ADR-17.D5 — authoritative side-input →
// console tail → Unknown), never a render-side CI flag (the retired `build_status`).
// Absent (Unknown) degrades to the generic headline, exactly as 'unknown' did.
function changedRunSucceeded(report: TamysReport): boolean {
    return report.summary.changed_outcome === 'SUCCESS';
}

// ③ Drift — significant > 0, no regression. The cache-died hero lands here.
function driftBody(report: TamysReport, context: TamysCommentContext, details: DetailsMode): string {
    const significant = report.summary.significant_changes;
    // The observed total, never the gap: see cleanBody.
    const observed = groupThousands(report.summary.total_changes);
    const headline =
        changedRunSucceeded(report)
            ? // run verdict SUCCESS — the hero
              '🔍 Green build, changed behaviour. Your tests passed; the shape of your logs didn\'t.\n' +
              `${significant} ${plural(significant, 'change', 'changes')} worth a look, out of ${observed} observed.`
            : // build unknown / red
              `🔍 ${significant} structural ${plural(
                  significant,
                  'change',
                  'changes',
              )} worth a look, out of ${observed} observed.`;
    return `${headline}\n\n${renderRows(report, context)}\n\n${renderDetails(report, context, details)}`;
}

// ④ Regression — a row has polarity === regression, or the run verdict got strictly
// worse (`summary.outcome_regressed`, ADR-17.D5). The loudest state. Regression
// rows already sort first (the engine ranks NewError/Escalated at the top tier).
// The three headline branches are mutually exclusive by construction: a SUCCESS
// changed run cannot be an outcome regression (SUCCESS is the axis floor).
function regressionBody(report: TamysReport, context: TamysCommentContext, details: DetailsMode): string {
    const { baseline_outcome, changed_outcome, outcome_regressed } = report.summary;
    const headline = changedRunSucceeded(report)
        ? // run verdict SUCCESS — the strongest hero (founder-LOCKED line)
          '🚨 Green tests. Real regression. It slipped through:'
        : outcome_regressed
          ? // the run verdict itself regressed (§6.1 — typed, UNSTABLE never folded).
            // The pair is engine ENUM output (trusted), not log content.
            `🚨 Run verdict regressed: **${baseline_outcome ?? 'UNKNOWN'} → ${changed_outcome ?? 'UNKNOWN'}**.`
          : // structural regression on a non-green run
            '🚨 Regression flagged. A new error-level pattern that wasn\'t in the baseline:';
    // A pure verdict regression can carry zero ranked rows (steady templates, worse
    // verdict) — skip the empty rows block; the <details> body still carries the
    // engine's §6.1 verdict framing.
    const rows = report.ranked_changes.length > 0 ? `${renderRows(report, context)}\n\n` : '';
    return `${headline}\n\n${rows}${renderDetails(report, context, details)}`;
}

// ── Footer (every state) ────────────────────────────────────────────────────

// PRD-6 footer + the baseline-provenance footnote (contract § 4 / PRD-6
// § "What the frame carries"): "last green run on `branch` @ sha", linked to the
// run. Determinism + on-prem stated once, flat. Identity stamps (head/baseline
// sha) are run identity, not content.
// With a narrative attached the claim narrows to the report: the narrative is a model's draw, and a
// re-run may word it differently while the report under it stays the same (DN-158.D6).
function footer(context: TamysCommentContext): string {
    const claim =
        context.narration_host === undefined
            ? 'Deterministic — same inputs, same comment. Runs in your CI; your logs never leave it.'
            : "Deterministic report: same inputs, same report. The advisory narrative is a model's draw. " +
              "Runs in your CI; your logs never leave it, and the narration sent only Tamys's summary to " +
              `\`${escapeInline(context.narration_host)}\`.`;
    const parts = [claim, `[What is this?](${TAMYS_URL})`];
    if (context.baseline) {
        parts.push(baselineFootnote(context.baseline));
        // The age is ALWAYS stated when known — a reader must never have to infer
        // from a sha how old the comparison point is (the silent-staleness class).
        if (context.baseline_age_hours != null) {
            parts.push(`${formatAge(context.baseline_age_hours)} old`);
        }
    }
    if (context.report_artifact) {
        const artifact = context.report_artifact;
        parts.push(`Full report: [\`${escapeInline(artifact.name)}\` artifact](${artifact.run_url})`);
    }
    parts.push(`as of \`${shortSha(context.head_sha)}\``);
    return `<sub>${parts.join(' · ')}</sub>`;
}

// The provenance footnote adapts to how the baseline was SELECTED (the user is
// King of the baseline): a branch's last green run (the turnkey default), a
// named baseline artifact, or a local file.
function baselineFootnote(baseline: NonNullable<TamysCommentContext['baseline']>): string {
    const sha = shortSha(baseline.sha);
    const linkedSha = baseline.run_url ? `[\`${sha}\`](${baseline.run_url})` : `\`${sha}\``;
    switch (baseline.kind) {
        case 'artifact':
            return `Baseline: artifact \`${baseline.label ?? ''}\`${sha ? ` @ ${linkedSha}` : ''}`;
        case 'path':
            return `Baseline: local file \`${baseline.label ?? ''}\``;
        case 'run':
            return `Baseline: last green run on \`${baseline.branch}\` @ ${linkedSha}`;
    }
}

// ── The renderer ────────────────────────────────────────────────────────────

function body(
    report: TamysReport | null,
    context: TamysCommentContext,
    state: State,
    details: DetailsMode,
): string {
    switch (state) {
        case State.ColdStart:
            return coldStartBody(context);
        case State.Clean:
            return cleanBody(report as TamysReport);
        case State.Drift:
            return driftBody(report as TamysReport, context, details);
        case State.Regression:
            return regressionBody(report as TamysReport, context, details);
    }
}

// The stale-baseline banner (above the verdict body, below the header): when the
// caller set `baseline-max-age` and the resolved baseline exceeds it, the diff
// still renders — an aged comparison is information — but it must ANNOUNCE itself
// before its numbers are read. Bound + age are frame-controlled envelope values.
// It states what the resolver SEARCHED, never a cause it did not measure: a run-resolved
// baseline came from one branch's runs of this workflow, so only the named-artifact resolver
// has measured that no newer baseline exists anywhere in the repository.
function staleBanner(context: TamysCommentContext): string {
    const age =
        context.baseline_age_hours != null ? formatAge(context.baseline_age_hours) : 'unknown age';
    const head = `> ⚠️ **Stale baseline — ${age} old, past the ${context.baseline_age_bound ?? ''} bound.** `;
    const tail = 'This diff compares against that aged snapshot and loses meaning as the gap grows.';
    const baseline = context.baseline;
    if (!baseline) return head + tail;
    switch (baseline.kind) {
        case 'run':
            return (
                head +
                `It is the newest green run of this workflow on \`${escapeInline(baseline.branch)}\`; ` +
                'runs on other refs (a tag, another branch) are not read, so a newer baseline they ' +
                `stored is not this one. ${tail}`
            );
        case 'artifact':
            return (
                head +
                `It is the newest live \`${escapeInline(baseline.label ?? '')}\` artifact: no run has ` +
                `stored a newer one since. ${tail}`
            );
        case 'path':
            return `${head}It is the local file \`${escapeInline(baseline.label ?? '')}\`. ${tail}`;
    }
}

// What the VISIBLE frame states of the report beyond its rows, and never inside a collapsed block:
// the n-gram disclosure wherever the engine's markdown is not embedded — the Clean state has no
// details block, and a markdown too large to embed is replaced by its size line — then the claim
// boundary, on every report, as every human view of the engine states it (W446, W469). The text is
// the engine's (CLAIM_BOUNDARY, ngramRefusalLine), escaped as any engine string.
function reportStatements(report: TamysReport, state: State, details: DetailsMode): string {
    const parts: string[] = [];
    const refusals = ngramRefusalLine(report);
    if (refusals !== '' && (state === State.Clean || details === DetailsMode.Declare)) {
        parts.push(`_${escapeInline(refusals)}. Per unit in the report JSON's \`inputs\`._`);
    }
    parts.push(`_${escapeInline(CLAIM_BOUNDARY)}_`);
    return `\n\n${parts.join('\n\n')}`;
}

// The cross-workflow declaration (DN-118.D5), the first line under the header when the baseline's
// producing run belongs to another workflow. The engine never pairs a job across workflows: the
// reusable-call prefix is part of a job's identity, so `ci / build_pipeline` and `build_pipeline`
// are two units, and without this line a reader takes the vanished and new jobs for a pipeline
// change. The workflow paths come from the runs API and are escaped as any external string.
function crossWorkflowLine(context: TamysCommentContext): string {
    const pair = context.baseline?.cross_workflow;
    if (!pair) return '';
    return (
        `> **Baseline from another workflow:** the baseline was produced by \`${escapeInline(pair.baseline)}\`, ` +
        `this run by \`${escapeInline(pair.changed)}\`. A job one of them calls as a reusable workflow ` +
        '(`caller / job`) is a different unit from the same job run directly, so it reads as one job gone ' +
        'and one job new.\n\n'
    );
}

// A subject as the declaration names it: the job, and the capture when it selected a part of a log.
function subjectPhrase(subject: BaselineSubject): string {
    const job = `job \`${escapeInline(subject.job)}\``;
    return subject.capture === '' ? job : `${job} (capture \`${escapeInline(subject.capture)}\`)`;
}

// The cross-job declaration (DN-160.D1 (3)), beside the cross-workflow line: an `artifact=` baseline
// whose stored bytes are another job's than this run's. A named baseline is the user's explicit
// choice, so the pair is diffed and DECLARED, never refused; without this line a reader takes one
// job's log for the other's history. This run's job comes from the runs API and the baseline's from
// the artifact's sidecar; both are escaped as any external string.
function crossSubjectLine(context: TamysCommentContext): string {
    const pair = context.baseline?.cross_subject;
    if (!pair) return '';
    return (
        `> **Baseline from another job:** the baseline is the log of ${subjectPhrase(pair.baseline)}, this run ` +
        `diffs ${subjectPhrase(pair.changed)}. Every difference between the two jobs reads as a change.\n\n`
    );
}

function compose(report: TamysReport | null, context: TamysCommentContext, details: DetailsMode): string {
    const state = selectState(report);
    const header = context.comment_tag ? `${HEADER} (${context.comment_tag})` : HEADER;
    const crossWorkflow = crossSubjectLine(context) + crossWorkflowLine(context);
    const stale = context.baseline_stale ? `${staleBanner(context)}\n\n` : '';
    const statements = report ? reportStatements(report, state, details) : '';
    return `${stickyMarker(context.comment_tag)}\n${header}\n\n${crossWorkflow}${stale}${body(report, context, state, details)}${statements}\n\n${footer(context)}`;
}

// The full sticky-comment markdown. `report === null` ⇒ cold start. A
// comment-tag suffixes the header so two tagged comments are visually distinct.
// The engine's markdown is embedded when the composed comment then fits the budget,
// measured on the composed bytes; a markdown whose SOURCE already exceeds the budget is
// never escaped to find out, since escaping never shrinks it.
export function renderComment(report: TamysReport | null, context: TamysCommentContext): string {
    if (Buffer.byteLength(report?.markdown ?? '', 'utf8') <= MAX_RENDERED_BODY_BYTES) {
        const whole = compose(report, context, DetailsMode.Embed);
        if (Buffer.byteLength(whole, 'utf8') <= MAX_RENDERED_BODY_BYTES) return whole;
    }
    return compose(report, context, DetailsMode.Declare);
}
