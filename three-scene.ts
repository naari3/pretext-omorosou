import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import type { Point } from './wrap-geometry.ts'

// Hull extraction
const HULL_MAX_DIM = 1024
const HULL_ALPHA_THRESHOLD = 12
const HULL_SMOOTH_RADIUS = 6
const HULL_SAMPLE_COUNT = 120

// Camera
const CAMERA_FOV = 50
const CAMERA_Z = 5

// Wonky box geometry
const BOX_SIZE = 1.2
const BOX_JITTER = 0.35
const VERTEX_WOBBLE_SPEED_X = 0.7
const VERTEX_WOBBLE_SPEED_Y = 0.9
const VERTEX_WOBBLE_SPEED_Z = 1.1

// Bloom post-processing
const BLOOM_STRENGTH = 0.9
const BLOOM_RADIUS = 0.08
const BLOOM_THRESHOLD = 0.0
const BLOOM_RESOLUTION_SCALE = 3

export type ThreeScene = {
  resize(width: number, height: number): void
  render(): void
  setModelRotation(name: string, x: number, y: number, z: number): void
  setModelScale(name: string, scale: number): void
  animateVertices(elapsed: number): void
  extractHull(name: string, screenWidth: number, screenHeight: number): Promise<Point[]>
}

type WonkyCorner = {
  base: THREE.Vector3
  // per-axis random direction and phase for the wobble
  dir: THREE.Vector3
  phase: THREE.Vector3
}

// 12 triangles (2 per face), indices into the 8 corners
const FACE_INDICES = [
  [0,1,3], [0,3,2],
  [4,6,7], [4,7,5],
  [0,4,5], [0,5,1],
  [2,3,7], [2,7,6],
  [0,2,6], [0,6,4],
  [1,5,7], [1,7,3],
]

function makeWonkyBox(size: number, jitter: number): { geometry: THREE.BufferGeometry; corners: WonkyCorner[] } {
  const half = size / 2
  const bases = [
    [-half, -half, -half],
    [ half, -half, -half],
    [-half,  half, -half],
    [ half,  half, -half],
    [-half, -half,  half],
    [ half, -half,  half],
    [-half,  half,  half],
    [ half,  half,  half],
  ]

  const corners: WonkyCorner[] = bases.map(([x, y, z]) => ({
    base: new THREE.Vector3(x!, y!, z!),
    dir: new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
    ).normalize().multiplyScalar(jitter),
    phase: new THREE.Vector3(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    ),
  }))

  const geometry = new THREE.BufferGeometry()
  // 12 faces × 3 verts × 3 floats
  const posArray = new Float32Array(FACE_INDICES.length * 9)
  geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3))
  writeWonkyPositions(geometry, corners, 0)
  geometry.computeVertexNormals()
  return { geometry, corners }
}

function writeWonkyPositions(geometry: THREE.BufferGeometry, corners: WonkyCorner[], elapsed: number): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const arr = pos.array as Float32Array
  let offset = 0
  for (const face of FACE_INDICES) {
    for (const ci of face) {
      const c = corners[ci!]!
      arr[offset++] = c.base.x + c.dir.x * Math.sin(elapsed * VERTEX_WOBBLE_SPEED_X + c.phase.x)
      arr[offset++] = c.base.y + c.dir.y * Math.sin(elapsed * VERTEX_WOBBLE_SPEED_Y + c.phase.y)
      arr[offset++] = c.base.z + c.dir.z * Math.sin(elapsed * VERTEX_WOBBLE_SPEED_Z + c.phase.z)
    }
  }
  pos.needsUpdate = true
  geometry.computeVertexNormals()
}

