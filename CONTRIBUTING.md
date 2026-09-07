# Contributing to Iris

Iris is a SillyTavern-compatible roleplay host on the Cordis plugin
architecture. **Compatibility is the floor, not the ceiling**: a card that
works in SillyTavern must work here, and where Iris deliberately does something
better, that is a documented feature rather than an accident.

## The one rule everything else follows from

> **Fixtures and code come from the same belief, so a fixture can only confirm
> you. Only files other people wrote can prove you wrong.**

Test against real cards, real chat files and a real SillyTavern install
wherever the claim is about upstream behaviour. A green suite built entirely
out of your own fixtures says only that you were consistent.

## Branches and pull requests

- **`main` takes pull requests and nothing else.** Nobody pushes to `main`
  directly — not maintainers, not the person coordinating a batch of work, not
  the person who wrote the rule. A rule with exceptions decays, because the
  exceptions become the habit and nobody re-checks who qualifies as one; a rule
  without them makes a violation visible.
- Work happens on **`dev/<topic>`** branches (`dev/post-merge-followups`,
  `dev/feat-character-mgmt`). One topic per branch.
- Rebase onto `main` before opening the PR, so the diff is what you changed.
- One PR is one change with one argument behind it. A refactor riding along
  with a behaviour change makes both unreviewable.

## CI is the gate

`.github/workflows/ci.yml` runs on **every push to any branch and on every
pull request**. It is one job on `ubuntu-latest` with a 20-minute timeout, and
it references **no secrets** — the suite is offline by construction, so a fork's
PR can neither fail for lack of a key nor leak one. Its steps, in order:

1. `actions/checkout@v4`, then `actions/setup-node@v4` with Node **24.x** —
   the host packages have no build step and load `.ts` files through Node's
   native type stripping, so an older Node cannot load a single source file.
2. `pnpm/action-setup@v4` (pnpm 10), then `pnpm install --frozen-lockfile`.
3. `npm ci` in `apps/iris-web`. Two package managers on purpose:
   `pnpm-workspace.yaml` excludes `apps/iris-web` because pnpm cannot extract
   esbuild in this project's environment, so the browser app is npm-managed
   and reaches workspace code through Vite aliases.
4. `pnpm run typecheck` (root `tsc --noEmit`).
5. `npm run typecheck` in `apps/iris-web`.
6. `npm run build` in `apps/iris-web` — **before the tests**, because
   `apps/iris-web/public/sandbox/` is gitignored build output and at least one
   test reads an artifact out of it. On a developer's machine the directory is
   left over from an earlier build, so the dependency is invisible; on a fresh
   checkout it is the difference between green and red. This step also runs
   the bootstrap and preset size checks that `build:sandbox` invokes.
7. `pnpm run test:no-corpus` — **not** `pnpm test`. It runs the same suite with
   the corpus forced absent (`scripts/check-corpus-skips.mjs`) and then checks
   the *shape* of the result: how many tests skipped, grouped by what gated
   them. See "Testing" below for why.
8. `npm run check:render` in `apps/iris-web`.

**All green or it does not merge. There are no exceptions**, and "the failure
is unrelated to my change" is a reason to fix the failure, not to merge past it.

### Run the gate locally before opening the PR

```
pnpm -s exec tsc -p . --noEmit          # root typecheck
(cd apps/iris-web && npm run typecheck) # browser-app typecheck
pnpm -s test                            # the suite, with your corpus
pnpm run test:no-corpus                 # the suite as CI sees it
```

Put the last lines of each in the PR description. If something failed, say so
with the output; if you skipped a step, say that.

**Why two typechecks.** The root `tsconfig.json` covers `packages/*`,
`apps/iris` and `scripts/`; `apps/iris-web` has its own config (DOM libs,
bundler resolution, JSX) and sits outside the pnpm workspace. Neither run sees
the other's files.

**Why typecheck and test both, every time.** The test runner strips types
rather than checking them, so a file with a real type error runs and passes.
That is not hypothetical: a batch here shipped 974/974 green while `tsc`
failed on the very test file the batch added. "Tests pass" is not evidence of
a clean build, and a completion claim quotes both commands.

