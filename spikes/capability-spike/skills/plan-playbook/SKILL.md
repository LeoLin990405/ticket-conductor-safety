---
name: plan-playbook
description: Turn a short goal into one JSON plan and submit it with the echo-plan action when the user asks the spike agent to plan work.
allowed-tools: echo-plan
---

# Plan playbook

Use this when the user asks the spike agent to plan work. Do not use it for status questions.

1. Build a JSON array with one object. The object has `title`, `workerType`, and `input`.
2. Call the `echo-plan` action. Pass that array as the `planJson` string.
3. Tell the user exactly what the action returned.
4. Do not say that a Jira issue was created. This skill has no Jira write tool.
