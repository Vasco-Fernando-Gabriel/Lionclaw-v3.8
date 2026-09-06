import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export type VoiceOrbVisualState = 'idle' | 'listening' | 'processing' | 'responding';

export interface VoiceOrbHandle {
  setAmplitude: (value: number) => void;
}

interface VoiceOrbProps {
  state: VoiceOrbVisualState;
  amplitude: number;
  size?: number;
  onClick?: () => void;
  disabled?: boolean;
}

const VOICE_ORB_COLORS: Record<VoiceOrbVisualState, { h: number; s: number; l: number }> = {
  idle: { h: 32, s: 100, l: 58 },
  listening: { h: 38, s: 100, l: 62 },
  processing: { h: 26, s: 100, l: 56 },
  responding: { h: 45, s: 100, l: 60 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const VoiceOrb = forwardRef<VoiceOrbHandle, VoiceOrbProps>(function VoiceOrb(
  { state, amplitude, size = 168, onClick, disabled },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const amplitudeRef = useRef(0);
  const targetAmplitudeRef = useRef(0);

  useImperativeHandle(ref, () => ({
    setAmplitude: (value: number) => {
      targetAmplitudeRef.current = clamp(value, 0, 1);
    },
  }), []);

  useEffect(() => {
    targetAmplitudeRef.current = clamp(amplitude, 0, 1);
  }, [amplitude]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const render = (timestamp: number) => {
      const dpr = window.devicePixelRatio || 1;
      const displaySize = Math.max(96, size);

      if (canvas.width !== Math.floor(displaySize * dpr) || canvas.height !== Math.floor(displaySize * dpr)) {
        canvas.width = Math.floor(displaySize * dpr);
        canvas.height = Math.floor(displaySize * dpr);
        canvas.style.width = `${displaySize}px`;
        canvas.style.height = `${displaySize}px`;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, displaySize, displaySize);

      amplitudeRef.current += (targetAmplitudeRef.current - amplitudeRef.current) * 0.16;
      const amp = amplitudeRef.current;
      const t = timestamp / 1000;
      const cx = displaySize / 2;
      const cy = displaySize / 2;
      const baseRadius = displaySize * 0.23;
      const color = VOICE_ORB_COLORS[state];
      const hue = color.h;
      const pulse = Math.sin(t * 2.2) * 0.5 + 0.5;
      const activePulse = state === 'idle' ? pulse * 0.12 : pulse * 0.24;
      const radius = baseRadius + activePulse * 8 + amp * 18;

      const outerGlow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, displaySize * 0.45);
      outerGlow.addColorStop(0, `hsla(${hue}, ${color.s}%, ${color.l}%, ${0.34 + amp * 0.18})`);
      outerGlow.addColorStop(0.45, `hsla(${hue}, ${color.s}%, ${color.l}%, ${0.12 + amp * 0.1})`);
      outerGlow.addColorStop(1, `hsla(${hue}, ${color.s}%, ${color.l}%, 0)`);
      ctx.fillStyle = outerGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, displaySize * 0.46, 0, Math.PI * 2);
      ctx.fill();

      if (state === 'responding') {
        for (let i = 0; i < 3; i += 1) {
          const phase = (t * 0.75 + i / 3) % 1;
          ctx.strokeStyle = `hsla(${hue}, ${color.s}%, ${color.l}%, ${0.28 * (1 - phase)})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(cx, cy, radius + phase * displaySize * 0.25, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      if (state === 'listening') {
        const bars = 40;
        for (let i = 0; i < bars; i += 1) {
          const angle = (Math.PI * 2 * i) / bars;
          const wave = Math.sin(t * 5 + i * 0.72) * 0.5 + 0.5;
          const bar = 6 + wave * 7 + amp * 22;
          const inner = radius + 12;
          const outer = inner + bar;
          ctx.strokeStyle = `hsla(${hue}, ${color.s}%, ${color.l}%, ${0.28 + amp * 0.44})`;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
          ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
          ctx.stroke();
        }
      }

      if (state === 'processing') {
        for (let i = 0; i < 3; i += 1) {
          const rotation = t * (0.9 + i * 0.18) + i * 2.1;
          const arcRadius = radius + 16 + i * 9;
          ctx.strokeStyle = `hsla(${hue + i * 4}, ${color.s}%, ${color.l + 3}%, ${0.6 - i * 0.12})`;
          ctx.lineWidth = 2.4 - i * 0.3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(cx, cy, arcRadius, rotation, rotation + Math.PI * (0.65 + i * 0.08));
          ctx.stroke();
        }
      }

      const core = ctx.createRadialGradient(cx - radius * 0.25, cy - radius * 0.35, radius * 0.1, cx, cy, radius);
      core.addColorStop(0, `hsl(${hue + 8}, ${color.s}%, 78%)`);
      core.addColorStop(0.42, `hsl(${hue}, ${color.s}%, ${color.l}%)`);
      core.addColorStop(1, `hsl(${Math.max(18, hue - 8)}, ${color.s}%, 38%)`);
      ctx.fillStyle = core;
      ctx.shadowColor = `hsla(${hue}, ${color.s}%, ${color.l}%, 0.72)`;
      ctx.shadowBlur = 26 + amp * 34;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = `hsla(${hue + 6}, ${color.s}%, 82%, ${0.56 + amp * 0.24})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 0.5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = `hsla(${hue + 12}, ${color.s}%, 92%, ${0.36 + pulse * 0.2})`;
      ctx.beginPath();
      ctx.arc(cx - radius * 0.28, cy - radius * 0.34, radius * 0.18, 0, Math.PI * 2);
      ctx.fill();

      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);

    return () => {
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [size, state]);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      className="relative grid place-items-center rounded-full outline-none transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-amber-400/70 disabled:cursor-default disabled:hover:scale-100"
      title={state === 'responding' ? 'Interromper fala' : 'Orb de conversa por voz'}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="sr-only">{state === 'responding' ? 'Interromper fala' : 'Orb de conversa por voz'}</span>
    </button>
  );
});
