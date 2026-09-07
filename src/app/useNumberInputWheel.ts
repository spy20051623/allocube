import { useEffect } from "react";

export function useNumberInputWheel() {
  useEffect(() => {
    const ignoreNumberInputWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "number") {
        return;
      }
      event.preventDefault();
      scrollPastNumberInput(target, event);
    };

    document.addEventListener("wheel", ignoreNumberInputWheel, {
      capture: true,
      passive: false
    });
    return () => {
      document.removeEventListener("wheel", ignoreNumberInputWheel, true);
    };
  }, []);
}

function scrollPastNumberInput(input: HTMLInputElement, event: WheelEvent) {
  const scale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? window.innerHeight
        : 1;
  const deltaX = event.deltaX * scale;
  const deltaY = event.deltaY * scale;

  for (let element = input.parentElement; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    const canScrollY =
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      element.scrollHeight > element.clientHeight &&
      (deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop + element.clientHeight < element.scrollHeight);
    const canScrollX =
      /(auto|scroll|overlay)/.test(style.overflowX) &&
      element.scrollWidth > element.clientWidth &&
      (deltaX < 0
        ? element.scrollLeft > 0
        : element.scrollLeft + element.clientWidth < element.scrollWidth);

    if (canScrollY || canScrollX) {
      element.scrollBy({
        left: canScrollX ? deltaX : 0,
        top: canScrollY ? deltaY : 0
      });
      return;
    }
  }

  window.scrollBy({ left: deltaX, top: deltaY });
}
