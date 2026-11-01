export function watchScroll(measure: () => void) {
  // Capture phase: the stage is its own scroll container, and a bubbled
  // listener on window never hears it scroll.
  window.addEventListener("scroll", measure, true);
}
