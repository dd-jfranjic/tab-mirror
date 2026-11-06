# Changelog

## 1.0.5 (2026-11-06)

- Applying a layout no longer stops halfway when Chrome has already closed an emptied tab group. A new group is made instead. This could leave tabs and groups out of step between the computers.
- A tab opened during a layout that failed to apply is now treated as shared, so closing it on the other computer closes it here too.

## 1.0.4 (2026-11-06)

- A change made while the computer is idle no longer gets lost. It goes out when you come back.
- A tab that exists on only one computer now reaches the other.
- A new tab page or other internal page no longer tears down and rebuilds tab groups on the other computer.
- An internal page inside a group no longer leaves a second group with the same name behind.
- Groups with the same name in the same window are merged. The layout from before the merge is saved in the history.
- If both computers change before sync catches up, tabs added on either side stay on both.
- A layout that fails to apply is retried, and until it succeeds this computer sends nothing by itself.
- After an update, a page opens once explaining how to turn off Chrome's own saved tab group sync.

## 1.0.3 (2026-11-01)

- A tab that exists on only one computer stays in its group instead of creating a second group with the same name.

## 1.0.2 (2026-10-30)

- A login page no longer spreads to the other computer when a redirected tab syncs.
- No duplicate tabs after restarting Chrome.
- Adds the `webNavigation` permission to tell a page's own redirect from a link you clicked.

## 1.0.1 (2026-10-30)

- Redirected pages no longer multiply.
- On start, the computer matches the shared layout before sending anything.
- A tab outside the shared layout is no longer closed.
- Local `file://` tabs are no longer synced.

## 1.0.0 (2026-10-30)

- First version: windows, tabs, order, pinned tabs, active tab and groups, through Chrome sync, with a history of 20 layouts.
