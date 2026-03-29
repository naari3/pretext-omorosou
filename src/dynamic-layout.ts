/*
three.js + pretext dynamic layout demo.
- A single 3D model (TorusKnot) is rendered at the center with three.js.
- Each frame, its silhouette hull is extracted from a low-res render target.
- The pretext layout engine flows text around the hull in real time.
- Clicking the model spins it; the text reflows around the new silhouette.
*/
import { layoutNextLine, prepareWithSegments, walkLineRanges, type LayoutCursor, type PreparedTextWithSegments } from '@chenglou/pretext'
import { BODY_COPY } from './dynamic-layout-text.ts'
import { createThreeScene } from './three-scene.ts'
import {
  carveTextLineSlots,
  getPolygonIntervalForBand,
  getRectIntervalsForBand,
  isPointInPolygon,
  type Interval,
  type Point,
  type Rect,
} from './wrap-geometry.ts'

const BODY_FONT = '13px "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif'
const BODY_LINE_HEIGHT = 21
const CREDIT_TEXT = 'Leopold Aschenbrenner'
const CREDIT_FONT = '12px "Helvetica Neue", Helvetica, Arial, sans-serif'
const CREDIT_LINE_HEIGHT = 16
const HEADLINE_TEXT = 'SITUATIONAL AWARENESS: THE DECADE AHEAD'
const HEADLINE_FONT_FAMILY = '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif'
const HINT_PILL_SAFE_TOP = 72
const NARROW_BREAKPOINT = 760
const NARROW_COLUMN_MAX_WIDTH = 430

// Model rotation speeds (rad/s per axis)
const ROTATION_SPEED_X = 0.15
const ROTATION_SPEED_Y = 0.2
const ROTATION_SPEED_Z = 0.1

// Scale pulsation
const SCALE_BASE = 1
const SCALE_AMPLITUDE = 0.6
const SCALE_SATURATION = 2.5
const SCALE_SPEED = 0.35

// Tremor (tensing shake at peak scale)
const TREMOR_AMPLITUDE = 0.02
const TREMOR_FREQ_1 = 81
const TREMOR_FREQ_2 = 129
const TREMOR_FREQ_3 = 201
const TREMOR_WEIGHT_2 = 0.7
const TREMOR_WEIGHT_3 = 0.5
const TREMOR_NORMALIZE = 2.2

// Click spin
const SPIN_DURATION = 900

type ModelKind = 'center'

type SpinState = {
  from: number
  to: number
  start: number
  duration: number
}

type ModelAnimationState = {
  angle: number
  spin: SpinState | null
}

type PositionedLine = {
  x: number
  y: number
  width: number
  text: string
}

type BandObstacle =
  | { kind: 'polygon'; points: Point[]; horizontalPadding: number; verticalPadding: number }
  | { kind: 'rects'; rects: Rect[]; horizontalPadding: number; verticalPadding: number }

type PageLayout = {
  isNarrow: boolean
  gutter: number
  pageWidth: number
  pageHeight: number
  centerGap: number
  columnWidth: number
  headlineRegion: Rect
  headlineFont: string
  headlineLineHeight: number
  creditGap: number
  copyGap: number
}

// ── DOM ─────────────────────────────────────────────────────────────────────────

const stageNode = document.getElementById('stage')
if (!(stageNode instanceof HTMLDivElement)) throw new Error('#stage not found')
const stage = stageNode
const pageNodeRaw = document.querySelector('.page')
if (!(pageNodeRaw instanceof HTMLElement)) throw new Error('.page not found')
const pageNode: HTMLElement = pageNodeRaw
const threeCanvas = document.getElementById('three-canvas') as HTMLCanvasElement
if (!threeCanvas) throw new Error('#three-canvas not found')

// ── Three.js ────────────────────────────────────────────────────────────────────

const threeScene = createThreeScene(threeCanvas)

// ── State ───────────────────────────────────────────────────────────────────────

const preparedByKey = new Map<string, PreparedTextWithSegments>()
const events = { mousemove: null as MouseEvent | null, click: null as MouseEvent | null, blur: false }
const pointer = { x: -Infinity, y: -Infinity }
let currentHull: Point[] = []
let hoveredModel: ModelKind | null = null
const modelAnimation: ModelAnimationState = { angle: 0, spin: null }
let startTime = 0

// ── DOM cache ───────────────────────────────────────────────────────────────────

const headline = document.createElement('h1')
headline.className = 'headline'
const credit = document.createElement('p')
credit.className = 'credit'
credit.textContent = CREDIT_TEXT
const headlineLines: HTMLDivElement[] = []
const bodyLines: HTMLDivElement[] = []

