import { useEffect } from 'react';

type PointerLikeEvent = {
  pointerId: number;
  clientX: number;
  clientY: number;
  preventDefault?: () => void;
};

type UseWindowPointerDragOptions = {
  enabled: boolean;
  isActivePointer: (pointerId: number) => boolean;
  onMove: (evt: PointerLikeEvent) => void;
  onEnd: (pointerId: number) => void;
};

export const useWindowPointerDrag = ({
  enabled,
  isActivePointer,
  onMove,
  onEnd,
}: UseWindowPointerDragOptions) => {
  useEffect(() => {
    if (!enabled) return;

    const handlePointerMove = (evt: PointerEvent) => {
      if (!isActivePointer(evt.pointerId)) return;
      onMove(evt);
    };

    const handlePointerEnd = (evt: PointerEvent) => {
      if (!isActivePointer(evt.pointerId)) return;
      onEnd(evt.pointerId);
    };

    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerEnd, true);
    window.addEventListener('pointercancel', handlePointerEnd, true);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerEnd, true);
      window.removeEventListener('pointercancel', handlePointerEnd, true);
    };
  }, [enabled, isActivePointer, onEnd, onMove]);
};
