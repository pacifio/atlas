# Working with Linear

How Atlas uses Linear, in the order an agent meets it: picking work up, doing it, finishing it, filing new work, and reporting progress. Label definitions, the project map and the Linear feature table are in [`linear-reference.md`](linear-reference.md); read it before labelling or creating a project.

The two trackers split by **audience**: Linear (workspace `tryatlas`) is where the team plans and tracks its own work, through the Linear connector. GitHub Issues is where outside contributors report bugs and pitch features, and GitHub is the pull-request and release surface. A Linear issue is mirrored to GitHub only when it's worth advertising for outside help.

## Where things go

| it is…                                                          | it goes                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| one deliverable: build, fix, change, write, decide              | an **issue** on the Atlas team (`ATL`), in the project it belongs to                          |
| a body of work with its own goal                                | a **project**; its phases are **milestones**, never separate projects                         |
| a slice of a larger issue                                       | a **sub-issue** of that issue                                                                 |
| progress: what's done, what's next, what's blocked              | a **project update**, with a health. Never an issue                                           |
| reference: a runbook, a direction note, a plan, a decision      | a **document** on the project. A long spec may stay in its issue and be linked from Resources |
| a record about someone outside the team (lead, signup, request) | an issue on the **Growth** team (`GRO`), never Atlas                                          |

## Picking up an issue

1. Read the issue, its comments, its parent, and the project's description, documents and Resources. A spec linked from Resources is part of the brief.
2. Check its Readiness label. `ready-for-agent` means start. `needs-decision` means a person picks between stated options first: ask, don't choose. `needs-spec` means the outcome itself is unclear: ask.
3. Leave `handwritten` issues' wording alone; they are the founders' and the team's own voice. Label them, link them, and ask before rewriting or splitting one.
4. Branch from the issue: Linear's **copy git branch name** (⌘⇧.) gives `user/atl-123-slug`. Keeping the `ATL-` ID in the branch name is what lets Linear link the PR once the GitHub integration is on (ATL-940).
5. Set the issue to **In Progress**.

## While working

- Record a decision or a finding as a **comment** on the issue, not in a new issue.
- When the work splits, create **sub-issues** with the shape in "Filing an issue".
- When you find unrelated work, file it as its own issue rather than widening this one.

## Finishing

- Put the issue ID in the PR title or body (`ATL-123`).
- Opening the PR → **In Review**. Merged into `main` → **Done**. A release is a later tag on `main`, not a separate merge.
- Until the GitHub integration is connected (ATL-940), move the status by hand.
- A GitHub issue the PR fixes closes itself on merge through `Fixes #N` in the PR body.

## Filing an issue

An agent-written issue is read by the next agent, so write it to be picked up cold:

- **Title**: the outcome, in plain words. Prefix the surface in brackets when the project spans several (`[desktop]`, `[web]`).
- **Body**: `## Parent` (when it has one), `## What to build`, acceptance criteria, and the files or crates involved. Link the parent, the spec and any ADR by identifier.
- **Fields**: team, project, and one label from each group (Type, Area, Readiness, Origin); a parent when it is one slice of a larger issue. Leave the assignee empty unless the user names one.
- **Size**: one deliverable. Several slices make a parent issue with sub-issues; a goal and a timeline make a project.

A person filing between tasks needs only a title and a team; an agent fills in the rest later.

## Reporting progress

Post a **project update** in the project's Updates tab: what changed, what's next, what's blocked, and a health (on track, at risk, off track). An issue that is someone's running log carries `tracker`: leave it out of work queues and never close one.

## Operating rules

- Statuses: Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate. **Done** means shipped; **Canceled** means not doing it, or the content moved to a document. Say which, and why, in a closing comment.
- Bulk changes (status, labels, project, priority, assignee, team or relations on more than a handful of issues) need the user's go-ahead first, with the planned diff shown.
- Read an issue before updating it, and confirm its identifier and the intended change.
- Create a label or a project only when the user asks.

## When a skill says…

- **"publish to the issue tracker"**: create a Linear issue on the Atlas team, following "Filing an issue".
- **"fetch the relevant ticket"**: read that Linear issue with the connector.
