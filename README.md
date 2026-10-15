# ci-runner-health

Every 5 minutes `health.yml` counts online self-hosted runners labelled `benjis-ci`.
After 2 consecutive misses it flips org variable `CI_RUNNER_JSON` to `"ubuntu-latest"`
(GitHub-hosted); after 3 consecutive healthy checks it flips back — only if this
workflow did the flip. Queued runs older than 5 min in `scheduler` and
`benjis-quoting-tool` are cancelled and re-run so they pick up the new runner.

State lives in repo variable `HEALTH_STATE`
(`{"misses","healthy","flipped","last_alert"}`; missing/invalid = zero state).

## Log contract

Step `Evaluate runners` prints only `online|misses|healthy|decision|flipped|dry_run=<value>` lines.
Run via `workflow_dispatch` with `dry_run=true` to see the decision without any write.

## `failover` environment (branch `main` only)

Secrets: `HEALTH_APP_ID`, `HEALTH_APP_PRIVATE_KEY`, `SLACK_FAILOVER_WEBHOOK`,
optional `SENTRY_DSN` (capture is a silent no-op until set). Only the job declaring
`environment: failover` reads them. The Sentry event is tagged `release` (= `GITHUB_SHA`),
`environment` (`failover`) and `route` (`health-check|requeue|keepalive`); it carries no secrets.

## GitHub App `benjis-ci-health` (id 5337160) permissions

Exact keys are recorded by the operator from the infra #206 Step 7 runbook:

- Organization: Self-hosted runners — read
- Organization: Variables — read and write
- Repository `scheduler` and `benjis-quoting-tool`: Actions — write
- Repository `ci-runner-health`: Variables — write

## Keep-alive

GitHub disables scheduled workflows after 60 days without repo activity.
`keepalive.yml` (monthly cron + `workflow_dispatch`) calls
`PUT /actions/workflows/{id}/enable` for `health.yml` and `keepalive.yml` using
`GITHUB_TOKEN` (`actions: write` on that job only). It makes no commit or push.

## Re-run test result

Open question to be recorded by the operator: does a re-run of a cancelled queued run
re-evaluate `vars` (i.e. does the re-run land on `ubuntu-latest`)?

Result: _not yet tested — operator to record here._

Fallback if re-run does not re-evaluate `vars`: `workflow_dispatch` a fresh run of
the same workflow on the same ref (only for workflows that declare `workflow_dispatch`);
otherwise note the workflow here as needing a manual re-run.
