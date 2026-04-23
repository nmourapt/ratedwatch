// Chrono24 link builder — the single choke point for constructing any
// URL pointing at Chrono24.
//
// Every caller (public movement page in slice 14, public watch page in
// slice 15, future SPA CTAs, future emails) MUST go through this module
// so the affiliate-ID wrapping planned for a later slice is a one-line
// change here rather than a grep-and-replace across the repo.
//
// Two distinct shapes exist because the movement page and the watch
// page search Chrono24 on different fields:
//
//   - `buildChrono24UrlForMovement` — /m/:id — searches on the
//     canonical caliber name (e.g. "ETA 2892-A2").
//   - `buildChrono24UrlForWatch` — /w/:id — searches on the owner's
//     brand + model (e.g. "Rolex Submariner").

export {
  buildChrono24UrlForMovement,
  type MovementLinkInput,
} from "./movement";
export {
  buildChrono24UrlForWatch,
  type WatchLinkInput,
} from "./watch";
