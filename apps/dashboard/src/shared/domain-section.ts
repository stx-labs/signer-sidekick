import { useEffect } from "react";
import type { DomainSection } from "../dashboard-route.js";

export function useDomainSection(page: string, section: DomainSection | null): void {
  useEffect(() => {
    if (!section) return;
    let frame = 0;
    let attempts = 0;
    const scrollWhenReady = () => {
      const target = document.getElementById(`${page}-${section}`);
      if (target) {
        if (target instanceof HTMLDetailsElement) target.open = true;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      attempts += 1;
      if (attempts < 120) frame = window.requestAnimationFrame(scrollWhenReady);
    };
    frame = window.requestAnimationFrame(scrollWhenReady);
    return () => window.cancelAnimationFrame(frame);
  }, [page, section]);
}
