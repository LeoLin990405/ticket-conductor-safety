---
name: draft-spec
description: Write a templated spec for one step from the Epic goal and the step input.
tools: []
procedure: builtin
doneWhen: The spec has a summary and the acceptance criteria from the step input.
budget:
  maxToolCalls: 2
  maxOutputBytes: 2048
outputSchema: {"type":"object","required":["summary"],"properties":{"summary":{"type":"string","maxLength":2000}}}
---

<!-- skill-body -->
# Draft-spec skill body

Format the step input as a short spec. Do not call Jira. The child issue comment holds the full markdown. The stored result stays a short summary.

## Checklist
- State the behaviour the Epic asked for
- Keep acceptance criteria as bullets
