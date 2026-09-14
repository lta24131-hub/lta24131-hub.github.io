import { RefObject, useCallback, useEffect, useRef, useState } from "react";

export function useModelFullscreen(stage: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  const active = useRef(false);
  const nativeEntered = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const leave = useCallback(() => {
    active.current = false;
    setFullscreen(false);
    if (document.fullscreenElement === stage.current) void document.exitFullscreen().catch(() => {});
    requestAnimationFrame(() => previousFocus.current?.focus());
  }, [stage]);
  const enter = useCallback(() => {
    const element = stage.current;
    if (!element) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    active.current = true;
    setFullscreen(true);
    // iPhone Safari may not support element fullscreen. The same model-only
    // viewport layout works there and in a home-screen installed application.
    if (element.requestFullscreen) {
      void element.requestFullscreen().then(() => {
        if (!active.current && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
      }).catch(() => {});
    }
  }, [stage]);
  useEffect(() => {
    const changed = () => {
      if (document.fullscreenElement === stage.current) nativeEntered.current = true;
      else if (nativeEntered.current) { nativeEntered.current = false; leave(); }
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && active.current) leave(); };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      document.removeEventListener("keydown", keydown);
      if (document.fullscreenElement === stage.current) void document.exitFullscreen().catch(() => {});
    };
  }, [leave, stage]);
  return { fullscreen, enter, leave };
}
