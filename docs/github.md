# GitHub

Keel reads new issues, pull requests and comments in each team's repos, and (from **L3 Act**) can open issues
and comment. Connect it in **Setup → GitHub**, then list repos in each team's **Settings → Repos**
(`owner/repo`, one per line).

## Credentials

| Option | When | What to create |
| --- | --- | --- |
| Fine-grained token | One org, quick start | Repository access: the teams' repos. Permissions: Issues **read/write**, Pull requests **read/write**, Metadata read |
| GitHub App | Production, many repos | Permissions as above; install it on the repos; paste App id, private key and installation id |
| GitHub Enterprise Server | Self-hosted GitHub | Either of the above, plus the API URL (`https://ghe.acme.com/api/v3`) |

## How Keel hears about new activity

**Polling (default, nothing to set up).** Every 2 minutes Keel asks GitHub for issues, PRs and comments created
since the last poll in each team's repo. Two API calls per repo per poll: about 60 per repo per hour, far under
GitHub's 5,000/hour. The first poll only sets the starting point; Keel doesn't replay history. Several workers
share one poll schedule.

**Webhooks (optional, instant).** Use them when Keel has a public URL:

1. Pick a secret and set `KEEL_GITHUB_WEBHOOK_SECRET` (Compose `.env`, or `extraSecretEnv` in Helm). Restart.
2. In the repo or org: **Settings → Webhooks → Add webhook**
   - Payload URL: `https://<your keel>/hooks/github`
   - Content type: `application/json`
   - Secret: the same value
   - Events: **Issues**, **Issue comments**, **Pull requests**
3. GitHub's "Recent Deliveries" should show `200`.

With a webhook secret set, polling turns off unless `KEEL_GITHUB_POLL=on`. Running both is safe: a webhook
event and a polled one share the same id, so nothing is handled twice. `KEEL_GITHUB_POLL=off` turns polling off
entirely.

Keel ignores what it posted itself (each of its writes carries a hidden operation marker).

## What happens to an event

It's stored in the team's inbox first, then the worker handles it like a Slack message: a promise in a comment
("I'll fix this by Friday") becomes a commitment, `@keel` in an issue or comment gets an answer, and a new PR
counts toward the team's review queue. At L1/L2 anything Keel would write on GitHub waits in **Approvals**.

## Repo checkup

`keel checkup owner/repo` (or **Checkup** in the UI) grades a repo A–F: stale PRs, PRs waiting for review,
merge time, ownerless issues, CI on the default branch, CODEOWNERS, CONTRIBUTING and SECURITY.md. Read-only.
