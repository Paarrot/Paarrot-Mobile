import { style } from '@vanilla-extract/css';
import { color, config, toRem } from 'folds';

export const SwipeBackRoot = style({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
});

export const SwipeBackContent = style({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: color.Background.Container,
  boxShadow: '-4px 0 16px rgba(0, 0, 0, 0.28)',
  willChange: 'transform',
  touchAction: 'pan-y',
});

export const CompactDetailRoot = style({
  position: 'relative',
  minWidth: 0,
  overflow: 'hidden',
});

export const CompactNavUnderlay = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  zIndex: 0,
  pointerEvents: 'none',
});

export const CompactDetailLayer = style({
  position: 'relative',
  zIndex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
});

export const SwipeToReplyLayer = style({
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
});

export const SwipeToReplyIndicator = style({
  position: 'absolute',
  right: config.space.S300,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: toRem(36),
  height: toRem(36),
  borderRadius: config.radii.Pill,
  backgroundColor: color.Primary.Container,
  color: color.Primary.OnContainer,
  pointerEvents: 'none',
  zIndex: 2,
  opacity: 0,
  transform: 'scale(0.85)',
  transition: 'opacity 0.12s ease, transform 0.12s ease',
});

export const SwipeToReplyIndicatorActive = style({
  opacity: 1,
  transform: 'scale(1)',
});
