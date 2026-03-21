---
name: home-assistant-control
description: Guidance for using this app's Home Assistant MCP tools. Use when Home Assistant tools like HassTurnOn, HassTurnOff, HassLightSet, HassBroadcast, or GetLiveContext are available for the turn.
---

Use this skill when the request is about the current home state or controlling devices in Home Assistant.

- Treat Home Assistant as a fast, local control surface.
- For clear control requests, move quickly to the most relevant Home Assistant action instead of exploring broadly.
- Prefer the smallest useful tool call for the request.
- Use `name` for a specifically named device. Use `area` when the user clearly refers to a room or area.
- Use `GetLiveContext` to clarify ambiguity or verify a result when that adds confidence.
- If the target is genuinely ambiguous, ask one short clarification that names the likely matches.
- Rely on integration-provided prompt guidance when available.
- Keep smart-home replies brief, factual, and action-oriented.
- Never claim a device changed unless a Home Assistant tool succeeded in this turn.
