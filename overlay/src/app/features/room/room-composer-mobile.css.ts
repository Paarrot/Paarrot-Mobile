import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { DefaultReset, color, config } from 'folds';

export const ComposerDock = style({
  position: 'relative',
});

/** Read receipts float above the input so they don't reserve layout height. */
export const FollowingFloat = style({
  position: 'absolute',
  bottom: '100%',
  left: 0,
  right: 0,
  zIndex: 2,
  display: 'flex',
  justifyContent: 'flex-end',
  pointerEvents: 'none',
  padding: `0 ${config.space.S200}`,
});

export const FollowingFloatHit = style({
  pointerEvents: 'auto',
  maxWidth: '100%',
});

export const RoomViewFollowingPlaceholder = style([
  DefaultReset,
  {
    display: 'none',
    height: 0,
  },
]);

export const RoomViewFollowing = recipe({
  base: [
    DefaultReset,
    {
      minHeight: 0,
      padding: `${config.space.S100} ${config.space.S200}`,
      width: 'auto',
      maxWidth: '100%',
      backgroundColor: 'transparent',
      color: color.Surface.OnContainer,
      outline: 'none',
    },
  ],
  variants: {
    clickable: {
      true: {
        cursor: 'pointer',
        selectors: {
          '&:hover, &:focus-visible': {
            color: color.Primary.Main,
          },
          '&:active': {
            color: color.Primary.Main,
          },
        },
      },
    },
  },
});
