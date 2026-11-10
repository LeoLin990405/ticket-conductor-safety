---
name: summarize
description: Aggregate finished step summaries into the run summary and its decisions.
tools: []
procedure: builtin
doneWhen: The summary counts the finished steps and keeps their decisions.
budget:
  maxToolCalls: 1
  maxOutputBytes: 2048
outputSchema: {"type":"object","required":["summary"],"properties":{"summary":{"type":"string","maxLength":8000}}}
---

<!-- skill-body -->
# Summarize skill body

This pack is for the closing step the run adds itself. Do not put summarize in a plan. The stored output keeps the summary and the decisions so write-back can record them. There is no child issue for this step.

## Checklist
- Count finished steps
- Copy decisions through unchanged
