# Tamys Action

Structural diff of your CI logs, on every PR. Tamys diffs one job's log against
that job's log from the **last green run on your base branch** and posts **one
sticky comment** — ranked by what matters, with the noise suppressed — plus an
optional advisory gate. Deterministic; runs in your CI, and your logs never leave
it. Optional AI narration sends only Tamys's bounded summary, never a log line, to
the model you choose, on your own key.

The whole integration:

```yaml
- name: Tamys Log Diff
  uses: CodeRoasted/tamys-action@v3
  with:
    target-job: build
```

Your build job stays untouched — Tamys pulls its log straight off the GitHub API,
forwards the job's own verdict to the engine (SUCCESS / FAILURE / UNSTABLE /
ABORTED / CANCELLED), diffs, comments, and seeds the next baseline. Full hello
world: [`examples/simple/ci.yml`](examples/simple/ci.yml).

## Usage

The step above runs in a small job that `needs:` your build job:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: make ci    # your build — untouched, nothing to capture

  tamys:
    needs: build
    if: ${{ !cancelled() }}   # still diff when the build went red — that's the point
    runs-on: ubuntu-latest
    permissions:
      actions: write          # read the build job's log + baselines; upload this run's baseline
      pull-requests: write    # post/update the sticky comment
    steps:
      - name: Tamys Log Diff
        uses: CodeRoasted/tamys-action@v3
        with:
          target-job: build
```

The first green run on the base branch seeds the baseline; every PR gets a diff
automatically thereafter (self-bootstrapping). No prior green run ⇒ an honest
"no baseline yet" comment.

**Tamys diffs one job today, not the whole run.** With `target-job`, each Tamys step
compares the log of that one job with the same job's log from the baseline run; the
logs of the run's other jobs are not read. With `log:`, it compares exactly what the
file holds. Diffing the whole run is what comes next: every job in one comparison, so a
job added or removed, or a failure that moves from one job to another, reads as
one structural change.
Every Tamys step's log says which grain it acquired, e.g. `Tamys: grain — acquired 1
job of the 7 this run lists ("build")`.

**The declared job graph, and what it gives one job.** The Action reads the workflow file
at the commit this run executed (with the `contents: read` permission) and this run's
jobs listing, and passes both to the engine as the run's declared job graph, whichever
way the log was sourced. On one job's log it does two things: a row is judged against
**its own job's** declared conclusion, so a new error in a job GitHub declared successful
reads as an absorbed error (High), not as the cause of the run's failure; and, with
`target-job`, a failed job's row names the step the listing declares failed, with how long
it ran (the Action tells the engine which job and which attempt the log is, so a re-run's
listing never names a step of another attempt). The baseline's own graph is read too, when
the baseline was published by a run: the workflow file at the commit that run executed, and
its listing at its own attempt. With both, a step whose banner carries a value (a commit,
a version) is matched to the step it declares on each side, instead of reading as one step
removed and another added; a baseline published by a `pull_request` run names no executed
commit, so it brings no graph. A refused read is logged and the diff runs without that graph.

**The required-check fold needs several jobs' logs.** When an aggregator job (one that
only `needs:` others, such as a "required checks" gate) goes red, the engine can replace
its rows with one row naming the member job that actually failed. It needs rows from
both jobs, so it fires only when a `log:` file holds several jobs' logs; with
`target-job`, which diffs one job, the engine refuses a fold whose two sides would claim
the same rows. The whole-run mode is planned.

## Advanced usage

Every default is overridable — the annotated tour (all knobs optional):

```yaml
- uses: CodeRoasted/tamys-action@v3
  with:
    # ── Log sourcing ─────────────────────────────────────────────────────
    target-job: build                # diff a finished job's log (run Tamys in a job that `needs:` it)
    capture: ci                      # auto (TAMYS_CAPTURE sections if any, else whole log) | off | <name>
    # log: build.log                 # OR a file you captured yourself (tee) — see "Capturing the log"

    # ── Baseline — you are King ──────────────────────────────────────────
    baseline: artifact=tamys-baseline-main-ci   # auto | branch=<name> | artifact=<name> | path=<file> | none
    baseline-name: tamys-baseline-main-ci       # the artifact name THIS run publishes its log under
    publish-baseline: auto                     # auto (PRs always; pushes/tags verdict-gated) | always | never

    # ── Verdict surfaces (each its own level: never|regression|drift|always) ──
    fail-on: high                    # the advisory gate — exit code only (none | medium | high | critical)
    pr-comment: always               # sticky PR comment level
    commit-comment: never            # commit comment on push runs (needs contents: write)
    annotations: never               # inline ::error/::warning/::notice on the Checks tab (token-free);
                                     # OFF by default — opt in with `drift`
    baseline-max-age: 7d             # staleness bound on the resolved baseline (default 72h; empty = off)
    comment-tag: vs-main             # namespace for a SECOND sticky comment in the same job
    changed-outcome: auto            # this run's NATIVE verdict token, forwarded verbatim to the engine
                                     # (auto = target-job's own conclusion; else ${{ needs.<job>.result }})

    # ── Extras ───────────────────────────────────────────────────────────
    # explain-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # optional AI narration on your key — see "AI narration"
    # explain-model: claude-haiku-5-5                       # the model named in the request
    # explain-endpoint: https://api.anthropic.com/v1/messages   # or another provider's /chat/completions
    # tamys-binary: /path/to/tamys    # self-hosted/in-image override (default: pinned, sha256-verified download)
    github-token: ${{ github.token }}
