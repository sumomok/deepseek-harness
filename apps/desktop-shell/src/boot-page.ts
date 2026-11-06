/**
 * The window's boot page, the document it shows before the served UI and when
 * the served UI cannot be shown.
 * @module @deepseek-ai/dsh-desktop-shell/boot-page
 */

import { PRODUCT_NAME } from './brand.ts'
import { PALETTES, type Appearance } from './theme.ts'

/**
 * The boot page: a self-contained `data:` document (no external resource, no
 * preload) that the main process drives through `window.__dsh`. It shows one
 * phase at a time — the one actually running — because a checklist of things
 * that have not happened yet is a list of ways to wonder what went wrong.
 * @param version - the app version shown at the bottom of the page.
 * @param appearance - which palette to paint.
 * @param receipt - one line confirming an update, when this launch is the first
 * of a new version. It is baked into the document rather than pushed into it,
 * because the push path tolerates a page that has not finished loading by
 * dropping what it carries, which is right for a phase and wrong for this.
 * @param failure - the phase to show as failed and the summary under it, when
 * the page is loaded to report a failure. Baked in for the same reason as
 * `receipt`: the page replaces a served UI that is gone, so there is nothing
 * loaded to push into.
 * @returns the `data:` URL to load.
 */
export function bootPage(
  version: string, appearance: Appearance, receipt: string | undefined, failure?: { phase: number; message: string },
): string {
  // `<` escaped so a summary can never close the script element it sits in.
  const failed = failure === undefined
    ? ''
    : `window.__dsh.phase(${String(failure.phase)})\n  window.__dsh.fail(${JSON.stringify(failure.message).replace(/</g, '\\u003c')})`
  const colors = PALETTES[appearance]
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${PRODUCT_NAME.zh}</title><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: ${colors.gradient};
    color: ${colors.text}; font: 13px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif;
  }
  /* Dot grid and vignette, both purely decorative and both behind the column. */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    background-image: radial-gradient(circle, ${colors.grid} 1px, transparent 1px);
    background-size: 24px 24px;
  }
  body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    box-shadow: inset 0 0 180px 40px ${colors.vignette};
  }
  main { position: relative; width: 100%; max-width: 460px; padding: 0 32px; }
  .glow {
    position: absolute; left: 4px; top: -88px; width: 320px; height: 320px;
    pointer-events: none; transform-origin: center;
    background: radial-gradient(circle, ${colors.glow} 0%, transparent 68%);
    animation: breathe 8s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { transform: scale(1); opacity: .75; }
    50% { transform: scale(1.12); opacity: 1; }
  }
  .enter { opacity: 0; animation: enter .32s ease-out forwards; }
  @keyframes enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .wordmark { position: relative; font-size: 40px; font-weight: 700; line-height: 1.15; animation-delay: 0ms; }
  /* The Chinese glyphs take a real CJK face; only the caret stays monospace,
     which is the one character a mono stack renders better than a text face. */
  .wordmark .zh {
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    color: ${colors.text}; letter-spacing: .02em;
  }
  .caret {
    display: inline-block; margin-left: 8px; color: ${colors.accent};
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
    animation: blink 1.1s steps(2) infinite;
  }
  @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  /* Fixed height and stacked rows: one phase replaces another without the
     column below it moving. */
  .phases { position: relative; height: 30px; margin-top: 36px; }
  .phase {
    position: absolute; inset: 0; display: flex; align-items: baseline; gap: 10px;
    font: 13px/2.1 ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
    color: ${colors.text}; opacity: 0; transition: opacity .28s ease;
  }
  .phase.showing { opacity: 1; }
  .mark { flex: none; width: 1em; color: ${colors.accent}; animation: pulse 1.6s ease-in-out infinite; }
  .phase.failed .mark { color: ${colors.danger}; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
  .label { font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif; }
  .elapsed { color: ${colors.muted}; }
  .receipt { position: relative; margin-top: 16px; font-size: 11px; color: ${colors.accent}; }
  .hint { position: relative; margin-top: 16px; font-size: 11px; color: ${colors.muted}; }
  .failure { position: relative; margin-top: 16px; display: none; }
  body.failed .failure { display: block; }
  .summary {
    font-size: 13px; color: ${colors.text}; word-break: break-all; user-select: text;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
  }
  .lead { margin-top: 12px; font-size: 13px; color: ${colors.muted}; }
  footer {
    position: fixed; left: 0; right: 0; bottom: 24px; text-align: center;
    font-size: 11px; color: ${colors.muted};
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
  }
  @media (prefers-reduced-motion: reduce) {
    .glow, .caret, .mark, .enter { animation: none; }
    .enter { opacity: 1; }
  }
</style></head><body>
<main>
  <div class="glow"></div>
  <div class="wordmark enter"><span class="zh">从这里开始</span><span class="caret">▮</span></div>
  <div class="phases" id="phases">
    <div class="phase" data-phase="0"><span class="mark">◇</span><span class="label">校验运行环境</span><span class="elapsed"></span></div>
    <div class="phase" data-phase="1"><span class="mark">◇</span><span class="label">启动 dsh 服务</span><span class="elapsed"></span></div>
    <div class="phase" data-phase="2"><span class="mark">◇</span><span class="label">连接界面</span><span class="elapsed"></span></div>
  </div>
  ${receipt === undefined ? '' : `<div class="receipt">${receipt}</div>`}
  <div class="hint" id="hint" hidden>首次启动会被系统安全扫描拖慢,通常最多一两分钟</div>
  <div class="failure" id="failure">
    <div class="summary" id="summary"></div>
    <div class="lead">完整日志:菜单 帮助 → 查看日志</div>
  </div>
</main>
<footer>v${version}</footer>
<script>
  const rows = [...document.querySelectorAll('.phase')]
  let current = 0
  setTimeout(() => { document.getElementById('hint').hidden = false }, 8000)
  window.__dsh = {
    phase(index) {
      current = index
      rows.forEach((row, position) => {
        row.classList.toggle('showing', position === index)
        if (position !== index) row.querySelector('.elapsed').textContent = ''
      })
    },
    elapsed(seconds) {
      const cell = rows[current]?.querySelector('.elapsed')
      if (cell) cell.textContent = seconds < 3 ? '' : ' · ' + seconds + 's'
    },
    fail(message) {
      const row = rows[current]
      if (row) {
        row.classList.add('failed')
        row.querySelector('.mark').textContent = '✕'
        row.querySelector('.elapsed').textContent = ''
      }
      document.getElementById('hint').hidden = true
      document.getElementById('summary').textContent = message
      document.body.classList.add('failed')
    },
    block(message) {
      const hint = document.getElementById('hint')
      hint.textContent = message
      hint.hidden = false
    },
  }
  window.__dsh.phase(0)
  ${failed}
</script></body></html>`)
}
