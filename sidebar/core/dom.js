// WatchTogether — DOM helper.
// The one utility every module shares: `$(id)` → document.getElementById(id).
// (Kept as its own leaf module so importing it never drags in other state.)

export function $(id) {
  return document.getElementById(id);
}
