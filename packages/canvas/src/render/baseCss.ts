/**
 * Structural CSS for the canvas, injected once per document. Design content
 * styles are always inline (from the Loro document); these rules only set up
 * layers, containment and defaults that every node shares (every layer is
 * `box-sizing: border-box`, text is `white-space: pre-wrap`).
 */
const CSS = `
.ic-root{position:absolute;inset:0;overflow:hidden;contain:strict;isolation:isolate;user-select:none;-webkit-user-select:none;touch-action:none;outline:none;}
.ic-world{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;will-change:transform;}
.ic-top{position:absolute;left:0;top:0;width:max-content;contain:layout style;}
.ic-top.ic-offscreen{content-visibility:hidden;}
.ic-node{box-sizing:border-box;}
.ic-text{white-space:pre-wrap;}
.ic-img{display:block;-webkit-user-drag:none;}
.ic-img-missing{background:#E3E3E3 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='%23A3A3A3' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'/%3E%3C/svg%3E") center/24px 24px no-repeat;}
.ic-standin{position:absolute;left:0;top:0;overflow:hidden;pointer-events:none;}
.ic-standin>.ic-thumb{position:absolute;left:0;top:0;width:100%;height:100%;-webkit-user-drag:none;}
.ic-overlay{position:absolute;left:0;top:0;pointer-events:none;}
.ic-measure{position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;contain:strict;pointer-events:none;}
.ic-mwrap{position:absolute;left:0;top:0;width:max-content;contain:layout style;}
.ic-group>*{pointer-events:auto;}
.ic-group{position:relative;pointer-events:none;}
.ic-vector{pointer-events:none;}
.ic-vector>path{pointer-events:visiblePainted;}
.ic-drag{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;}
.ic-drag>*{position:absolute!important;margin:0!important;pointer-events:none!important;}
.ic-drag-src{visibility:hidden!important;}
.ic-hidden{display:none!important;}
.ic-incoming{opacity:0!important;}
.ic-revealing{animation:ic-reveal 320ms ease-out;}
@keyframes ic-reveal{from{opacity:0;}}
.ic-editing{user-select:text;-webkit-user-select:text;cursor:text;outline:none;caret-color:currentColor;}
`

const STYLE_ID = 'baren-canvas-base'
const adopted = new WeakMap<Document, CSSStyleSheet>()

/**
 * Install the structural CSS once per document. A constructed stylesheet is
 * used where available: unlike a <style> element it is not blocked by a
 * strict Content-Security-Policy without 'unsafe-inline'.
 */
export function ensureBaseCss(doc: Document = document): void {
  const existing = adopted.get(doc)
  if (existing) {
    // Someone may have replaced adoptedStyleSheets wholesale; put ours back.
    if (!doc.adoptedStyleSheets.includes(existing)) {
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, existing]
    }
    return
  }
  if (doc.getElementById(STYLE_ID)) return
  const view = doc.defaultView
  if (view && 'adoptedStyleSheets' in doc && typeof view.CSSStyleSheet === 'function') {
    try {
      const sheet = new view.CSSStyleSheet()
      sheet.replaceSync(CSS)
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      adopted.set(doc, sheet)
      return
    } catch {
      // Fall back to a <style> element below.
    }
  }
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
}
