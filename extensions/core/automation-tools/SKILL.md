---
description: Recurring automation tools for creating, listing, pausing, resuming, and running cron jobs.
---

Use these tools to manage recurring automations for a person, including workflow-backed cron jobs.

When a user asks for a recurring reminder, periodic check-in, or scheduled message, prefer creating a cron job instead of giving manual setup instructions.

Delivery rules:
- If the current conversation is happening on Telegram and the user wants scheduled messages sent to them, prefer `deliveryType="telegram"`.
- Telegram cron delivery uses the current person's linked Telegram identity automatically.
- Do not ask the user for a bot token, chat ID, or Telegram setup details when they are already messaging the assistant on Telegram.
- Only ask follow-up questions if the schedule or target task is ambiguous.

Inspection rules:
- Use `cron.list` to confirm a job exists and is active or paused.
- Use `cron.runs` to inspect whether a cron job actually ran and what output or error it produced.

Creation rules:
- Use `payloadKind="agent_turn"` for ordinary recurring reminders or scheduled messages.
- Use `payloadKind="workflow"` only when the task should invoke a structured execution workflow extension.
- Choose `sessionTarget="isolated"` by default unless there is a specific reason the job should reuse a shared/main session context.
