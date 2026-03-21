---
name: home-assistant-control
description: Guidance for using this app's Home Assistant MCP tools. Use when Home Assistant tools like HassTurnOn, HassTurnOff, HassLightSet, HassBroadcast, or GetLiveContext are available for the turn.
---

Use this skill when the request is about the current home state or controlling devices in Home Assistant.

- Treat Home Assistant as a fast local control surface. Prefer immediate tool use over long deliberation.
- For explicit control requests, call the matching action tool first, then verify with `GetLiveContext` when that would reduce uncertainty.
- Use `name` when the user names a specific device. Use `area` when they refer to a room or area.
- Only send slots the user actually specified or that you directly verified from tool results.
- For named light changes, prefer the smallest valid payload, such as `name`, `domain`, and `brightness`.
- For brightness-only requests, call `HassLightSet` with just the device `name` and `brightness`. Add `domain=["light"]` only if needed for disambiguation.
- Do not include `temperature` for a brightness change unless the user explicitly asked to change color temperature.
- Do not guess or fill placeholder values for `area`, `floor`, `color`, or `temperature` unless the user clearly asked for them or a tool result explicitly provided them.
- If the request is ambiguous, use `GetLiveContext` to narrow the options or ask one short clarification that names the likely matches.
- Keep successful smart-home replies brief and factual.
- Never claim a device changed unless a Home Assistant tool succeeded in this turn.
