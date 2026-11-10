---
name: test-plan
description: Turn the Epic goal into a checklist of cases a tester can run.
tools: []
procedure: checklist
doneWhen: The summary lists how many cases were written, and each case is a checklist line.
budget:
  maxToolCalls: 2
  maxOutputBytes: 2048
outputSchema: {"type":"object","required":["summary"],"properties":{"summary":{"type":"string","maxLength":2000},"notes":{"type":"array"},"confidence":{"type":"number","minimum":0,"maximum":1}}}
---

<!-- skill-body -->
# Test-plan skill body

No model call. Each checklist line becomes one case, checked against the step objective. Add a case by editing this file.

## Checklist
- Happy path matches the Epic goal
- A repeated request does not create a second child issue
- A missing dependency is called out before dispatch
