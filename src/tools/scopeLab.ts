/**
 * Scope Lab — a development gallery for the Scope visualizer.
 *
 * Scope has no library of named patterns. What you see is the product of four
 * state variables that the app re-rolls at random on bass onsets, so the only
 * way to know what it is capable of is to pin those variables and look. That
 * is what this page does: every cell runs the real `drawFrame` against
 * synthetic audio, with its parameters held fixed.
 *
 * Synthetic audio rather than the live analyser on purpose — the point is to
 * compare cells against each other, which needs every cell fed the identical
 * signal. The material selector covers the cases that actually change
 * behaviour (a hard kick vs a compressed master vs a sustained pad).
 *
 * Dev only. Vite serves it from tools/scope-lab.html; it is not part of the
 * app bundle and not in the production build's entry list.
 */

import { createDrawState, drawFrame, type DrawState } from '../visualizers/worker/draw';
import { PALETTES } from '../visualizers/palettes';
import type { PaletteId, ResolvedSettings, WaveformStyle } from '../state/settings';

const SAMPLE_RATE = 48000;
const FFT = 2048;
const BINS = 1024;

type Material = 'punchy' | 'compressed' | 'sustained';

/** One gallery cell: a pinned parameter set with its own canvas and state. */
interface Cell {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  state: DrawState;
  /** Applied before every frame. Undefined entries are left to the engine,
   *  which is how the "live" cell shows the real re-roll behaviour. */
  pin?: { symmetry?: number; ratio?: number; lattice?: number; gridKind?: number };
  style: WaveformStyle;
}

const cells: Cell[] = [];

/* ── Controls ─────────────────────────────────────────────────────────── */

const ui = {
  material: 'punchy' as Material,
  palette: 'spotify' as PaletteId,
  // Lower than the app's 0.3 on purpose. At 0.3 a trace is ~680 points and
  // every cell collapses into the same dense ball, which hides the very
  // differences this page exists to show. Raise it to see what the app
  // actually draws.
  density: 0.14,
  glow: 0.55,
  running: true,
};

function settingsFor(style: WaveformStyle): ResolvedSettings {
  return {
    palette: ui.palette,
    customColors: ['#7c3aed', '#ec4899', '#f59e0b'],
    autoTintFromAlbumArt: false,
    showLyrics: false,
    albumArtBackdrop: false,
    immersive: true,
    waveformStyle: style,
    glow: ui.glow,
    sensitivity: 1.1,
    autoGain: true,
    spectralPosition: true,
    trail: 0.42,
    smoothing: 0.88,
    barWidth: 4,
    barGap: 2,
    particleDensity: 0.45,
    particleSize: 0.85,
    scopeDensity: ui.density,
  };
}

/* ── Synthetic audio ──────────────────────────────────────────────────── */

// Emulates the analyser's own smoothingTimeConstant (0.8 in useAudioEngine),
// without which the onset detector sees deltas it would never see in the app.
const smoothed = new Float32Array(BINS);

