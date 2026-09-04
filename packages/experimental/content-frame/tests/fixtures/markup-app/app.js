// Records that this document executed, so a spec can tell a live frame from a
// reloaded one: the counter restarts at 1 on every navigation of the frame.
window.__contentAppLoads = (window.__contentAppLoads ?? 0) + 1

// `?pictures=code` leaves the pairing code and takes the other two out, for a
// scenario whose recording pins a content-addressed id of every picture it
// reads. A checked-in PNG decoded and re-encoded produces the same bytes
// wherever it is replayed; the chart below and the star are rasterized by the
// browser, where fonts and antialiasing are not promised to agree across
// platforms or across engine versions. The page is otherwise the same one —
// same heading, same table, same numbering above the pictures — so a scenario
// that takes the flag and one that does not read the same application.
if (new URLSearchParams(location.search).get('pictures') === 'code') {
  for (const drawn of document.querySelectorAll('#throughput, #glyph')) drawn.remove()
}

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
