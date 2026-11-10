---
name: research
description: Find related Jira issues for this Epic and summarise what they change.
tools:
  - searchIssues
procedure: builtin
doneWhen: The summary names the related issues, or says that none were found.
budget:
  maxToolCalls: 4
  maxOutputBytes: 2048
outputSchema: {"type":"object","required":["summary"],"properties":{"summary":{"type":"string","maxLength":2000},"confidence":{"type":"number","minimum":0,"maximum":1}}}
---

<!-- skill-body -->
# Research skill body

Search the project for issues that share the goal's words. Use only the searchIssues tool. Do not invent issue keys. The short result is a summary. The child issue keeps the full list.

## Checklist
- Use only the searchIssues tool
- Quote issue keys the search actually returned
