# Demo seed — Payments project

Source of truth for the issue text: [seed.json](seed.json). If this page and the JSON disagree, follow the JSON. Summaries below match it.

This creates Jira issues only. It does not create a Conductor run, a step, an effect, or a memory. The first live run writes those. `expectedWriteBack` in the JSON is what that run should store. Do not insert it by hand.

Site: `your-site.atlassian.net`, product Jira, environment development. Do not create this data in production.

Do not commit `JIRA_EMAIL`, `JIRA_API_TOKEN`, or any Forge variable value. Set them in the shell for the REST checks, then leave them out of the repo.

## 1. Create the project

In Jira, create a company-managed software project.

| Field | Value |
|---|---|
| Name | Payments |
| Key | PAY |
| Type | Software, company-managed (`projectTypeKey` `software`, style `classic`) |

Company-managed gives you the Epic, Story, Bug, and Task types used in the seed. A team-managed project can still host the demo if it has an Epic type and a parent field. Use `epicRef` in the JSON as "this issue belongs to that Epic" either way.

## 2. Create the issues

Create them in `createOrder`. Put the Epic link (company-managed Epic Link, or team-managed parent) on every issue that has `epicRef`.

| Order | Ref | Type | Summary | Labels | Epic |
|---|---|---|---|---|---|
| 1 | `epic-refunds` | Epic | Ship payment refunds | `conductor-demo`, `refunds`, `payments` | — |
| 2 | `epic-reconcile` | Epic | Reconcile refund ledger | `conductor-demo`, `refunds`, `ledger` | — |
| 3 | `story-refund-api` | Story | Define the refund API | `conductor-demo`, `refunds`, `payments` | Ship payment refunds |
| 4 | `story-ledger-line` | Story | Write the refund ledger line | `conductor-demo`, `refunds`, `ledger` | Ship payment refunds |
| 5 | `bug-duplicate-webhook` | Bug | Duplicate refund webhook creates two ledger lines | `conductor-demo`, `refunds`, `ledger` | Ship payment refunds |
| 6 | `task-capture-dependency` | Task | Confirm dependency on payment capture | `conductor-demo`, `payments` | Ship payment refunds |

Paste each `description` from `seed.json`. Labels are the four in `labels`: `conductor-demo`, `refunds`, `payments`, `ledger`. Every seeded issue carries `conductor-demo`.

On **Reconcile refund ledger**, add a Relates link to **Ship payment refunds** (`issueLinks[0]`, type `Relates`).

Keys are whatever the site assigns. Scenarios talk about refs (`epic-refunds`) and summaries. When you call the agent, pass the real key.

## 3. Check

JQL:

```text
project = PAY AND labels = conductor-demo ORDER BY created ASC
```

Expect 6 issues, 2 of them Epics. The refunds Epic contains the story, the other story, the bug, and the task. The reconcile Epic relates to the refunds Epic.

Optional REST check, after `JIRA_EMAIL` and `JIRA_API_TOKEN` are exported. This reads. It does not print the token.

```bash
curl -sS -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -H "Accept: application/json" \
  --get \
  --data-urlencode "jql=project = PAY AND labels = conductor-demo ORDER BY created ASC" \
  --data-urlencode "fields=summary,issuetype,labels" \
  --data-urlencode "maxResults=20" \
  "https://your-site.atlassian.net/rest/api/3/search/jql"
```

If your site still serves the older search route, the same JQL works at `/rest/api/3/search`.

## 4. What you type in Rovo

On Epic **Ship payment refunds**, start from the primary goal in `demo.primaryGoal`:

> Plan and run this Epic: ship payment refunds that are idempotent on the payment id, with one ledger line and a webhook that keeps the original line.

The reference plan is `demo.planSteps` (6 steps). The agent may title steps differently. A valid plan has 3 to 8 steps, uses `research`, `draft-spec`, and `check-deps`, and covers the API idempotency rule, the capture dependency, the ledger line, and the duplicate webhook. `stepsJson` is `JSON.stringify` of that array. There is no `summarize` step in the plan. The run adds `summarize` when the planned steps are done.

On Epic **Reconcile refund ledger**, after the first run has written memory, use `demo.relatedGoal`:

> Plan how to reconcile the refund ledger with the provider. Keep one refund per payment id.

`recall-memory` should return the `expectedWriteBack` decision (`memType` `decision`, `validUntil` `0`).

## 5. Stuck-step recording

For the video's watchdog shot, set the development Forge variable named in `demo.stuckStepVariable`:

```text
CONDUCTOR_DEMO_STUCK_STEP
```

WP4 owns the value format. Any non-empty value should hang one step once. Do not commit the value. Unset it when you are not recording that shot. With the variable unset, scenario 01 expects no hang.

The Watchdog runs on a `fiveMinute` schedule, and a step's `deadlineAt` is 12 minutes after it starts. A live judge may have to wait for both. WP4 can shorten `deadlineAt` while the variable is set. This package does not decide that. The video cuts across the wait. See [scenario 02](../tests/scenarios/02-stuck-step-watchdog.md).

## 6. REST create, if you are not using the UI

Look up issue type ids and the Epic Link field on this site before you post. Field ids differ by site. Company-managed Epic Link is often a custom field. Team-managed uses `parent`.

Create `epic-refunds` and `epic-reconcile` first. Then create each child with the Epic association. Then create the Relates link.

One issue, with description as a single ADF paragraph (replace the type id and the Epic field):

```bash
curl -sS -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -X POST \
  "https://your-site.atlassian.net/rest/api/3/issue" \
  -d @- <<'JSON'
{
  "fields": {
    "project": { "key": "PAY" },
    "summary": "Ship payment refunds",
    "issuetype": { "name": "Epic" },
    "labels": ["conductor-demo", "refunds", "payments"],
    "description": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "Paste the epic-refunds description from demo/seed.json."
            }
          ]
        }
      ]
    }
  }
}
JSON
```

Link the two Epics after both keys exist:

```bash
curl -sS -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -X POST \
  "https://your-site.atlassian.net/rest/api/3/issueLink" \
  -d @- <<'JSON'
{
  "type": { "name": "Relates" },
  "inwardIssue": { "key": "PAY-RECONCILE" },
  "outwardIssue": { "key": "PAY-REFUNDS" }
}
JSON
```

Replace `PAY-RECONCILE` and `PAY-REFUNDS` with the keys from the create responses. `epic-reconcile` is the inward issue in that example only so the link exists. Direction for Relates does not change the demo.

Stop when the JQL in section 3 returns the six summaries. Do not seed runs or memories.
