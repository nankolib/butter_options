// =============================================================================
// TourOverlay — the shaded tutorial. Spotlight cutout over the real UI.
// =============================================================================
//
// Dim-with-cutout: one fixed backdrop with a transparent hole punched over the
// live element, so the thing being described is the actual control, not a
// screenshot of it. The hole is an `box-shadow: 0 0 0 9999px` ring on a
// positioned div — that renders a single compositor layer and does not fight
// the terminal's own stacking, which an SVG mask or four edge divs both did.
//
// Anchors are resolved from `data-tour="<id>"` on real DOM nodes. A missing
// anchor is NOT a crash and NOT a silent skip: the step degrades to a centred
// card, so a renamed element costs a spotlight, never the tutorial.
//
// All state derivation lives in tourSteps.ts (pure, unit-tested). This file is
// deliberately thin: geometry, portal, and the post-action refresh.
//
// ADVANCEMENT: the wallet endpoint is re-polled after the user acts, and the
// step recomputes from the returned quest set. There is NO busy loop — polling
// runs only while the tour is open AND a step is quest-gated, backs off, and
// stops the moment the step is satisfied.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";

import { EPOCH0_UI, fetchWallet } from "../../utils/epoch0";
import {
  TOUR_STEPS,
  resolveStep,
  shouldAutoOpen,
  advanceFrom,
  progressOf,
  type TourStep,
  type TourStepId,
} from "./tourSteps";

const DISMISS_KEY = "opta.tour.dismissed";
const POLL_MS = 6000;
const POLL_MAX = 40; // ~4 min of watching after an action, then stop.

/** Explicit dismiss is permanent — read/written only here. */
export const tourDismissed = (): boolean => {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
};
export const setTourDismissed = (v: boolean): void => {
  try { v ? localStorage.setItem(DISMISS_KEY, "1") : localStorage.removeItem(DISMISS_KEY); } catch { /* ignore */ }
};

/** Fired by the quest panel's "resume walkthrough" control. */
export const TOUR_RESUME_EVENT = "opta:tour:resume";
export const resumeTour = (): void => {
  setTourDismissed(false);
  window.dispatchEvent(new CustomEvent(TOUR_RESUME_EVENT));
};

type Rect = { top: number; left: number; width: number; height: number };

