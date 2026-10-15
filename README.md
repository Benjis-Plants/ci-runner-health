# ci-runner-health

Scheduled health check that flips org variable `CI_RUNNER_JSON` between `"benjis-ci"` (self-hosted) and `"ubuntu-latest"` (GitHub-hosted) so CI keeps flowing when self-hosted runners die. App workflows read it as `fromJSON(vars.CI_RUNNER_JSON || '"ubuntu-latest"')`. Workflow only; Node 20 built-ins, no dependencies. Tests: `node --test`.

The repo is public: never commit secrets, runner names, host names or webhook URLs.

## GitHub App permissions (runbook Step 7, claude-agents#206)
- Organization: Self-hosted runners: read; Variables: read and write
- Repositories `scheduler` and `benjis-quoting-tool`: Actions: read and write
- This repository: Variables: write; Actions: write (needed for keep-alive)

<!-- OPERATOR: confirm the exact permission key names against the runbook Step 7 output; the runbook text did not list them verbatim. -->

## `failover` environment
All secrets live only in the `failover` environment (limited to branch `main`): `HEALTH_APP_ID`, `HEALTH_APP_PRIVATE_KEY`, `SLACK_FAILOVER_WEBHOOK`, `SENTRY_DSN`. Any job reading them declares `environment: failover`. No repo-level secrets.

## State
Repo variable `HEALTH_STATE` (JSON, written with the App token): `{"misses":0,"healthy":0,"flipped":false,"lastAlert":null}`. Missing or invalid = this default. `lastAlert` is epoch milliseconds. Written only when it changes.

Rules: 2 consecutive misses (no online `benjis-ci` runner) with the variable at `"benjis-ci"` flips to hosted and requeues stuck runs; 3 consecutive healthy checks after a flip flips back. Cold start never sets `"benjis-ci"`. While misses >= 2, an unhealthy Slack alert is sent at most every 6h. A runners API error is neither a miss nor healthy (`decision=api_error`, Sentry event, non-zero exit).

## Log contract
The `Evaluate runners` step prints only lines matching `^(online|misses|healthy|decision|flipped|dry_run)=[A-Za-z0-9_.-]+$`. `decision` is one of `none`, `flip_to_hosted`, `flip_back`, `alert`, `api_error`. Never printed: runner names, hosts, URLs, response bodies.

## Dry run
`workflow_dispatch` with `dry_run=true` performs reads only (no variable, state, Slack, cancel, re-run or dispatch writes).

## Requeue after a flip
For `scheduler` and `benjis-quoting-tool`, runs queued for more than 5 minutes are cancelled and re-run. If re-run returns an error, the workflow is dispatched on the run's `head_branch` instead.

Re-run of a cancelled queued run re-evaluates `vars`: GitHub documents that a re-run evaluates workflow expressions again, so it should pick up the new `CI_RUNNER_JSON`; the dispatch fallback covers the case where it does not.
result: pending (operator observes a real test at runbook Step 8)

## Keep-alive
GitHub disables scheduled workflows after 60 days without repo activity. `keepalive.yml` runs monthly (and on `workflow_dispatch`) and calls the enable-workflow API (`PUT /repos/{owner}/{repo}/actions/workflows/{id}/enable`) for `health.yml` and `keepalive.yml`. There are no commits to `main`.

## Observability
Errors (API failures, token mint, write failures) go to Sentry via `scripts/capture.mjs` (`release` = commit SHA, `environment` = `production`, `route` = `health`/`keepalive`/`requeue`; payload carries no secrets, hosts, URLs or message text). A failed workflow also posts to Slack via `SLACK_FAILOVER_WEBHOOK`. Without `SENTRY_DSN`, capture is a no-op.

## Merge held
Merging turns the 5-minute schedule live; it is Step 8 of claude-agents#206's runbook.