function synth(frame: number, material: Material) {
  const time = new Uint8Array(FFT);
  const timeL = new Uint8Array(FFT);
  const timeR = new Uint8Array(FFT);
  const freq = new Uint8Array(BINS);

  const env = 0.5 + 0.5 * Math.abs(Math.sin(frame * 0.013));
  const sweep = 0.5 + 0.5 * Math.sin(frame * 0.021);
  let kick = 0;
  if (material === 'punchy') kick = frame % 30 < 4 ? 1 : 0;
  if (material === 'compressed') kick = frame % 30 < 4 ? 0.25 : 0.12;

  for (let i = 0; i < FFT; i++) {
    const t = (i + frame * 512) / SAMPLE_RATE;
    const tone =
      Math.sin(2 * Math.PI * (150 + 400 * sweep) * t) * 0.6 +
      Math.sin(2 * Math.PI * (440 + 200 * sweep) * t) * 0.25 +
      kick * Math.sin(2 * Math.PI * 55 * t) * 0.8;
    const wide = Math.sin(2 * Math.PI * 330 * t + frame * 0.05) * 0.25;
    const l = (tone + wide) * env;
    const r = (tone - wide) * env;
    timeL[i] = clamp8(128 + l * 90);
    timeR[i] = clamp8(128 + r * 90);
    time[i] = clamp8(128 + (l + r) * 45);
  }

  for (let i = 0; i < BINS; i++) {
    const t = i / BINS;
    let raw =
      30 * env * Math.exp(-t * 7) +
      90 * env * Math.exp(-Math.pow((t - sweep * 0.3) / 0.06, 2));
    if (material === 'punchy') raw += 200 * kick * Math.exp(-t * 60);
    if (material === 'compressed') raw += 150 * kick * Math.exp(-t * 60);
    if (material === 'sustained') raw += 110 * env * Math.exp(-t * 60);
    smoothed[i] = smoothed[i] * 0.8 + raw * 0.2;
    freq[i] = clamp8(smoothed[i]);
  }

  return { time, freq, timeL, timeR };
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/* ── Gallery definition ───────────────────────────────────────────────── */

interface Spec {
  title: string;
  note: string;
  pin?: Cell['pin'];
  style?: WaveformStyle;
}

interface Section {
  heading: string;
  blurb: string;
  specs: Spec[];
}

const GRID_NAMES = ['polar', 'square', 'diamond', 'triangle'];

// Ratios are the set the engine actually draws from.
const RATIOS = [0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 5 / 3, 2, 2.5, 3, 4];

const SECTIONS: Section[] = [
  {
    heading: '0 · Grid geometry — what the cells are',
    blurb:
      'The lattice snaps points onto a grid; this is the shape of that grid. ' +
      'Each symmetry copy snaps to the same one, so overlapping rotated ' +
      'copies of a square grid give interlocking quadrilaterals, a triangular ' +
      'grid gives hexagonal rosettes, and so on. Shown at lattice 1, the ' +
      'coarsest setting.',
    // Shown at two symmetries on purpose. Each copy is rotated before it is
    // drawn, so N copies superimpose N differently-oriented grids and the cell
    // shape washes out — the geometry is most legible at low symmetry.
    specs: [0, 1, 2, 3].flatMap((kind) =>
      [2, 5].map((symmetry) => ({
        title: `${GRID_NAMES[kind]} · symmetry ${symmetry}`,
        note:
          symmetry === 2
            ? ['Spokes and rings.', 'Axis-aligned cells.', 'Cells meeting point-to-point.', 'Hexagonal packing.'][kind]
            : 'Same grid, 5 copies — cell shape largely washed out.',
        pin: { gridKind: kind, lattice: 1, symmetry, ratio: 1.5 },
      })),
    ),
  },
  {
    heading: '1 · Lattice — what the centre is made of',
    blurb:
      'The strongest single control. Points are snapped onto a polar grid of ' +
      'N spokes and M rings, so the trace becomes straight chords between ' +
      'grid nodes. Every symmetry copy snaps to the same grid, which is why ' +
      'the overlaps build a visible mesh instead of blurring together.',
    specs: [
      {
        title: 'Lattice 0 — free curve',
        note: 'No grid. The raw stereo trace: flowing loops and ribbons, curved everywhere.',
        pin: { lattice: 0, symmetry: 5, ratio: 1.5, gridKind: 0 },
      },
      {
        title: 'Lattice 1 — coarse grid (12 spokes, 6 rings)',
        note: 'Big straight chords and long spokes. Most open of the three; reads as a star or polygon web.',
        pin: { lattice: 1, symmetry: 5, ratio: 1.5, gridKind: 0 },
      },
      {
        title: 'Lattice 2 — medium grid (18 spokes, 9 rings)',
        note: 'Finer nodes, more crossings. Dense rosette with a clear radial skeleton.',
        pin: { lattice: 2, symmetry: 5, ratio: 1.5, gridKind: 0 },
      },
      {
        title: 'Lattice 3 — fine grid (24 spokes, 12 rings)',
        note: 'Tightest mesh. Structure is there but crowded — this is where it tips into clutter.',
        pin: { lattice: 3, symmetry: 5, ratio: 1.5, gridKind: 0 },
      },
    ],
  },
  {
    heading: '2 · Symmetry — how many arms',
    blurb:
      'The finished trace is stroked N times, each rotated by 360/N, each in ' +
      'its own hue from a 210° arc. Lattice held at 1 so the arm count is the ' +
      'only thing changing.',
    specs: [2, 3, 4, 5, 6, 7, 8].map((n) => ({
      title: `Symmetry ${n}`,
      note: `${n} rotated copies, ${n} hues.`,
      pin: { symmetry: n, lattice: 1, ratio: 1.5, gridKind: 0 },
    })),
  },
  {
    heading: '3 · Ratio — the shape of the underlying figure',
    blurb:
      'Warps the vertical axis against the horizontal before any snapping. ' +
      'Small rational values close the trace into knots and rosettes; the ' +
      'engine only ever picks from this exact set. Lattice off so you can see ' +
      'the raw figure.',
    specs: RATIOS.map((r) => ({
      title: `Ratio ${r === 2 / 3 ? '2/3' : r === 5 / 3 ? '5/3' : r}`,
      note: '',
      pin: { ratio: r, lattice: 0, symmetry: 4, gridKind: 0 },
    })),
  },
  {
    heading: '4 · Ratio, with the grid on',
    blurb:
      'The same ratios at lattice 1. Snapping collapses nearby traces onto ' +
      'shared nodes, so several ratios that look distinct above converge here ' +
      '— worth knowing when a change seems to do nothing.',
    specs: RATIOS.map((r) => ({
      title: `Ratio ${r === 2 / 3 ? '2/3' : r === 5 / 3 ? '5/3' : r} · lattice 1`,
      note: '',
      pin: { ratio: r, lattice: 1, symmetry: 4, gridKind: 0 },
    })),
  },
  {
    heading: '5 · Live — the real selection logic',
    blurb:
      'Nothing pinned. This is exactly what the app does: parameters re-roll ' +
      'on bass onsets above an adaptive threshold, with a forced roll if ' +
      'nothing has changed in 5 seconds. The lattice roll is weighted 70/12/' +
      '8/10 toward 1/2/3/0. Watch the readout to see which variable moved.',
    specs: [{ title: 'Scope — unpinned', note: 'Live re-rolling.' }],
  },
  {
    heading: '6 · Bloom — the other radial style',
    blurb:
      'For comparison. A superformula outline rippled by the waveform in ' +
      'mid/side, morphing between curated curved presets.',
    specs: [{ title: 'Bloom', note: 'Curved counterpart to Scope.', style: 'crystal' }],
  },
];

/* ── Build the page ───────────────────────────────────────────────────── */

const root = document.getElementById('lab')!;

function buildControls() {
  const bar = document.createElement('div');
  bar.className = 'controls';

  bar.appendChild(
    select('Material', ['punchy', 'compressed', 'sustained'], ui.material, (v) => {
      ui.material = v as Material;
      smoothed.fill(0);
    }),
  );
  bar.appendChild(
    select(
      'Palette',
      Object.keys(PALETTES).filter((p) => p !== 'custom'),
      ui.palette,
      (v) => {
        ui.palette = v as PaletteId;
      },
    ),
  );
  bar.appendChild(range('Density', 0.05, 1, 0.01, ui.density, (v) => (ui.density = v)));
  bar.appendChild(range('Glow', 0, 1, 0.01, ui.glow, (v) => (ui.glow = v)));

  const pause = document.createElement('button');
  pause.textContent = 'Pause';
  pause.onclick = () => {
    ui.running = !ui.running;
    pause.textContent = ui.running ? 'Pause' : 'Play';
  };
  bar.appendChild(pause);

  const reset = document.createElement('button');
  reset.textContent = 'Reset states';
  reset.onclick = () => {
    for (const c of cells) c.state = createDrawState();
    for (const c of cells) c.ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
  };
  bar.appendChild(reset);

  root.appendChild(bar);
}

function select(
  label: string,
  options: string[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.innerHTML = `<span>${label}</span>`;
  const el = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    if (o === value) opt.selected = true;
    el.appendChild(opt);
  }
  el.onchange = () => onChange(el.value);
  wrap.appendChild(el);
  return wrap;
}

function range(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  const out = document.createElement('b');
  out.textContent = value.toFixed(2);
  wrap.innerHTML = `<span>${label}</span>`;
  const el = document.createElement('input');
  el.type = 'range';
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  el.value = String(value);
  el.oninput = () => {
    onChange(Number(el.value));
    out.textContent = Number(el.value).toFixed(2);
  };
  wrap.appendChild(el);
  wrap.appendChild(out);
  return wrap;
}

function buildGallery() {
  for (const section of SECTIONS) {
    const h = document.createElement('h2');
    h.textContent = section.heading;
    root.appendChild(h);

    const p = document.createElement('p');
    p.className = 'blurb';
    p.textContent = section.blurb;
    root.appendChild(p);

    const grid = document.createElement('div');
    grid.className = 'grid';
    root.appendChild(grid);

    for (const spec of section.specs) {
      const card = document.createElement('figure');
      const size = section.specs.length <= 2 ? 460 : 250;

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      card.appendChild(canvas);

      const cap = document.createElement('figcaption');
      cap.innerHTML = `<strong>${spec.title}</strong>`;
      if (spec.note) cap.innerHTML += `<em>${spec.note}</em>`;
      const readout = document.createElement('code');
      cap.appendChild(readout);
      card.appendChild(cap);

      grid.appendChild(card);

      const cell: Cell = {
        canvas,
        ctx: canvas.getContext('2d')!,
        state: createDrawState(),
        pin: spec.pin,
        style: spec.style ?? 'lissajous',
      };
      cells.push(cell);
      readouts.set(cell, readout);
    }
  }
}

const readouts = new Map<Cell, HTMLElement>();

/* ── Loop ─────────────────────────────────────────────────────────────── */

let frame = 0;

function tick() {
  requestAnimationFrame(tick);
  if (!ui.running) return;

  const audio = synth(frame, ui.material);
  frame++;

  for (const cell of cells) {
    if (cell.pin) {
      // Re-applied every frame: drawFrame re-rolls these itself, and pinning
      // is the entire point of the gallery.
      if (cell.pin.symmetry !== undefined) cell.state.scopeSymmetry = cell.pin.symmetry;
      if (cell.pin.ratio !== undefined) cell.state.scopeRatio = cell.pin.ratio;
      if (cell.pin.lattice !== undefined) cell.state.scopeLattice = cell.pin.lattice;
      if (cell.pin.gridKind !== undefined) cell.state.scopeGridKind = cell.pin.gridKind;
    }

    drawFrame(
      cell.ctx,
      cell.canvas.width,
      cell.canvas.height,
      audio.time,
      audio.freq,
      SAMPLE_RATE,
      settingsFor(cell.style),
      cell.state,
      null,
      audio.timeL,
      audio.timeR,
    );

    if (frame % 15 === 0) {
      const r = readouts.get(cell);
      if (r) {
        r.textContent =
          cell.style === 'crystal'
            ? `m=${cell.state.crystalM} layers=${cell.state.crystalLayers}`
            : `sym ${cell.state.scopeSymmetry} · ratio ${cell.state.scopeRatio.toFixed(2)}` +
            ` · lattice ${cell.state.scopeLattice} · ${GRID_NAMES[cell.state.scopeGridKind]}`;
      }
    }
  }
}

buildControls();
buildGallery();
tick();
