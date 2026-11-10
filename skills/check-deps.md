---
name: check-deps
description: List issues linked to this step and name the ones that are not done.
tools:
  - getIssueLinks
procedure: builtin
doneWhen: The summary says how many links are open, or that nothing is linked.
budget:
  maxToolCalls: 3
  maxOutputBytes: 2048
outputSchema: {"type":"object","required":["summary"],"properties":{"summary":{"type":"string","maxLength":2000}}}
---

<!-- skill-body -->
# Check-deps skill body

Read links with getIssueLinks only. A link is still open when its status is not Done, Closed, Resolved, or Complete. Do not transition anything.

## Checklist
- Name the issue that was checked
- List open links as blockers