**Why `pnpm test` and `test:no-corpus` both, when you have the corpus.** Your
machine has a SillyTavern install, so the local run covers more. CI has none,
which is the only condition under which a mis-guarded corpus test can be
caught — see "Testing".

## Commits

Write what changed and **why**, in the repository's existing voice: one
sentence (long is fine), present tense, naming the mechanism rather than the
file. From `git log`:

```
chat-search test: degradation is judged against a same-process baseline ratio,
not a wall clock; the 10 MiB case is named a smoke bound because it cannot see
a quadratic scan

GET /version answers in upstream shape with the SillyTavern version this host
reproduces

Masthead settings button carries data-control="settings" on the element that
opens settings; no aria-label, because its visible text is its name
```

Not `fix bug`, not `update prompt.ts`. The subject should let someone scanning
`git log` decide whether this commit is the one they are looking for. If a
commit corrects an earlier decision, say which one and why it moved.

### What goes in a commit

- **Stage by path. Never `git add -A`, `git add .` or `git add <directory>`.**
  Several people and agents share one working tree here, and a wildcard has
  staged a colleague's half-finished work into someone else's commit — once
  while that colleague's suite was red. The rule is about *which paths you
  staged*, not which command you typed.
- **Generate the list from `git status --porcelain`, taken in the same
  moment, not from memory** — memory is the one irreproducible link.
- **Confirm the tree is green before staging.** Nothing in a working tree
  distinguishes "finished" from "halfway"; that judgement travels with the
  person who made the change.

## What never gets committed

`.gitignore` already refuses these; the list is here so nobody argues with it.

- **Keys and secrets of any kind** — `key.txt`, `*.key`, `secrets.json`,
  `.env` and `.env.*` (only `.env.example` is tracked). Not in fixtures, not in
  commit messages, not in a test's expected output. `key.txt` is never read
  or printed by tooling either.
- **`data/`** — characters, chats, presets, world books, `connections.json`.
  That is the user's content and it contains API keys.
- **`测试用卡/`** — test cards are other people's work; the tests that read
  them skip when the folder is absent.
- **Build output** — `dist/`, `apps/iris-web/public/sandbox/`.
- **`.reference/`** — the read-only harness checkout.

## Security constraints the code holds

These are decisions with tests behind them; a change to any of them is a PR
that says so in its title.

- **Remote script code loads from two places only**: any hostname under
  `jsdelivr.net`, and exactly `raw.githubusercontent.com` (not the
  `githubusercontent.com` suffix, which would also cover user-upload hosts).
  The list is `ALLOWED` in `packages/iris-script/src/remote.ts`, and a drift
  test compares it against the sandbox's `script-src` line.
- **The host binds loopback.** `apps/iris/cordis.yml` sets the webserver row to
  `127.0.0.1`; the carrier ships no TLS and no authentication. Serving Iris to
  a network means a reverse proxy in front, never `0.0.0.0` in that file.
- **Card templates run in a child process** with no environment, no filesystem
  writes and no host objects in reach — and are still off unless the user
  turns them on, because containment is not a reason to opt someone in.
- **`pruneVariables` defaults off** and `cordis.yml` carries no row for it. The
  sweep deletes variable tables nothing restores, so it is an opt-out written
  into the composition, never a default; `apps/iris/tests/composition.test.ts`
  parses the real file and holds that line.

## Documentation

Where a `.md` lives says what it is:

- **Repository root**: only files a contributor or user needs first —
  `README.md`, `CONTRIBUTING.md`, and, when present, `LICENSE`,
  `THIRD-PARTY-NOTICES`, a top-level `DEVIATIONS`. Nothing else.
- **`docs/`**: contracts — documents code comments cite as the reason a rule
  exists (`docs/ARCHITECTURE.md`, `docs/SANDBOX.md`, `docs/OBSERVABILITY.md`,
  `docs/AUTORUN.md`, `docs/SETTINGS.md`, `docs/DEBUG-SURFACE.md`). A change to
  behaviour that a contract describes changes the contract in the same PR.
