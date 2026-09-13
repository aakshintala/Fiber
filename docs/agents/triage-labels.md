# Triage labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the label strings this repo uses.

| Role in mattpocock/skills | Label in this repo | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | The owner needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | `agent-ready` | Outcome and tests are clear; an agent can take it to a draft PR |
| `ready-for-human` | `needs-owner` | Needs owner credentials, machine, live service, or judgement |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role (for example "apply the AFK-ready triage label"), use the label from the second column.

`needs-design` is specific to this repo and sits outside the triage roles. It marks an issue whose open decisions or contract questions come before implementation. A wayfinder map resolves those decisions; `to-tickets` then produces `agent-ready` issues.
