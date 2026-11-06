# Linear reference

Look-ups for [`issue-tracker.md`](issue-tracker.md): the teams, labels, projects and views, and which Linear feature does which job.

## Teams

| team       | key   | holds                                                                                                                                                                                                         |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Atlas**  | `ATL` | product and engineering work, and the people-written notes that steer it                                                                                                                                      |
| **Growth** | `GRO` | records about outside people and companies: leads, beta-tester signups, credits requests, outreach. Forms file them here; statuses run New → To contact → In conversation → Onboarding → Onboarded / Declined |

Agents search Atlas to find work, so a lead filed there is noise in every search.

## Labels

Four **groups**, each single-select:

| group         | labels                                                                                                   | set it when                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**      | `Bug` · `Feature` · `Improvement` · `Chore` · `Research` · `Content`                                     | always                                                                                                                                                                                              |
| **Area**      | `Desktop` · `Web` · `Cloud` · `Agent runtime` · `Design system` · `Docs & site` · `Release` · `Business` | always, for the part of Atlas the work mainly touches                                                                                                                                               |
| **Readiness** | `ready-for-agent` · `needs-decision` · `needs-spec`                                                      | on open work. `ready-for-agent`: decision-complete, an agent can implement it unaided. `needs-decision`: a human must pick between stated options. `needs-spec`: the outcome itself is still vague. |
| **Origin**    | `handwritten` · `agent-written`                                                                          | always. `agent-written` when an agent drafted the issue, even if a person filed it.                                                                                                                 |

`Chore` is work with no user-visible change (refactors, provisioning, CI, dependency bumps). `Research` is a question to answer or a decision to make before building. `Content` is writing or media for people outside the codebase. Readiness belongs to the Atlas team, so it is dropped when an issue moves to Growth.

Ungrouped labels mark a **family** to pull up as a set; each one's description in Linear says what qualifies: `acp-stack`, `zed-port`, `resource-leak`, `misreports-to-user`, and the `wayfinder:*` labels the wayfinder skill applies. `tracker` marks a person's running log.

## Projects

Each project has a lead, a summary, a status, a **Pillar** label and, where one exists, its spec under Resources. Phases are milestones inside a project. Pick by subject:

| project                         | pillar                    | holds                                                                                                     |
| ------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Agents & ACP**                | 1 · Any agent             | the native engine, installed ACP agents, the agent store, MCP; milestone **Claude Code parity** (ATL-845) |
| **AI Gateway & metering**       | 1 · Any agent             | model access, entitlements, metering, the catalogue, spend alarms, model runbooks                         |
| **Atlas Sync/Project Unison**   | 2 · Timeline              | session capture, sync and the Timeline                                                                    |
| **Atlas Shared Threads**        | 2 · Timeline              | live multiplayer agent threads                                                                            |
| **Issues & Organisation agent** | 3 · Issues & cloud agents | issue tracking, sprints and an org-aware agent. Ideas until it starts                                     |
| **Handbook**                    | 4 · Handbook              | the team's living knowledge base                                                                          |
| **Launch & beta**               | Go-to-market              | docs, Atlas Learn videos, the beta programme and early builds, articles, launch posts                     |
| **Atlas Design System**         | Foundations               | tokens, the package, Storybook and the desktop redesign, by milestone                                     |
| **Maintenance & polish**        | Foundations               | defects and debt (ATL-212), small desktop UX fixes, and the **Windows release** milestone                 |

Completed: Atlas Session Artifacts, Atlas Team Chat, Atlas Spaces. New work on one of those starts in the closest live project.

## Views

Shared views, for the whole team: `Agent queue` (open, `ready-for-agent`), `Needs a human` (`needs-decision` or `needs-spec`), `Handwritten`, `Stuck` (started Atlas work untouched for 14 days, in the Atlas team's views), and `Roadmap by pillar` (live projects grouped by their Pillar label, with lead and health). Filter any view by **Delegate** to see what agents hold.

## Linear features, and what each one is for here

| job                                              | feature                                 | how we use it                                                                                                               |
| ------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| a goal spanning several projects                 | **Pillar** project label                | Initiatives are a trial feature on our plan, so projects carry a Pillar label and views group by it                         |
| a body of work with a goal and an end            | **Projects** + **milestones**           | milestones are the phases ("M0 · Decisions"), never a separate project per phase                                            |
| "where are we" reporting                         | **Project updates**                     | with a health. Ask Linear Agent (⌘J) to draft one from the project's activity                                               |
| a time-boxed batch of work                       | **Cycles**                              | off for now; turn on when the team commits to sprints                                                                       |
| a spec, PRD, runbook, decision or direction note | **Documents**, attached to the project  | link to it from the issues; the repo's ADRs stay in `docs/adr/`                                                             |
| a request from an outside person or company      | **Customers** + **customer requests**   | an enterprise lead becomes a Customer; the issues they ask for carry a request                                              |
| a repeatable issue shape                         | **Templates**                           | bug report, agent-written slice, Growth record: the template sets the labels and sections                                   |
| conventions every agent should follow            | **Agent guidance** (workspace and team) | Settings → Agents → Additional guidance: a short pointer to these docs. Linear passes it to every agent that works an issue |
| handing an issue to an agent                     | **Delegate**                            | the human stays the owner. Coding sessions spend the workspace's AI credits                                                 |
| incoming work from outside the team              | **Triage**                              | on for Atlas and Growth; both post new triage issues to Slack #triage. Rules, Intelligence, Asks, Loops need Business       |
| linking branches and PRs to issues               | **GitHub integration**                  | not yet connected: ATL-940                                                                                                  |