export function createThreeScene(canvas: HTMLCanvasElement): ThreeScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setClearColor(0x000000, 1)
  renderer.setPixelRatio(window.devicePixelRatio)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100)
  camera.position.z = CAMERA_Z

  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9)
  dirLight.position.set(4, 6, 5)
  scene.add(dirLight)
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.3)
  rimLight.position.set(-3, -2, 4)
  scene.add(rimLight)

  const models = new Map<string, THREE.Mesh>()

  const wonky = makeWonkyBox(BOX_SIZE, BOX_JITTER)
  const blob = new THREE.Mesh(
    wonky.geometry,
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }),
  )
  blob.position.set(0, 0, 0)
  scene.add(blob)
  models.set('center', blob)

  // Bloom post-processing (MSAA render target for antialiasing)
  const msaaRT = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType })
  const composer = new EffectComposer(renderer, msaaRT)
  composer.addPass(new RenderPass(scene, camera))
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD)
  // Run bloom at higher resolution so the mip chain stays sharp when the model is small
  const bloomSetSize = bloomPass.setSize.bind(bloomPass)
  bloomPass.setSize = (w: number, h: number) => bloomSetSize(w * BLOOM_RESOLUTION_SCALE, h * BLOOM_RESOLUTION_SCALE)
  composer.addPass(bloomPass)
  composer.addPass(new OutputPass())

  let rtWidth = HULL_MAX_DIM
  let rtHeight = HULL_MAX_DIM
  const hullRT = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  })

  function resize(width: number, height: number) {
    renderer.setSize(width, height)
    composer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    const scale = HULL_MAX_DIM / Math.max(width, height)
    rtWidth = Math.max(1, Math.round(width * scale))
    rtHeight = Math.max(1, Math.round(height * scale))
    hullRT.setSize(rtWidth, rtHeight)
  }

  function render() {
    composer.render()
  }

  function setModelRotation(name: string, x: number, y: number, z: number) {
    const mesh = models.get(name)
    if (mesh) mesh.rotation.set(x, y, z)
  }

  function setModelScale(name: string, scale: number) {
    const mesh = models.get(name)
    if (mesh) mesh.scale.setScalar(scale)
  }

  async function extractHull(name: string, screenWidth: number, screenHeight: number): Promise<Point[]> {
    const mesh = models.get(name)
    if (!mesh) return []

    const others = [...models.values()].filter(m => m !== mesh)
    for (const m of others) m.visible = false

    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(hullRT)
    renderer.clear(true, true, true)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    renderer.setClearColor(0x000000, 1)

    for (const m of others) m.visible = true

    const w = hullRT.width
    const h = hullRT.height
    const buffer = new Uint8Array(w * h * 4)
    const pixels = await renderer.readRenderTargetPixelsAsync(hullRT, 0, 0, w, h, buffer)

    return buildHullFromPixels(pixels, w, h, screenWidth, screenHeight)
  }

  function animateVertices(elapsed: number) {
    writeWonkyPositions(wonky.geometry, wonky.corners, elapsed)
  }

  return { resize, render, setModelRotation, setModelScale, animateVertices, extractHull }
}

// Scan alpha channel from WebGL readPixels data to build a screen-space hull polygon.
// Same approach as wrap-geometry.ts getWrapHull, but operates on raw pixel data
// and outputs directly in screen coordinates (no normalized 0-1 step).
function buildHullFromPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  screenWidth: number,
  screenHeight: number,
): Point[] {
  // WebGL readPixels is bottom-up; flip y during scan
  const lefts: Array<number | null> = new Array(height).fill(null)
  const rights: Array<number | null> = new Array(height).fill(null)

  for (let rtY = 0; rtY < height; rtY++) {
    const y = height - 1 - rtY
    let left = -1
    let right = -1
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(rtY * width + x) * 4 + 3]!
      if (alpha < HULL_ALPHA_THRESHOLD) continue
      if (left === -1) left = x
      right = x
    }
    if (left !== -1 && right !== -1) {
      lefts[y] = left
      rights[y] = right + 1
    }
  }

  const validRows: number[] = []
  for (let y = 0; y < height; y++) {
    if (lefts[y] !== null) validRows.push(y)
  }
  if (validRows.length === 0) return []

  const smoothedLefts: number[] = new Array(height).fill(0)
  const smoothedRights: number[] = new Array(height).fill(0)

  // Envelope smoothing: take the outermost (min left, max right)
  // within the window so that corners are never clipped inward.
  for (const y of validRows) {
    let leftEdge = Infinity
    let rightEdge = -Infinity
    for (let offset = -HULL_SMOOTH_RADIUS; offset <= HULL_SMOOTH_RADIUS; offset++) {
      const sy = y + offset
      if (sy < 0 || sy >= height) continue
      if (lefts[sy] == null || rights[sy] == null) continue
      if (lefts[sy]! < leftEdge) leftEdge = lefts[sy]!
      if (rights[sy]! > rightEdge) rightEdge = rights[sy]!
    }
    if (!Number.isFinite(leftEdge)) continue
    smoothedLefts[y] = leftEdge
    smoothedRights[y] = rightEdge
  }

  const scaleX = screenWidth / width
  const scaleY = screenHeight / height

  const step = Math.max(1, Math.floor(validRows.length / HULL_SAMPLE_COUNT))
  const sampledRows: number[] = []
  for (let i = 0; i < validRows.length; i += step) sampledRows.push(validRows[i]!)
  const lastRow = validRows[validRows.length - 1]!
  if (sampledRows[sampledRows.length - 1] !== lastRow) sampledRows.push(lastRow)

  const points: Point[] = []
  for (const y of sampledRows) {
    points.push({ x: smoothedLefts[y]! * scaleX, y: (y + 0.5) * scaleY })
  }
  for (let i = sampledRows.length - 1; i >= 0; i--) {
    const y = sampledRows[i]!
    points.push({ x: smoothedRights[y]! * scaleX, y: (y + 0.5) * scaleY })
  }

  return points
}
