import { ReactNode } from 'react';

type MobileFriendlyClientNavProps = {
  children: ReactNode;
};

/** Server sidebar stays mounted on compact detail routes for swipe-back reveal. */
export function MobileFriendlyClientNav({ children }: MobileFriendlyClientNavProps) {
  return children;
}

type MobileFriendlyPageNavProps = {
  path: string;
  children: ReactNode;
};

/** Channel list stays mounted on compact detail routes for swipe-back reveal. */
export function MobileFriendlyPageNav({ path: _path, children }: MobileFriendlyPageNavProps) {
  return children;
}