function rectOf(anchor: string | null): Rect | null {
  if (!anchor) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null; // present but not laid out
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export const TourOverlay: FC = () => {
  const { publicKey, connected } = useWallet();
  const location = useLocation();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(tourDismissed);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [manual, setManual] = useState<TourStepId | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const autoOpened = useRef(false);
  const pollsLeft = useRef(0);

  const wallet = publicKey?.toBase58() ?? null;

  const refresh = useCallback(async () => {
    if (!wallet) { setCompleted(new Set()); setLoaded(false); return; }
    const res = await fetchWallet(wallet);
    if (res.ok) {
      setCompleted(new Set((res.data.quests ?? []).map((q) => q.quest_id)));
      setLoaded(true);
    } else {
      // Unreachable API: mark loaded so the tour degrades to "show nothing"
      // rather than hanging on a spinner over the whole app.
      setLoaded(true);
    }
  }, [wallet]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Resume from the quest panel.
  useEffect(() => {
    const onResume = () => { setDismissed(false); setManual(null); setOpen(true); void refresh(); };
    window.addEventListener(TOUR_RESUME_EVENT, onResume);
    return () => window.removeEventListener(TOUR_RESUME_EVENT, onResume);
  }, [refresh]);

  const state = useMemo(
    () => ({ connected, completed, dismissed, loaded }),
    [connected, completed, dismissed, loaded],
  );

  // Auto-open once, only for a clean sheet.
  useEffect(() => {
    if (autoOpened.current) return;
    if (shouldAutoOpen(state)) { autoOpened.current = true; setOpen(true); }
  }, [state]);

  const step: TourStep | null = useMemo(() => {
    if (!open) return null;
    if (manual) {
      const s = TOUR_STEPS.find((x) => x.id === manual);
      if (s) return s;
    }
    return resolveStep(state);
  }, [open, manual, state]);

  // Post-action polling: only while a quest-gated step is showing.
  useEffect(() => {
    if (!open || !step?.completedBy || completed.has(step.completedBy)) { pollsLeft.current = 0; return; }
    pollsLeft.current = POLL_MAX;
    const t = setInterval(() => {
      if (pollsLeft.current-- <= 0) { clearInterval(t); return; }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [open, step?.id, step?.completedBy, completed, refresh]);

  // A quest completing clears any manual override so the tour re-derives.
  useEffect(() => {
    if (manual) {
      const s = TOUR_STEPS.find((x) => x.id === manual);
      if (s?.completedBy && completed.has(s.completedBy)) setManual(null);
    }
  }, [completed, manual]);

  // Track the anchor's geometry. rAF-throttled against scroll/resize, and
  // re-measured when the step or route changes.
  useEffect(() => {
    if (!open || !step) { setRect(null); return; }
    let raf = 0;
    const measure = () => { raf = 0; setRect(rectOf(step.anchor)); };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    // Anchors can mount after us (async data); retry briefly before giving up
    // and falling back to the centred card.
    const retries = [120, 350, 800, 1500].map((ms) => setTimeout(measure, ms));
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      retries.forEach(clearTimeout);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [open, step?.id, step?.anchor, location.pathname]);

  if (!EPOCH0_UI || !open || !step) return null;

  const onDismiss = () => { setTourDismissed(true); setDismissed(true); setOpen(false); };
  const onNext = () => {
    const next = advanceFrom(step.id, state);
    if (!next) { setOpen(false); return; }
    setManual(next.id);
    if (next.route && next.route !== location.pathname) navigate(next.route);
  };
  const onGo = () => { if (step.route) navigate(step.route); };

  const { index, total } = progressOf(step);
  const onRoute = !step.route || step.route === location.pathname;
  const spotlight = onRoute ? rect : null;

  return createPortal(
    <div
      data-testid="tour-overlay"
      data-tour-step={step.id}
      data-tour-anchored={spotlight ? "1" : "0"}
      className="fixed inset-0 z-[400]"
      role="dialog"
      aria-modal="false"
      aria-label={`walkthrough: ${step.title}`}
    >
      {/* Backdrop. With an anchor we punch a hole with a huge spread shadow so
          the real control stays lit and clickable; without one we dim flat. */}
      {spotlight ? (
        <div
          data-testid="tour-spotlight"
          className="pointer-events-none absolute rounded-[10px] transition-all duration-200"
          style={{
            top: spotlight.top - 6,
            left: spotlight.left - 6,
            width: spotlight.width + 12,
            height: spotlight.height + 12,
            boxShadow: "0 0 0 9999px rgba(8,8,6,0.72)",
            outline: "1px solid rgba(255,255,255,0.35)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(8,8,6,0.72)]" />
      )}

      <TourCard
        step={step}
        index={index}
        total={total}
        rect={spotlight}
        onRoute={onRoute}
        onNext={onNext}
        onGo={onGo}
        onDismiss={onDismiss}
      />
    </div>,
    document.body,
  );
};

const TourCard: FC<{
  step: TourStep;
  index: number;
  total: number;
  rect: Rect | null;
  onRoute: boolean;
  onNext: () => void;
  onGo: () => void;
  onDismiss: () => void;
}> = ({ step, index, total, rect, onRoute, onNext, onGo, onDismiss }) => {
  // Place under the anchor when there is room, otherwise above it; centre the
  // card when there is no anchor. Clamped so it can never leave the viewport at
  // 390px, which is where a naive "anchor.left" placement breaks.
  const W = 320;
  let style: React.CSSProperties = {
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: `min(${W}px, calc(100vw - 32px))`,
  };
  if (rect) {
    const below = rect.top + rect.height + 14;
    const fitsBelow = below + 190 < window.innerHeight;
    const top = fitsBelow ? below : Math.max(12, rect.top - 200);
    const left = Math.min(
      Math.max(12, rect.left + rect.width / 2 - W / 2),
      Math.max(12, window.innerWidth - W - 12),
    );
    style = { top, left, width: `min(${W}px, calc(100vw - 24px))` };
  }

  return (
    <div
      data-testid="tour-card"
      className="pointer-events-auto absolute rounded-[10px] border border-l-hair bg-l-bg p-4 text-l-text shadow-2xl"
      style={style}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono-plex text-[9px] uppercase tracking-[0.18em] text-l-faint">
          {index} / {total}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          data-testid="tour-dismiss"
          className="font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-muted transition-colors hover:text-l-text"
        >
          dismiss
        </button>
      </div>
      <p className="m-0 mb-2 font-mono-plex text-[13px] lowercase tracking-[0.02em] text-l-text">{step.title}</p>
      <p className="m-0 mb-4 font-sans text-[12.5px] leading-[1.55] text-l-muted">{step.body}</p>
      <div className="flex items-center gap-2">
        {!onRoute && step.route && (
          <button
            type="button"
            onClick={onGo}
            data-testid="tour-go"
            className="rounded-[6px] bg-l-up px-[11px] py-[6px] font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-on-up"
          >
            take me there
          </button>
        )}
        <button
          type="button"
          onClick={onNext}
          data-testid="tour-next"
          className="rounded-[6px] border border-l-muted px-[11px] py-[6px] font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-text transition-colors hover:border-l-text"
        >
          {step.id === "handoff" ? "done" : "next"}
        </button>
        {step.completedBy && (
          <span className="ml-auto font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-faint">
            advances on completion
          </span>
        )}
      </div>
    </div>
  );
};

export default TourOverlay;
