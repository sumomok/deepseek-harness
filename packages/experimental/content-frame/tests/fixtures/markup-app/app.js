// Records that this document executed, so a spec can tell a live frame from a
// reloaded one: the counter restarts at 1 on every navigation of the frame.
window.__contentAppLoads = (window.__contentAppLoads ?? 0) + 1

// The chart is drawn rather than written, so the only way to say which month
// ran highest is to look at it. Every value is a literal here and the fill is
// a flat colour, so the same document paints the same pixels on every load and
// on every machine that can draw at all.
const chart = document.querySelector('#throughput')
const paint = chart && chart.getContext('2d')
if (paint) {
  const bars = [40, 62, 55, 78, 96, 71, 58, 44]
  paint.fillStyle = '#ffffff'
  paint.fillRect(0, 0, chart.width, chart.height)
  paint.fillStyle = '#3366cc'
  for (let at = 0; at < bars.length; at += 1) {
    const height = bars[at] * 1.5
    paint.fillRect(16 + at * 38, chart.height - 12 - height, 24, height)
  }
  paint.fillStyle = '#111111'
  paint.fillRect(0, chart.height - 12, chart.width, 2)
}
