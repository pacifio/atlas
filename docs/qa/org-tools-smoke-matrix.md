# Organisation tools: live smoke matrix

Close-out for #125 (spec #110, ADR-0013, ADR-0014). One live run of Atlas Agent's organisation tools against a real organisation, in the same form as the UI-actions smoke run recorded for #109. **Nothing below has been run yet:** every Outcome says "not run" until someone runs the row in the app and records what happened. Each failure gets an issue on `Ukaykhingmarma28/atlas`, linked from its Outcome.

## Setup

- `bun run dev:app` on `feat/agent-org-tools`, signed in to an account that is a **member** of a test organisation, plus a second account that is an **admin** of it (for rows 12a/12b), and a teammate account signed in elsewhere (web or a second machine) to see messages, replies and pages arrive.
- A Project bound to a Workspace in that organisation, with at least one recorded session by the user and one by the teammate (one updated since Tuesday), a recorded session with two or more unresolved comments, a channel the user is in, and a second Workspace that is **restricted** (the teammate is not a member).
- Settings → General → "Let Atlas Agent act in your organisation" **on**; the chat on Atlas Agent, in its normal (not bypass) mode unless a row says otherwise.
- Keep the Logs panel open: every organisation call, refusals and failures included, should add one row there.

## Matrix

| # | Scenario | Steps | Expected | Outcome |
|---|---|---|---|---|
| 1 | whoami | New chat. Ask "Who am I in this organisation, and what session is this?" | One `org_whoami` tool row; the answer names the user, their role, the organisation, the Workspace and the current recorded session (or "not recorded yet"). One Logs row. | not run |
| 2 | Filtered read | Ask "What did @Teammate change since Tuesday?" (type the name, no mention) | `org_sessions` with `author` = the teammate and `since` = last Tuesday's date; the answer lists only the teammate's sessions active since then. If the name matches several members, the model asks which one instead of guessing. | not run |
| 3 | Last session | Ask "Open my last session and summarise it." | `org_sessions` with `author: "me"`, `limit: 1`, then `org_session` on that id; the summary matches the session's timeline. | not run |
| 4 | Keyword search | Ask "Find sessions that touched the auth refresh." | `org_sessions` with `q` set; results are sessions whose titles, messages, tools or checkpoints mention it. | not run |
| 5 | Comments summarised | In a chat written into the session with comments, ask "Summarise the open comments on this session." | `org_comments` on the current session, `unresolved_only: true`; each thread summarised with its author and anchor. | not run |
| 6 | Comment implemented, replied to, resolved | Ask "Fix the first open comment, reply that it's done, and resolve it." | The code change is made. Before the reply an approval card shows the **recipient** (the thread and who it reaches) and the **full reply body**; approve it. The reply appears under the thread for the teammate with exactly that body; `org_comment_resolve` then resolves the thread. Three Logs rows. | not run |
| 6b | Reply declined | Repeat row 6 on another comment and **deny** the card. | Nothing is posted; the model reads the refusal and says so. | not run |
| 7 | Bypass mode refuses a reply | Switch the chat to bypass mode. Ask for a reply to a comment. | No card; `org_comment_reply` comes back refused ("…bypass mode cannot approve outward actions… Nothing was posted."); nothing appears on the thread. Logs row shows the refusal. | not run |
| 8 | Report DM'd with its Session Reference | Ask "DM @Teammate a short report of this session." | Approval card shows the DM recipient and full body; approve. The teammate receives the message with a **Session Reference** card for the current recorded session. | not run |
| 8b | Report to a restricted Workspace's session | Ask for the same report about a session in the restricted Workspace. | The answer says there is no Session Reference because the Workspace is restricted; the card and the sent message both carry the session's timeline link on the body's last line instead. | not run |
| 9 | Post to a channel | Ask "Post 'deploy is green' to #general." | Card shows `#general` and the body; approve; the message appears in the channel as the user. | not run |
| 10 | Page created, drawn, opened | Ask "Create a page 'Architecture' in #general's Space, draw the org tool server's architecture on it, then open it." | `org_page_create` answers a page id; `org_page_write` crosses to the window and answers node/edge counts; unplaced nodes are laid out readably and edges carry labels; the teammate with the page open sees it live; the page is then opened in the window through a UI tool (`atlas_ui`). If no UI tool can open a Space page, record that here and file it. | not run |
| 11 | Clarifying question answered | Ask "Reply 'thanks' to the comment" on a session with several comments. | A question card above the composer (not an approval card) offers the matching comments; pick one; the turn continues to the reply card for that comment. | not run |
| 11b | Clarifying question dismissed | Repeat row 11 and dismiss the question card. | The turn does not hang: the model reads the dismissal as a tool error and ends or asks in prose. Nothing is posted. | not run |
| 12a | Member activity as admin | Signed in as the admin account, ask "What has @Teammate done this week?" | `org_member_activity` is offered and answers sessions, checkpoints, insertions, deletions and tokens, framed as recorded activity, not performance. | not run |
| 12b | Member activity absent as non-admin | Signed in as the member account, ask the same. | `org_member_activity` is not in the tool list; the model answers from `org_sessions` or says it cannot. | not run |
| 13 | Setting turned off mid-session | Mid-chat, switch "Let Atlas Agent act in your organisation" off, then ask another organisation question. | The next call is refused ("…organisation access is switched off in Settings → General…"); switch it back on and the same chat answers again. | not run |
| 14 | Sign-out mid-session | Mid-chat, sign out of Atlas, then ask an organisation question. | The next call is refused ("Nobody is signed in to Atlas on this machine any more…"); nothing is read or sent. | not run |
| 15 | Composer mentions | In the composer, mention a member, a conversation and a recorded session, then ask e.g. "Send @Member a link to @session in @#channel." | Each mention is inserted as a chip and reaches the tools as an `atlas-org://` link carrying the id; the tools resolve them without a candidates round trip. | not run |

## Also check

- Every row above produced exactly one Logs row per organisation call, including refusals.
- An ACP agent in the same Project is offered no `atlas_org` tools (the offer is by connection property, not agent name).
- Console errors: none expected.