- **`notes/`**: working notes — investigations, upstream comparisons,
  deviation ledgers, acceptance sheets, plans. They mirror the tree
  (`notes/packages/iris-app-service/…`, `notes/apps/iris-web/…`). Notes are
  records of a moment; a number in one is true of the commit and date it
  names, and a fresh number and a rotten one are typeset identically, so **a
  measured premise that behaviour depends on also gets a test that fails on
  its own** when the premise stops holding.
- **A package's own `README.md`** stays with the package.

Two habits that keep prose honest:

- **Corrections are struck through and kept**, with what was wrong and how it
  surfaced. Never silently replace a wrong sentence.
- **A sentence describing a queued fix is false the day it lands.** Ask it per
  sentence: *is this true right now, on `main`?* A draft here once carried
  both the warning that a config row overrode a default and, four paragraphs
  later, the sentence that override made false.

### Citing upstream

- **Name the version**: `[ST 1.18.0] src/endpoints/chats.js:696`. A bare line
  number is a measurement of one checkout, and upstream renumbers.
- **Before correcting a line number, grep the whole tree for it** —
  `grep -rn "chats.js:604"` — and fix every copy. Citations get copied;
  verifying that one is wrong and finding the rest are two different actions,
  and a thorough first is exactly what tempts you to skip the second. The tree
  held two copies of `chats.js:604` (it is `/export`; `/import` is `:696`) and
  three more in notes.

## Testing

- **A test has to be able to disagree with its author.** Assert the property,
  not the value you happened to produce. A test that pins an incidental count
  fails correct changes and gets its number bumped instead of read.
- **Prove a new test can fail.** Break the code it covers and watch it go red.
  If nothing goes red there are three explanations with opposite fixes: the
  test asserts nothing about this, the sample cannot reach the branch, or
  your mutation never landed.
- **Every skip carries a reason that says what is missing and where it comes
  from.** `{ skip: !existsSync(CORPUS) && \`no characters folder at
  ${CORPUS}; point IRIS_CORPUS at a SillyTavern install\` }`, never
  `{ skip: true }` or a bare `t.skip()`. `test:no-corpus` groups skips by the
  gate their reason names and reports the unlabelled ones as their own group.
- **Gate a corpus test with a skip, never an early `return`.** A bare `return`
  reports as a **pass** in `node --test`, so a test that asserted nothing shows
  up green — and CI, the one environment with no corpus, is exactly where
  nobody would notice. `pnpm run test:no-corpus` exists for this: it forces
  `IRIS_CORPUS` (and `IRIS_SAMPLES`, for the gitignored sample folder) to
  paths that cannot exist and pins the skip count. **Read the gate from the
  variable**, not from a hardcoded path — a gate that ignores the variable
  runs in the rehearsal and skips on CI, and the pinned count is one short of
  the run it stands in for.
- **A time bound is a ratio against a baseline measured in the same process,
  not a wall clock.** `elapsed < 1000` is a measurement of one machine wearing
  a constant's clothes; it goes red on a loaded runner for code that did not
  change, and a red read as noise protects nothing. Measure something small
  first, then bound the large case as a multiple. Say what the bound cannot
  see — call it a smoke bound when it can only turn a hang into a failure.
- **A check with a `continue` asserts how many samples it actually compared.**
  A loop that skipped 22 of 26 stayed green for a long time.
- **Where a value has two plausible sources, make the fixture give them
  different values**, or the assertion proves they were equal rather than
  that the code read the right one.

## Refusals and reports

- **Every failure gets a voice.** Returning `undefined` or `{}` where
  something went wrong disguises a decision as missing data.
- **A report signs its own name.** Do not say "the host refused" unless you
  have evidence it was the host; "this app does not list it, the host was
  never asked" is the honest sentence.
- **A refusal names the member, the reason, and carries its evidence.**

## Working alongside other people

Several people and agents may share one checkout. Treat it that way:

- Stage only the paths you listed.
- Do not run installs, builds or state-changing git operations that were not
  yours to run; `dist/` is served by whatever host is currently running.
- Do not edit files that belong to work in flight elsewhere. If you cross into
  someone else's area — even to add a one-line arm that unblocks a build —
  **say so in your report**.
- Read the file again before you edit it. The copy in your head is from
  before your colleague's last save.