```

The fork-safe two-workflow topology adds `mode` / `run-id` / `build-workflow`
(the render → post pair) — see [Fork PRs](#fork-prs) and
[`examples/fork-safe/`](examples/fork-safe/). The named-baseline topology
(main lineage + per-PR previous-run diff) is
[`examples/baselines/ci.yml`](examples/baselines/ci.yml).

## On a push vs a PR

Tamys works whether you use PRs or push straight to `main`. **The diff is always written to the run's
job summary (`$GITHUB_STEP_SUMMARY`) and to step outputs** — that's the result, retrievable no matter
how you configure comments. Comments are an optional overlay on top, each surface with its own level:

- **PR runs** — `pr-comment` controls the sticky comment: `never` | `regression` | `drift`
  (drift or regression) | **`always`** (default — keeps the green "✅ no change" reassurance).
- **Push runs** (trunk commit to `main`, no PR) — `commit-comment` controls a comment on the pushed
  commit: **`never`** (default — job summary only) | `regression` | `drift` | `always`. Needs
  `contents: write`; upserts per-commit (re-runs don't duplicate). The baseline re-seed is
  **green-gated** (a red build still diffs against the prior green but never becomes the baseline).

Each surface has its **own** level (no shared floor), so you can keep the reassuring PR comment while
staying silent on routine pushes. `fail-on` is a separate axis — it gates the **build** (exit code),
not the comment. A value outside a surface's list fails the run as a configuration error, rather than
quietly switching the surface on or off. The first run on a fresh branch is a cold start (seed only); every run after diffs.

**What Drift means on two green runs.** Tamys compares exactly two runs and keeps no history. On two
successful runs, Drift means the logs differ, not that this change caused the difference: a line that
comes and goes between your workflow's successful runs reads as Drift, because Tamys has never seen
those runs. Measured on 21 264 pairs of successful runs from public repositories, 12 357 (58.1 %)
read Drift. (Measured with the Sift 1.10.6 engine. Every report states the first two sentences under
its inputs, and the PR comment states them above its footer, whatever its state.)

## Choosing the baseline — you are King

By default (`baseline: auto`) Tamys diffs against the last green run of **this workflow** on the PR's
base branch (push: the pushed branch; **tag: the repo's default branch** — so a tag build diffs
against `main`'s last green out of the box). *Last* means the newest green run by when it was
created: re-running an older run does not make it newer. `auto` reads that one branch's runs
only: a run on a tag still seeds its own baseline, but no later `auto` run reads it, since a tag is
not a branch. A pipeline that runs only on tags or manual dispatches of tags therefore keeps diffing
against the default branch's last green, however old; give it `baseline: artifact=<name>` to read
the newest stored baseline repo-wide. Every part of that is overridable:

- **`baseline`** selects the source: `auto` · `branch=<name>` · `artifact=<name>` (a **named
  baseline** — the newest non-expired artifact with that exact name, repo-wide) · `path=<file>`
  (bring your own) · `none` (forced cold start / seed-only).
  GitHub lists artifacts in no documented order, so `artifact=<name>` reads **every** artifact of
  that name (100 per request) and picks the newest by creation time, ties to the larger id. It
  reads **at most 1 000** (10 requests): past that, the run is a cold start whose warning names the
  count and the remedies (lower the repository's artifact retention, or use `branch=<name>`). If the
  listing changes while it is being read, the run is a cold start that names both counts, never a
  guess.
- **`baseline-name`** names the artifact this run **publishes** its log under (and what
  `auto`/`branch=` look for on the resolved run). Compose per-job / per-PR names with expressions.
- **`publish-baseline`** controls seeding: `auto` (PRs always; pushes/tags green-gated) ·
  `always` · `never`.
- **`baseline-max-age`** bounds the resolved baseline's **staleness** (`72h`, `7d`; **default
  `72h`**, empty disables it). The green-gated re-seed means a long red streak ages the baseline
  without limit — every diff then compares against an ever-older green, silently. An exceeded
  baseline still diffs, posts and seeds (an aged comparison is information) but **announces
  itself**: a stale banner in the comment and a warning annotation. **It is a warning, never a
  failure** — your build cadence is yours, a repo that ships weekly is not misconfigured, and
  `fail-on` stays the only axis that touches the exit code. Raise the bound to match your cadence.
  The age is always in the comment footer and the `baseline-age-hours` output, bound or no bound.
  It is measured from when the baseline's bytes were **stored** (the artifact's creation), whichever
  selector found them — never from the run's creation, which a re-run keeps. The stale warning
  names what the selector searched: under `auto`/`branch=`, the branch it read and the refs it did
  not; under `artifact=`, the repository.
- **`comment-tag`** namespaces the sticky comment, so two diffs in one job (vs `main` **and** vs
  the PR's previous run) each keep their own comment.

Named baselines decouple the diff from "this workflow ran on that branch": a `push`-to-`main` job
seeds `tamys-baseline-main-build`; PRs and tag builds resolve it by name from any event. The
canonical topology — main/tag runs diff vs the main baseline and re-seed it; PR runs diff vs main
**and** vs their own previous run — is in
[`examples/baselines/ci.yml`](examples/baselines/ci.yml).

A named baseline is repo-wide, so the run that stored it may belong to **another workflow**. Tamys
never pairs a job across workflows: a job called through a reusable workflow is named with its
caller's prefix (`ci / build`), and that prefix is part of its identity, so `ci / build` and
`build` are two different jobs. When the baseline's producing run belongs to another workflow, the
comment says so in one line under its header, naming both workflow files; a baseline from the same
workflow adds nothing. The comparison costs two reads of the runs API, and a failed read is a cold
start with its reason, never a diff without the line.

## The comment and the full report

GitHub refuses a comment over 65,536 characters and posts nothing, and one log line can be far
longer than that. So the comment is a **bounded projection** of the report, never the report cut
at the end:

- **Each row's text is shown up to 1,024 bytes**, and its `where` location up to 256 bytes, both
  counted after escaping. A longer row ends in a marker saying how much was left out and which
  template it is, e.g. `` … [+68,976 B not shown; template h:7f3a…, full text in the `tamys-report` artifact] ``.
  A row within the cap is shown whole, with no marker.
- **The full report is embedded in the collapsed block only when the whole comment then fits.**
  Otherwise the block holds one line giving the report's size and pointing at the artifact. It is
  never embedded in part. What the report says of its own reach stays visible either way: the
  two-run claim boundary on every comment, and, when an n-gram window hit its key limit, the
  report's line saying so on a comment that does not embed the report (the Clean comment has no
  collapsed block).
- **The full report is uploaded on every run that has one** as the **`tamys-report`** workflow
  artifact (`tamys-report-<comment-tag>` with a `comment-tag`): `report.json` exactly as the engine
  wrote it, and `report.md`, its markdown. The comment footer links to it. It is the content the
  comment already shows, so the fork `render` job uploads it too. If the upload fails, the step
  warns and the comment does not point at it; `report-path` still holds the report.

The report itself caps nothing: every row is written whole, in the artifact.

## Inline annotations

Tamys can also emit the significant rows as native **check-run annotations** (`::error` / `::warning` /
`::notice`) — they show in the **Checks** tab and the PR "checks were not successful" strip, inline with
the run. **They are OFF by default** (`annotations: never`) — the PR comment and the job summary already
render the same result, and an annotation competes with the compiler's own in the gutter where a real
build error must stay findable. Opt in and the surface is whole: `annotations` takes `never` (default) |
`regression` | `drift` (drift or regression) | `always`. Polarity drives the severity:

- a **regression** row → `::error::`
- a **recovery** (the un-grep-able win) → `::notice::`
- any other significant drift → `::warning::`

They **fire on a green build** too — exactly where GitHub's own "Explain error" is silent (it only fires
on a *red* check). The message is the engine's ranked `summary` + its first evidence line, **verbatim**;
there is **no `file:line` anchor** — Tamys diffs *logs*, not source, so it never guesses a source location
(the full report stays in the PR comment + `<details>`). A clean run has no significant rows, so even
`drift` stays quiet on a green, unchanged build.

**Annotations are fork-safe by construction.** They are GitHub *workflow commands* written to stdout —
they need **no write token** — so the unprivileged `mode: render` build job (the `on: pull_request` job
in [`examples/fork-safe/`](examples/fork-safe/)) emits them and they appear on a **fork PR's** checks,
with nothing privileged involved (the `workflow_run` poster is untouched). Engine content is encoded per
GitHub's workflow-command rules before it is emitted, so an attacker-controlled CI log line cannot forge
or break an annotation (`src/annotations.ts`).

## Capturing the log

**The default (`target-job`) needs no capture at all** — Tamys downloads the finished
job's log from the GitHub API as the bytes GitHub serves, and declares to the engine the
two delivery layers those bytes carry (a byte-order mark at the head of the job's log, and
the timestamp the API stamps on every line); the engine peels them, so no byte of a line is
rewritten on the way in. For precision, bracket the region(s) you want diffed with capture
markers — plain echoed lines in any step:

```yaml
- run: |
    echo "TAMYS_CAPTURE ci"     # optional — no markers ⇒ the whole job log
    make ci
    echo "TAMYS_CAPTURE_END"
