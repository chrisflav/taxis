---
name: taxis-triage
description: Triage open issues in a taxis tracker — review the open backlog, summarize it, and propose or apply labels, assignees, and state changes. Use when the user asks to triage, groom, clean up, or review the taxis backlog.
---

# Triaging the taxis backlog

A structured pass over open issues. Uses the `taxis_` MCP tools (see the
`taxis-issues` skill for the full tool reference and configuration).

## Procedure

1. **Load context once.** Call `taxis_list_labels` and `taxis_list_actors` up front
   and keep the id↔name maps for the whole pass — you'll need them to read and set
   labels/assignees by name.

2. **Pull the backlog.** `taxis_list_issues { state: "open" }` (page with `limit`/
   `offset` if there are many). For anything you'll act on, `taxis_get_issue` to see
   the description, existing labels, assignees, comments, and dependencies.

3. **Assess each issue.** Note:
   - Is the title/description clear enough to act on? If not, flag for clarification.
   - Are there fitting labels not yet applied? (map names → ids)
   - Should it be assigned? Is it a duplicate, stale, or already done?
   - Is it blocked by a `dependencies` issue that is still open?

4. **Propose before applying.** Present a concise table — issue id, title, and the
   changes you recommend (labels to add, assignee, state change, close-as-duplicate).
   **Confirm with the user before making changes**, unless they told you to apply
   directly. Triage mutates shared, outward-facing state.

5. **Apply.** Once approved:
   - Labels/assignees: `taxis_update_issue`. Arrays **replace** the set, so start
     from the issue's current `labels`/`assignees`, add your ids, send the full array.
   - Resolve: `state: "completed"` (done) or `"closed"` (won't do / duplicate).
   - For a duplicate, `taxis_add_comment` pointing at the canonical issue before
     closing it.

6. **Summarize.** Report what changed and what still needs a human decision.

## Guidance

- Never invent label or actor ids — resolve them from the lists in step 1; if a name
  is ambiguous or absent, ask.
- Be conservative with deletion. Prefer `closed` over `taxis_delete_issue`; deleting
  is permanent and loses history.
- Keep edits minimal and attributable — one coherent change per issue beats churn.
