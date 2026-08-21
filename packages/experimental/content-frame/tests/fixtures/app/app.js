// Records that this document executed, so a spec can tell a live frame from a
// reloaded one: the counter restarts at 1 on every navigation of the frame.
window.__contentAppLoads = (window.__contentAppLoads ?? 0) + 1