function mountStaticNodes(): void {
  stage.append(headline, credit)
}

// ── Text preparation ────────────────────────────────────────────────────────────

await document.fonts.ready

const preparedBody = getPrepared(BODY_COPY, BODY_FONT)
const preparedCredit = getPrepared(CREDIT_TEXT, CREDIT_FONT)
const creditWidth = Math.ceil(getPreparedSingleLineWidth(preparedCredit))

function getPrepared(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}::${text}`
  const cached = preparedByKey.get(key)
  if (cached !== undefined) return cached
  const prepared = prepareWithSegments(text, font)
  preparedByKey.set(key, prepared)
  return prepared
}

function getPreparedSingleLineWidth(prepared: PreparedTextWithSegments): number {
  let width = 0
  walkLineRanges(prepared, 100_000, line => { width = line.width })
  return width
}

function headlineBreaksInsideWord(prepared: PreparedTextWithSegments, maxWidth: number): boolean {
  let breaks = false
  walkLineRanges(prepared, maxWidth, line => {
    if (line.end.graphemeIndex !== 0) breaks = true
  })
  return breaks
}

// ── Layout helpers ──────────────────────────────────────────────────────────────

function getObstacleIntervals(obstacle: BandObstacle, bandTop: number, bandBottom: number): Interval[] {
  switch (obstacle.kind) {
    case 'polygon': {
      const interval = getPolygonIntervalForBand(
        obstacle.points, bandTop, bandBottom,
        obstacle.horizontalPadding, obstacle.verticalPadding,
      )
      return interval === null ? [] : [interval]
    }
    case 'rects':
      return getRectIntervalsForBand(
        obstacle.rects, bandTop, bandBottom,
        obstacle.horizontalPadding, obstacle.verticalPadding,
      )
  }
}

function layoutColumn(
  prepared: PreparedTextWithSegments,
  startCursor: LayoutCursor,
  region: Rect,
  lineHeight: number,
  obstacles: BandObstacle[],
  side: 'left' | 'right',
): { lines: PositionedLine[]; cursor: LayoutCursor } {
  let cursor: LayoutCursor = startCursor
  let lineTop = region.y
  const lines: PositionedLine[] = []
  while (true) {
    if (lineTop + lineHeight > region.y + region.height) break
    const bandTop = lineTop
    const bandBottom = lineTop + lineHeight
    const blocked: Interval[] = []
    for (let i = 0; i < obstacles.length; i++) {
      const intervals = getObstacleIntervals(obstacles[i]!, bandTop, bandBottom)
      for (let j = 0; j < intervals.length; j++) blocked.push(intervals[j]!)
    }
    const slots = carveTextLineSlots({ left: region.x, right: region.x + region.width }, blocked)
    if (slots.length === 0) { lineTop += lineHeight; continue }

    let slot = slots[0]!
    for (let i = 1; i < slots.length; i++) {
      const candidate = slots[i]!
      const bestW = slot.right - slot.left
      const candW = candidate.right - candidate.left
      if (candW > bestW) { slot = candidate; continue }
      if (candW < bestW) continue
      if (side === 'left') { if (candidate.left > slot.left) slot = candidate }
      else { if (candidate.left < slot.left) slot = candidate }
    }

    const line = layoutNextLine(prepared, cursor, slot.right - slot.left)
    if (line === null) break
    lines.push({ x: Math.round(slot.left), y: Math.round(lineTop), width: line.width, text: line.text })
    cursor = line.end
    lineTop += lineHeight
  }
  return { lines, cursor }
}

// ── DOM projection ──────────────────────────────────────────────────────────────

function syncPool<T extends HTMLElement>(pool: T[], length: number, create: () => T, parent: HTMLElement = stage): void {
  while (pool.length < length) { const el = create(); pool.push(el); parent.appendChild(el) }
  while (pool.length > length) { pool.pop()!.remove() }
}

function projectHeadlineLines(lines: PositionedLine[], font: string, lineHeight: number): void {
  syncPool(headlineLines, lines.length, () => {
    const el = document.createElement('div')
    el.className = 'headline-line'
    return el
  }, headline)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const el = headlineLines[i]!
    el.textContent = line.text
    el.style.left = `${line.x}px`
    el.style.top = `${line.y}px`
    el.style.font = font
    el.style.lineHeight = `${lineHeight}px`
  }
}

function projectBodyLines(lines: PositionedLine[], className: string, font: string, lineHeight: number, startIndex: number): number {
  for (let i = 0; i < lines.length; i++) {
    const el = bodyLines[startIndex + i]!
    el.className = className
    el.textContent = lines[i]!.text
    el.title = ''
    el.style.left = `${lines[i]!.x}px`
    el.style.top = `${lines[i]!.y}px`
    el.style.font = font
    el.style.lineHeight = `${lineHeight}px`
  }
  return startIndex + lines.length
}

// ── Headline sizing ─────────────────────────────────────────────────────────────

function fitHeadlineFontSize(headlineWidth: number, pageWidth: number): number {
  let low = Math.ceil(Math.max(22, pageWidth * 0.026))
  let high = Math.floor(Math.min(94.4, Math.max(55.2, pageWidth * 0.055)))
  let best = low
  while (low <= high) {
    const size = Math.floor((low + high) / 2)
    const font = `700 ${size}px ${HEADLINE_FONT_FAMILY}`
    const prep = getPrepared(HEADLINE_TEXT, font)
    if (!headlineBreaksInsideWord(prep, headlineWidth)) { best = size; low = size + 1 }
    else { high = size - 1 }
  }
  return best
}

// ── Animation ───────────────────────────────────────────────────────────────────

function easeSpin(t: number): number {
  const o = 1 - t
  return 1 - o * o * o
}

function updateModelSpin(state: ModelAnimationState, now: number): boolean {
  if (state.spin === null) return false
  const progress = Math.min(1, (now - state.spin.start) / state.spin.duration)
  state.angle = state.spin.from + (state.spin.to - state.spin.from) * easeSpin(progress)
  if (progress >= 1) { state.angle = state.spin.to; state.spin = null; return false }
  return true
}

function updateSpinState(now: number): boolean {
  return updateModelSpin(modelAnimation, now)
}

function startModelSpin(now: number): void {
  modelAnimation.spin = { from: modelAnimation.angle, to: modelAnimation.angle + Math.PI, start: now, duration: SPIN_DURATION }
}

// ── Page layout ─────────────────────────────────────────────────────────────────

function buildLayout(pageWidth: number, pageHeight: number, lineHeight: number): PageLayout {
  const isNarrow = pageWidth < NARROW_BREAKPOINT
  if (isNarrow) {
    const gutter = Math.round(Math.max(18, Math.min(28, pageWidth * 0.06)))
    const columnWidth = Math.round(Math.min(pageWidth - gutter * 2, NARROW_COLUMN_MAX_WIDTH))
    const headlineTop = 28
    const headlineWidth = pageWidth - gutter * 2
    const headlineFontSize = Math.min(48, fitHeadlineFontSize(headlineWidth, pageWidth))
    const headlineLineHeight = Math.round(headlineFontSize * 0.92)
    return {
      isNarrow, gutter, pageWidth, pageHeight, centerGap: 0, columnWidth,
      headlineRegion: { x: gutter, y: headlineTop, width: headlineWidth, height: Math.max(320, pageHeight - headlineTop - gutter) },
      headlineFont: `700 ${headlineFontSize}px ${HEADLINE_FONT_FAMILY}`,
      headlineLineHeight,
      creditGap: Math.round(Math.max(12, lineHeight * 0.5)),
      copyGap: Math.round(Math.max(18, lineHeight * 0.7)),
    }
  }

  const gutter = Math.round(Math.max(52, pageWidth * 0.048))
  const centerGap = Math.round(Math.max(28, pageWidth * 0.025))
  const columnWidth = Math.round((pageWidth - gutter * 2 - centerGap) / 2)
  const headlineTop = Math.round(Math.max(42, pageWidth * 0.04, HINT_PILL_SAFE_TOP))
  const headlineWidth = Math.round(Math.min(pageWidth - gutter * 2, Math.max(columnWidth, pageWidth * 0.5)))
  const headlineFontSize = fitHeadlineFontSize(headlineWidth, pageWidth)
  const headlineLineHeight = Math.round(headlineFontSize * 0.92)

  return {
    isNarrow, gutter, pageWidth, pageHeight, centerGap, columnWidth,
    headlineRegion: { x: gutter, y: headlineTop, width: headlineWidth, height: pageHeight - headlineTop - gutter },
    headlineFont: `700 ${headlineFontSize}px ${HEADLINE_FONT_FAMILY}`,
    headlineLineHeight,
    creditGap: Math.round(Math.max(14, lineHeight * 0.6)),
    copyGap: Math.round(Math.max(20, lineHeight * 0.9)),
  }
}

function evaluateLayout(
  layout: PageLayout,
  lineHeight: number,
  preparedBody: PreparedTextWithSegments,
  hull: Point[],
): {
  headlineLines: PositionedLine[]
  creditLeft: number
  creditTop: number
  leftLines: PositionedLine[]
  rightLines: PositionedLine[]
  contentHeight: number
} {
  const modelObstacle: BandObstacle = {
    kind: 'polygon', points: hull,
    horizontalPadding: Math.round(lineHeight * 0.6),
    verticalPadding: Math.round(lineHeight * 0.2),
  }
  const obstacles: BandObstacle[] = hull.length > 0 ? [modelObstacle] : []

  // Headline
  const headlinePrepared = getPrepared(HEADLINE_TEXT, layout.headlineFont)
  const headlineResult = layoutColumn(
    headlinePrepared, { segmentIndex: 0, graphemeIndex: 0 },
    layout.headlineRegion, layout.headlineLineHeight,
    obstacles, 'left',
  )
  const headlineLines = headlineResult.lines
  const headlineRects = headlineLines.map(line => ({
    x: line.x, y: line.y, width: Math.ceil(line.width), height: layout.headlineLineHeight,
  }))
  const headlineBottom = headlineLines.length === 0
    ? layout.headlineRegion.y
    : Math.max(...headlineLines.map(l => l.y + layout.headlineLineHeight))

  // Credit
  const creditTop = headlineBottom + layout.creditGap
  const creditRegion: Rect = { x: layout.gutter + 4, y: creditTop, width: layout.headlineRegion.width, height: CREDIT_LINE_HEIGHT }
  const copyTop = creditTop + CREDIT_LINE_HEIGHT + layout.copyGap

  const creditBlocked = hull.length > 0
    ? getObstacleIntervals(modelObstacle, creditRegion.y, creditRegion.y + creditRegion.height)
    : []
  const creditSlots = carveTextLineSlots(
    { left: creditRegion.x, right: creditRegion.x + creditRegion.width },
    creditBlocked,
  )
  let creditLeft = creditRegion.x
  for (let i = 0; i < creditSlots.length; i++) {
    const slot = creditSlots[i]!
    if (slot.right - slot.left >= creditWidth) { creditLeft = Math.round(slot.left); break }
  }

  // Body columns
  if (layout.isNarrow) {
    const bodyRegion: Rect = {
      x: Math.round((layout.pageWidth - layout.columnWidth) / 2),
      y: copyTop, width: layout.columnWidth,
      height: Math.max(0, layout.pageHeight - copyTop - layout.gutter),
    }
    const bodyResult = layoutColumn(preparedBody, { segmentIndex: 0, graphemeIndex: 0 }, bodyRegion, lineHeight, obstacles, 'left')
    return { headlineLines, creditLeft, creditTop, leftLines: bodyResult.lines, rightLines: [], contentHeight: layout.pageHeight }
  }

  const leftRegion: Rect = { x: layout.gutter, y: copyTop, width: layout.columnWidth, height: layout.pageHeight - copyTop - layout.gutter }
  const rightRegion: Rect = {
    x: layout.gutter + layout.columnWidth + layout.centerGap,
    y: layout.headlineRegion.y, width: layout.columnWidth,
    height: layout.pageHeight - layout.headlineRegion.y - layout.gutter,
  }
  const titleObstacle: BandObstacle = {
    kind: 'rects', rects: headlineRects,
    horizontalPadding: Math.round(lineHeight * 0.95),
    verticalPadding: Math.round(lineHeight * 0.3),
  }

  const leftResult = layoutColumn(preparedBody, { segmentIndex: 0, graphemeIndex: 0 }, leftRegion, lineHeight, obstacles, 'left')
  const rightResult = layoutColumn(preparedBody, leftResult.cursor, rightRegion, lineHeight, [titleObstacle, ...obstacles], 'right')

  return { headlineLines, creditLeft, creditTop, leftLines: leftResult.lines, rightLines: rightResult.lines, contentHeight: layout.pageHeight }
}

// ── Frame commit ────────────────────────────────────────────────────────────────

function commitFrame(now: number): void {
  const lineHeight = BODY_LINE_HEIGHT
  const font = BODY_FONT
  const root = document.documentElement
  const pageWidth = root.clientWidth
  const pageHeight = root.clientHeight

  updateSpinState(now)

  // Update three.js model rotation and scale (slow continuous + click spin)
  const elapsed = (now - startTime) / 1000
  const rotation = {
    x: elapsed * ROTATION_SPEED_X,
    y: elapsed * ROTATION_SPEED_Y,
    z: elapsed * ROTATION_SPEED_Z,
  }
  const spinInfo = { angle: modelAnimation.angle, spin: modelAnimation.spin, now }
  const base = Math.tanh(SCALE_SATURATION * Math.sin(elapsed * SCALE_SPEED))
  // Tremor that kicks in only when the model is large, like straining muscles
  const tension = Math.max(0, base)
  const tremor = tension * tension * TREMOR_AMPLITUDE * (
    Math.sin(elapsed * TREMOR_FREQ_1) + TREMOR_WEIGHT_2 * Math.sin(elapsed * TREMOR_FREQ_2) + TREMOR_WEIGHT_3 * Math.sin(elapsed * TREMOR_FREQ_3)
  ) / TREMOR_NORMALIZE
  const scale = SCALE_BASE + SCALE_AMPLITUDE * base + tremor
  threeScene.animateVertices(elapsed, scale, rotation, spinInfo)

  threeScene.resize(pageWidth, pageHeight)
  threeScene.render()

  // Async hull extraction (PBO-based, no GPU pipeline stall)
  // Result arrives via microtask before next frame; layout uses previous hull (1-frame latency)
  threeScene.extractHull('center', pageWidth, pageHeight).then(hull => {
    currentHull = hull
  })

  // Text layout
  const layout = buildLayout(pageWidth, pageHeight, lineHeight)
  const { headlineLines, creditLeft, creditTop, leftLines, rightLines, contentHeight } =
    evaluateLayout(layout, lineHeight, preparedBody, currentHull)

  // Project to DOM
  pageNode.classList.toggle('page--mobile', layout.isNarrow)
  stage.style.height = `${contentHeight}px`

  headline.style.left = '0px'
  headline.style.top = '0px'
  headline.style.width = `${pageWidth}px`
  headline.style.height = `${pageHeight}px`
  headline.style.font = layout.headlineFont
  headline.style.lineHeight = `${layout.headlineLineHeight}px`
  headline.style.letterSpacing = '0px'
  projectHeadlineLines(headlineLines, layout.headlineFont, layout.headlineLineHeight)

  credit.style.left = `${creditLeft}px`
  credit.style.top = `${creditTop}px`
  credit.style.font = CREDIT_FONT
  credit.style.lineHeight = `${CREDIT_LINE_HEIGHT}px`

  syncPool(bodyLines, leftLines.length + rightLines.length, () => {
    const el = document.createElement('div')
    el.className = 'line'
    return el
  })
  let nextIndex = 0
  nextIndex = projectBodyLines(leftLines, 'line line--left', font, lineHeight, nextIndex)
  projectBodyLines(rightLines, 'line line--right', font, lineHeight, nextIndex)

  document.body.style.cursor = hoveredModel === null ? '' : 'pointer'
}

// ── Frame time display ──────────────────────────────────────────────────────────

const frameStat = document.createElement('div')
frameStat.style.cssText = 'position:fixed;top:8px;right:8px;font:12px/1 monospace;color:#fff;opacity:0.7;z-index:10;pointer-events:none'
document.body.appendChild(frameStat)

// ── Main loop ───────────────────────────────────────────────────────────────────

function animationLoop(now: number): void {
  const t0 = performance.now()

  // Process input events against the previous frame's hulls
  if (events.click !== null) { pointer.x = events.click.clientX; pointer.y = events.click.clientY }
  if (events.mousemove !== null) { pointer.x = events.mousemove.clientX; pointer.y = events.mousemove.clientY }

  hoveredModel = events.blur ? null
    : currentHull.length > 0 && isPointInPolygon(currentHull, pointer.x, pointer.y) ? 'center'
    : null

  if (events.click !== null) {
    if (currentHull.length > 0 && isPointInPolygon(currentHull, pointer.x, pointer.y)) {
      startModelSpin(now)
    }
  }

  events.mousemove = null
  events.click = null
  events.blur = false

  commitFrame(now)

  const dt = performance.now() - t0
  frameStat.textContent = `${dt.toFixed(1)}ms`

  requestAnimationFrame(animationLoop)
}

function hasActiveTextSelection(): boolean {
  const sel = window.getSelection()
  return sel !== null && !sel.isCollapsed && sel.rangeCount > 0
}

// ── Events ──────────────────────────────────────────────────────────────────────

pageNode.addEventListener('touchmove', event => {
  if (hasActiveTextSelection()) return
  event.preventDefault()
}, { passive: false })
document.addEventListener('mousemove', event => { events.mousemove = event })
window.addEventListener('blur', () => { events.blur = true })
document.addEventListener('click', event => { events.click = event })

// ── Boot ────────────────────────────────────────────────────────────────────────

mountStaticNodes()
startTime = performance.now()
requestAnimationFrame(animationLoop)
