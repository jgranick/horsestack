// One shared read of the OS "reduce motion" preference. It is queried from four different
// places — the windmill, the result count-up duration, the pile sway and the result ticks —
// and each of them is in a different module now, so the query lives on its own rather than
// being re-derived or passed down through three constructors.
//
// The MediaQueryList is created once and asked each time rather than snapshotted: the
// preference can change while the tab is open, and a game that keeps animating until reload
// is exactly the complaint the setting exists to answer.
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

export function prefersReducedMotion(): boolean {
  return reducedMotionQuery.matches;
}
