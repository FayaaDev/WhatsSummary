# Client email draft workspace

**Mode:** Operate. One client export, two independently editable department drafts, explicit saving and manual copying. Product requirements come from the approved source plan and `src/contracts.ts`.

## Layout and controls

- Source form precedes shared progress and department tabs.
- Desktop editor shares a row with client-grouped history. Below 860px, history follows the editor; below 520px, source fields stack.
- Operations/Administration tabs expose independent statuses. Arrow keys wrap; Home/End select the first/last tab. One tab participates in the tab order.
- Every control has at least a 44px target. Keyboard focus uses a 3px blue outline; errors and progress use alert/status regions.
- Unsaved work requires confirmation before source changes, history replacement, or regeneration. Cancellation retains completed content.

## Visual rules

Light office-work surface (`#f3f5f7`), white editor, slate text (`#202d3d`), secondary text (`#526174`), blue actions (`#174d94`), red errors (`#9b2430`). System font, 16px body, 28px heading (26px mobile), 4px field/control corners. No decorative metrics, illustrations, gradients, or dashboard card grid.

## Verification scope

Desktop and 375px screenshots reviewed inline because the harness has no subagent tool. Source form, tabs, editor, history, wrapping, focus, and control dimensions were inspected. Mocked browser tests cover required state transitions. The mechanical design detector used its regex fallback; computed contrast was not evaluated by that tool. API integration remains pending PMS-awr.6.
