import { memo, useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Value to snap to on double-click; usually the neutral position. */
  defaultValue?: number;
  size?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** When true, render the arc as a bi-directional indicator centered at 0. */
  bipolar?: boolean;
}

const ARC_START_DEG = -135;
const ARC_END_DEG = 135;
const ARC_SPAN = ARC_END_DEG - ARC_START_DEG;

export const Knob = memo(KnobImpl);

function KnobImpl({
  label,
  value,
  min,
  max,
  defaultValue,
  size = 58,
  format,
  onChange,
  bipolar = false,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef(0);
  const startValueRef = useRef(value);
  const shiftRef = useRef(false);

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      startYRef.current = e.clientY;
      startValueRef.current = value;
      shiftRef.current = e.shiftKey;
      setDragging(true);
    },
    [value],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const deltaY = startYRef.current - e.clientY;
      const speed = e.shiftKey || shiftRef.current ? 600 : 180;
      const delta = (deltaY / speed) * (max - min);
      onChange(clamp(startValueRef.current + delta));
    },
    [dragging, max, min, onChange, clamp],
  );

  const stopDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  }, [dragging]);

  const onDoubleClick = useCallback(() => {
    if (defaultValue !== undefined) onChange(clamp(defaultValue));
  }, [defaultValue, onChange, clamp]);

  // Map current value to rotation angle (-135 → +135)
  const t = (value - min) / (max - min);
  const indicatorAngle = ARC_START_DEG + t * ARC_SPAN;

  // Background arc (full range)
  const r = 22;
  const bgArc = describeArc(r, ARC_START_DEG, ARC_END_DEG);

  // Active arc: from start (or center, if bipolar) to current angle
  let activeFrom: number;
  if (bipolar) {
    // For ±range knobs, draw outward from center
    activeFrom = (ARC_START_DEG + ARC_END_DEG) / 2;
  } else {
    activeFrom = ARC_START_DEG;
  }
  const activeArc = describeArc(
    r,
    Math.min(activeFrom, indicatorAngle),
    Math.max(activeFrom, indicatorAngle),
  );

  const displayValue = format ? format(value) : value.toFixed(1);

  return (
    <div className="knob-wrap">
      <span className="knob-label">{label}</span>
      <div
        className={`knob ${dragging ? 'is-dragging' : ''}`}
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onDoubleClick={onDoubleClick}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
      >
        <svg viewBox="-30 -30 60 60" width={size} height={size}>
          <defs>
            <radialGradient id="knobBody" cx="0.35" cy="0.3" r="0.85">
              <stop offset="0%" stopColor="#3a3a3f" />
              <stop offset="55%" stopColor="#1f1f23" />
              <stop offset="100%" stopColor="#0c0c0e" />
            </radialGradient>
          </defs>

          {/* Background ring — full sweep, dim */}
          <path
            d={bgArc}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={3}
            strokeLinecap="round"
          />

          {/* Active arc — themed by --accent */}
          <path
            d={activeArc}
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 0 4px currentColor)' }}
          />

          {/* Knob body */}
          <circle cx={0} cy={0} r={17} fill="url(#knobBody)" stroke="rgba(255,255,255,0.05)" />

          {/* Indicator (small dot on the rim, themed) */}
          <g transform={`rotate(${indicatorAngle})`}>
            <circle cx={0} cy={-13} r={2.5} fill="currentColor" />
          </g>
        </svg>
      </div>
      <span className="knob-value">{displayValue}</span>
    </div>
  );
}

function describeArc(r: number, startDeg: number, endDeg: number): string {
  // Convert "knob degrees" (0 = top) into SVG degrees (0 = right) by adding -90.
  const start = polar(r, startDeg - 90);
  const end = polar(r, endDeg - 90);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  // Sweep 1 = clockwise in SVG (Y down)
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
}

function polar(r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
}
