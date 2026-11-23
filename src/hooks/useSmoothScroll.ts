import { useEffect, type RefObject } from "react";

/**
 * Smooth exponential-damping wheel scrolling for inspector sidebars and lists.
 */
export function useSmoothScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let target = el.scrollTop;
    let current = el.scrollTop;
    let rafId: number | null = null;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      target = Math.max(0, Math.min(maxScroll, target));

      const alpha = 1 - Math.exp(-14 * dt);
      current += (target - current) * alpha;
      el.scrollTop = current;

      if (Math.abs(target - current) > 0.35) {
        rafId = requestAnimationFrame(tick);
      } else {
        el.scrollTop = target;
        current = target;
        rafId = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScroll <= 0) return;

      e.preventDefault();
      if (rafId === null) {
        current = el.scrollTop;
        target = el.scrollTop;
        lastTime = performance.now();
      }

      const delta =
        e.deltaMode === 1
          ? e.deltaY * 32
          : e.deltaMode === 2
            ? e.deltaY * el.clientHeight
            : e.deltaY;

      target = Math.max(0, Math.min(maxScroll, target + delta));
      if (rafId === null) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onScroll = () => {
      // Sync external scrollbar drags when animation isn't driving scrollTop
      if (rafId === null) {
        target = el.scrollTop;
        current = el.scrollTop;
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [ref]);
}