```

`capture:` selects `auto` (marked sections if any, else the whole log) | `off` | a
section name — several named sections (`TAMYS_CAPTURE ci`, `TAMYS_CAPTURE release`) give
independent diffs/lineages from one job, one Tamys step each, each with its own
`baseline-name` (+ `comment-tag`). A marker is recognised behind the line's timestamp; the
lines a section selects reach the engine byte for byte, and the marker lines themselves do not.

Each stored baseline records how its bytes were delivered, and the next run declares it for the
baseline side. A baseline stored by an Action release before this record existed is not compared
against: that run is a cold start whose warning says so, and it re-seeds the lineage — one cold
start per baseline lineage, once.

**The in-job way** (`log:`) — a file holding the output you want diffed, captured
however fits your job; Tamys then runs as a step of the build job itself. Always with
`set -o pipefail` (a bare `… | tee` masks the build's real exit code), and set
`changed-outcome` explicitly (there is no target job to derive it from):

- **One command** — pipe it through `tee`:
  ```yaml
  - id: build
    run: |
      set -o pipefail
      make 2>&1 | tee build.log
  ```
- **Several commands in one step** — start capturing once, at the top:
  ```yaml
  - id: build
    run: |
      set -eo pipefail
      exec > >(tee build.log) 2>&1     # everything below this line is captured
      cmake --build build
      ctest --test-dir build
  ```
- **Output spread across several steps** — start an empty file, then append (`tee -a`):
  ```yaml
  - name: Start build-log capture
    run: truncate --size 0 "$GITHUB_WORKSPACE/build.log"
  - run: cmake --build build   2>&1 | tee -a "$GITHUB_WORKSPACE/build.log"
  - run: ctest --test-dir build 2>&1 | tee -a "$GITHUB_WORKSPACE/build.log"
  # … then point Tamys at it:
  #   with: { log: build.log, changed-outcome: "${{ steps.build.outcome }}" }
  ```

## AI narration (optional, on your key)

Pass a model provider's key and Tamys adds a short plain-English story above the ranked changes:

```yaml
      - uses: CodeRoasted/tamys-action@v3
        with:
          log: build.log
          explain-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

