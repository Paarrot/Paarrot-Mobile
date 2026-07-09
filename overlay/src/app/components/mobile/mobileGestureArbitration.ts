export type MobileGestureKind = 'back' | 'reply';

type ActiveGesture = {
  kind: MobileGestureKind;
  pointerId: number;
};

let activeGesture: ActiveGesture | null = null;

export const claimMobileGesture = (kind: MobileGestureKind, pointerId: number): boolean => {
  if (!activeGesture || activeGesture.pointerId === pointerId) {
    activeGesture = { kind, pointerId };
    return true;
  }
  return activeGesture.kind === kind && activeGesture.pointerId === pointerId;
};

export const getActiveMobileGesture = (pointerId: number): MobileGestureKind | null => {
  if (!activeGesture || activeGesture.pointerId !== pointerId) return null;
  return activeGesture.kind;
};

export const clearMobileGesture = (pointerId: number) => {
  if (activeGesture?.pointerId === pointerId) {
    activeGesture = null;
  }
};