**What leaves your CI:** one request per run to the endpoint you name (Anthropic's, by default) carrying Tamys's
bounded summary: the top six ranked changes as the report itself prints them (masked templates, with their
severity and direction), the two runs' labels and line counts. Nothing that is not already in the report, never
the log, never a raw line. Without a key nothing is sent and you get the structural report alone.

**The default model** is Claude Haiku 5.5 (`claude-haiku-5-5`) on Anthropic's Messages API, at medium effort.
`explain-model` chooses another Claude model (it also runs at medium effort). For another provider, set
`explain-endpoint` to its OpenAI-compatible `/chat/completions` URL; its own default effort applies. Use a key
scoped to a workspace. The call is billed to your key: one call per
run, at most 4 096 output tokens.

**The narrative is advisory and fail-soft.** It is labelled AI-generated. It never changes the ranking, the gate
or an output, and any failure leaves the report exactly as it would be without a key. It is a model's draw: a
re-run may word it differently, while the report under it stays the same, bit for bit. Fork pull requests are
not narrated: GitHub gives their workflows no secrets, and the Action never narrates in `render` mode.

## Platform & supply chain

- **Runner:** linux x64 (`ubuntu-latest`) — **this Action** downloads the linux-x64
  engine asset only, and on any other runner it fails with an actionable message
  rather than running a wrong-arch binary. That is a statement about the Action, not
  about what the engine publishes: **`tamys-windows-x64.exe` is published** on every
  `engine-v*` release and `install.ps1` installs it as a standalone CLI (see
  [Other CI / Jenkins](#other-ci--jenkins)). **Linux x64 and Windows x64 are the delivered
  platforms; arm is a fast-follow. macOS is not a delivery target.**
- **Binary distribution:** the Action downloads the **version-pinned**
  `tamys-linux-x64` release asset and **verifies its sha256** before executing it —
  a checksum mismatch is fatal (the asset is a supply-chain surface: the Action
  runs it). The pinned version is fixed per Action release. Set `tamys-binary:` only
  to override with your own build (self-hosted runner / in-image).

## Fork PRs

By default (one workflow), a fork PR gets a **read-only** token, so the sticky comment
and baseline upload **can't write**. The Action does **not** silently no-op — it warns,
the **advisory gate still applies** (the diff runs, `fail-on` gates), **and the [inline
annotations](#inline-annotations) still surface if you turned them on** (they are token-free
stdout workflow commands — off by default, `annotations: drift` arms them), so a fork PR
can keep a visible structural signal even without the two-workflow pattern. Safe default.

To actually **post comments on fork PRs**, use the two-workflow pattern (the secure
alternative to `pull_request_target`) — see [`examples/fork-safe/`](examples/fork-safe/):

1. **`build.yml`** (`on: pull_request`, **read-only**) builds the PR and runs Tamys in
   `mode: render` → uploads the comment body (stamped with the `pr-comment` verdict) as an
   artifact. Fork code runs here, but the token can't post or touch anything privileged.
2. **`post.yml`** (`on: workflow_run`, **`pull-requests: write`**) downloads that artifact and
   posts the sticky comment **when the stamped verdict clears `pr-comment`** — and does **nothing else**.

> ⛔ **Forbidden pattern:** never `actions/checkout` the PR head and build/run it in a
> privileged job (`workflow_run` or `pull_request_target` with write access). That runs
> fork-controlled code with a write token — RCE + secret exfiltration. Build only in the
> unprivileged `pull_request` job; the privileged job consumes only the rendered artifact.

Fork-comment posting (the `render`/`post` modes + this pattern) is **live** — the parser
runs fork-controlled input only under the unprivileged job, and a sanitizer replay (every
seed of the parser's committed corpus, under ASan/UBSan and valgrind) is part of the
engine's release train.

## Other CI / Jenkins

This Action is a thin adapter over a **CI-agnostic substrate**: the `tamys` engine ships as
**public, unauthenticated, checksummed** release assets — `tamys-linux-x64` and `tamys-windows-x64.exe`
(each with a `.sha256`) on this repo's releases. Any CI with `curl` + `sha256sum` is just another client.

**No GitHub Actions? Install the CLI** — one line, downloads + sha256-verifies a **pinned**
binary. With no argument you get the version the installer is pinned to, so the same command
run months apart installs the same bytes; `latest` is available but must be **asked for**:

```sh
# Linux (sh) — the published CLI asset is linux-x64:
curl -fsSL https://raw.githubusercontent.com/CodeRoasted/tamys-action/main/install.sh | sh
# a different version:    ...install.sh | sh -s -- <X.Y.Z>
# the moving target:      ...install.sh | sh -s -- latest      # not reproducible, and it says so
# choose the location:    TAMYS_INSTALL_DIR="$HOME/bin"  (default: /usr/local/bin, else ~/.local/bin)
```

```powershell
# Windows (PowerShell) — diff + `--explain` via an endpoint you name:
irm https://raw.githubusercontent.com/CodeRoasted/tamys-action/main/install.ps1 | iex
# a different version: & ([scriptblock]::Create((irm .../install.ps1))) -Version <X.Y.Z>
# the moving target:   & ([scriptblock]::Create((irm .../install.ps1))) -Version latest
# choose location: $env:TAMYS_INSTALL_DIR = 'C:\tools\tamys'  (default: %LOCALAPPDATA%\Programs\tamys)
```

Then `tamys <baseline.log> <changed.log>` in any CI or locally. The download URLs are **stable** — only
the version tag varies (the engine binaries ride a distinct `engine-v…` tag). A release keeps the asset names it
published: `engine-v1.10.11` and earlier serve `sift-linux-x64` and `sift-windows-x64.exe`, every later one these:

```
https://github.com/CodeRoasted/tamys-action/releases/download/engine-v<VERSION>/tamys-linux-x64
https://github.com/CodeRoasted/tamys-action/releases/download/engine-v<VERSION>/tamys-windows-x64.exe
```

**Jenkins** has a ready, **doc-only** Tier-0 recipe: [`examples/jenkins/Jenkinsfile`](examples/jenkins/Jenkinsfile).
It reproduces the Action's advisory-first posture with zero new code — `--fail-on medium` is the
gate; the archived `tamys-report.json` + build status are the surface. The baseline is **user-wired**
(last green build's archived log via the Copy Artifact plugin, or a committed known-good log);
base-branch-aware "last green" resolution and a native PR/MR comment are platform-specific Tier-1 work
(see `bibles/tamys_action.md` § 9). The same curl-verify-run pattern ports to GitLab CI, Buildkite, or
a local shell.

## Migrating from Sift (`v2` → `v3`)

**Sift is now Tamys.** `v3` is the same Action under the product's new name, and every new engine ships to `v3`
only; `v2` stays on engine 1.10.11.

1. `uses: CodeRoasted/sift-action@v2` → `uses: CodeRoasted/tamys-action@v3`. The old repository name keeps
   redirecting, so a pinned `v2` keeps working until you move.
2. The input `sift-binary` is now `tamys-binary`. Every other input and every output keeps its name; the
   `report-path` output now points to `tamys-report.json`.
3. Capture sections: `echo "SIFT_CAPTURE <name>"` … `echo "SIFT_CAPTURE_END"` become `TAMYS_CAPTURE` …
   `TAMYS_CAPTURE_END`. Left unchanged, `capture: auto` diffs the whole job log, and `capture: <name>` fails the
   run as a configuration error.
4. **One cold start per baselined branch.** The baseline artifact is now `tamys-baseline-log`, so the first `v3`
   run finds no baseline, says so, and diffs nothing. The next green run on the branch seeds it. A `v2` baseline
   is not read.
5. **One duplicate comment per open pull request.** The PR comment's marker changed, so the first `v3` run on a
   pull request opened under `v2` posts a new comment beside the old one, which stops updating. You can delete the
   old one.
6. **The CLI installer** now lives at `https://raw.githubusercontent.com/CodeRoasted/tamys-action/main/install.sh`
   (and `install.ps1`), and engines from 1.10.12 on ship as `tamys-linux-x64` and `tamys-windows-x64.exe`. A copy
   of the old installer still installs 1.10.11 and older; asked for `latest`, it fails. Download the installer
   again.
7. **AI narration now runs on your own key, and the bundled model is gone.** The `explain` input and the
   2.4 GB local model (Phi-3.5-mini on a llama.cpp server) are removed. To keep a narrative, pass a model
   provider's key from a secret: `explain-api-key: ${{ secrets.ANTHROPIC_API_KEY }}`. The default model is
   Claude Haiku 5.5 (`claude-haiku-5-5`) on Anthropic's Messages API, at medium effort. `explain-model` picks
   another Claude model. The new `explain-endpoint` takes another provider's OpenAI-compatible
   `/chat/completions` URL. Only Tamys's bounded summary is sent, never the log. Without a key you get the
   structural report alone. A leftover `explain: true` draws GitHub's "Unexpected input" warning and does nothing,
   and the `actions/cache` step on `~/.cache/coderoast` can go. The narrative still heads the full report in the
   comment and in `report.md`; `report.json` no longer carries it.
8. **The CLI:** `tamys explain-setup` is gone. `--explain` now needs an endpoint (`--explain-endpoint` or
   `$CODEROAST_LLM_ENDPOINT`) and a model (`--explain-model` or `$CODEROAST_LLM_MODEL`), with a cloud key in
   `$CODEROAST_LLM_TOKEN`. A model you run yourself (Ollama, llama.cpp) is such an endpoint. A model cached
   under `~/.cache/coderoast` can be deleted.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `target-job` | no | _(none)_ | Zero-plumbing sourcing: diff the log of this finished job (run Tamys in a job that `needs:` it). Wins over `log`. See [Capturing the log](#capturing-the-log). |
| `capture` | no | `auto` | With `target-job`: `auto` (TAMYS_CAPTURE sections if any, else whole log) \| `off` \| `<name>` (that section only; absent ⇒ the run fails). |
| `log` | unless `target-job` | — | Path to the captured current-run log to diff. The only source on which the required-check fold can fire, when the file holds several jobs' logs (see [the required-check fold](#usage)). |
| `tamys-binary` | no | _(auto)_ | Override path to a `tamys` binary. Default: download + sha256-verify the version-pinned `tamys-linux-x64` release asset. |
| `fail-on` | no | `none` | `none` \| `medium` \| `high` \| `critical` — fail this step when Tamys reports a change that got worse at this severity or above (a listed row with polarity regression), or when the run's declared verdict got worse (read as critical, so it trips at every value). `none` never fails. Advisory: exit code only; the comment never says "blocked". Any other value fails the run. |
| `explain-api-key` | no | `''` | The model provider's API key, from a secret: `${{ secrets.ANTHROPIC_API_KEY }}`. Non-empty: one narration call per run. Empty: the structural report alone. See [AI narration](#ai-narration-optional-on-your-key). |
| `explain-model` | no | `claude-haiku-5-5` | The model named in the request. |
| `explain-endpoint` | no | `https://api.anthropic.com/v1/messages` | Anthropic's Messages API by default; any OpenAI-compatible `/chat/completions` URL over https for another provider. |
| `baseline` | no | `auto` | Baseline **selection**: `auto` \| `branch=<name>` \| `artifact=<name>` (named baseline, repo-wide) \| `path=<file>` \| `none`. Malformed values fail the run — never a silent fallback. See [Choosing the baseline](#choosing-the-baseline--you-are-king). |
| `baseline-name` | no | `tamys-baseline-log` | Artifact name this run **publishes** its log under (and what `auto`/`branch=` resolvers look for). |
| `publish-baseline` | no | `auto` | `auto` (PRs always seed; pushes/tags verdict-gated: FAILURE/UNSTABLE/ABORTED/CANCELLED never re-seeds) \| `always` \| `never`. |
| `baseline-max-age` | no | `72h` | Staleness bound on the resolved baseline (`<n>h` \| `<n>d`; empty disables it). Exceeded ⇒ stale banner + warning annotation, **never a failed step** (still diffs, posts, seeds). Malformed values fail the run. See [Choosing the baseline](#choosing-the-baseline--you-are-king). |
| `comment-tag` | no | _(none)_ | Namespaces the sticky comment (marker + title) so two tamys invocations in one job keep separate comments. |
| `changed-outcome` | no | `auto` | This run's **native** CI verdict token, forwarded verbatim to the engine (class-aware: UNSTABLE is never folded into FAILURE). `auto` = `target-job`'s own conclusion; set `${{ needs.<job>.result }}` when sourcing via `log:`, else the engine reads the log's console tail / no verdict. |
| `pr-comment` | no | `always` | `never` \| `regression` \| `drift` \| `always` — sticky PR comment at/above this verdict. Any other value fails the run. |
| `commit-comment` | no | `never` | `never` \| `regression` \| `drift` \| `always` — commit comment on push at/above this verdict (needs `contents: write`). Any other value fails the run. |
| `annotations` | no | `never` | `never` \| `regression` \| `drift` \| `always` — inline check-run annotations (`::error`/`::warning`/`::notice`) at/above this verdict. **Off by default**; opt in with `drift`. Any other value fails the run. Fork-safe (stdout workflow commands, no token); fires on green. See [Inline annotations](#inline-annotations). |
| `github-token` | no | `${{ github.token }}` | Runs/artifacts API + comment + artifact upload. |

## Outputs

Set on **every** run, whatever the comment config — branch on them in a later step
(`if: steps.tamys.outputs.state == 'regression'`):

| Output | Description |
|---|---|
| `state` | `cold-start` \| `clean` \| `drift` \| `regression` |
| `total-changes` | Total observed deltas (before significance suppression). |
| `significant-changes` | Deltas that cleared the significance floor. |
| `regression` | `true` when a regression was flagged (a regression row **or** a run-verdict regression), else `false`. |
| `baseline-outcome` | The baseline run's engine-resolved verdict: `SUCCESS` \| `FAILURE` \| `UNSTABLE` \| `ABORTED` \| `CANCELLED` \| `UNKNOWN`. |
| `changed-outcome` | This run's engine-resolved verdict (same values). |
| `outcome-regressed` | `true` when the run verdict got strictly worse (`Success < Unstable < Failure`; Aborted/Cancelled/Unknown excluded). |
| `baseline-age-hours` | Resolved baseline's age in whole hours, from when its artifact was stored; empty when unknown (cold start, `path=` baseline, pre-sidecar artifact) — never 0-for-unknown. |
| `baseline-stale` | `true` when a `baseline-max-age` bound is in force and the resolved baseline exceeds it, else `false`. Advisory — it never fails the step. |
| `report-path` | Path to this run's `report.json` on a stable, cross-step location (empty on cold start). A later step on the **same runner** can narrate it with `tamys explain --report <path>` — same content as the comment; no credential. The same report is the run's `tamys-report` artifact ([The comment and the full report](#the-comment-and-the-full-report)). |

## Architecture

The **engine** (`tamys`, C++) owns all content — the ranked rows (`summary`) and
the full report body. The **Action** (this, TS) owns only the *frame* (header,
verdict headline, state selection, footer) and the GitHub transport (sticky
comment, baseline artifact, check status). A bad row is an engine fix at the
root — never re-authored here.

- `src/frame.ts` — the pure, deterministic comment renderer (the governed copy). The ranked rows
  are grouped into one **collapsible section per severity**, hottest first (CRITICAL → HIGH →
  MEDIUM → LOW), with the heat badge stated once on the section heading instead of repeated on
  every row; a row keeps only what the heading cannot carry — its `regression` / `recovery`
  direction. The **hottest section opens by default** so the incident is readable at the top of
  the comment; every other section, and the full report, starts collapsed. Grouping is framing:
  no row's text is touched. The comment is composed within GitHub's size limit by construction
  ([The comment and the full report](#the-comment-and-the-full-report)), and every elision is declared.
- `src/annotations.ts` — the pure check-run annotation builder + the workflow-command encoder (the stdout-surface trust boundary, the `escapeInline` analogue).
- `src/verdict.ts` — the four-state machine (cold-start / clean / drift / regression).
- `src/baseline.ts` — baseline source selection (auto / branch= / artifact= / path= / none) via the GitHub API.
- `src/joblog.ts` — `target-job` log sourcing: job lookup, the job log as served bytes and their declared delivery stack, TAMYS_CAPTURE selection of whole lines, the native-conclusion token for `changed-outcome: auto`.
- `src/jobgraph.ts` — the run's declared job graph: the workflow's declared jobs, read at the commit the runner names as executed (`GITHUB_WORKFLOW_SHA`), joined with the run's jobs listing (each job's conclusion, id, attempt and listed steps).
- `src/tamys.ts` — engine invocation (`--format both`, `--fail-on`).
- `src/comment.ts` — sticky-comment upsert. `src/artifact.ts` — baseline publish, the `tamys-report` upload, and the fork render/post transport.
- `src/main.ts` — orchestration.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # tsc → lib/ then node --test (ESM)
npm run package     # esbuild ESM bundle → dist/index.js + dist/licenses.txt (esbuild.config.mjs)
```

The Action is **ESM** (`"type": "module"`, `runs: using: node24`): the `@actions`
toolchain (core@3 / github@9 / artifact@6) and octokit@7 are ESM-only, so `dist/index.js`
is an ESM bundle built by esbuild (ncc only emits CJS). `dist/licenses.txt` is regenerated
from the build metafile (the exact bundled set) on every package.

> Packaging (final bundling to `dist/`, the `tamys` release-asset publish, the home
> repo, token/fork-PR posture) is the DevOps lane — see contract § 6–7.

## License

This Action wrapper is **MIT** (see [LICENSE](LICENSE)) — commodity glue: resolve
the baseline, fetch + verify the binary, run it, render the comment frame.

It downloads and runs the `tamys` engine binary at runtime: a version-pinned,
checksum-verified release asset that is **© 2026 Emmanuel Prunet (CodeRoast), proprietary**
(free to run for any purpose incl. commercial; binary only; no redistribution or
reverse-engineering) and **not covered by this repository's MIT license**. The
binary is never vendored here — see [NOTICE](NOTICE). Bundled third-party
dependencies in `dist/` keep their own licenses (`dist/licenses.txt`).

"Tamys" and "CodeRoast" are trademarks of Emmanuel Prunet (CodeRoast) — separate from the code license.
