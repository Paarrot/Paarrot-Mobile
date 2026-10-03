import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { DefaultReset, color, config, toRem } from 'folds';

/** Floats typing + read receipts over the bottom of the timeline. */
export const RoomViewBottomFloat = style({
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 1,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: config.space.S200,
  pointerEvents: 'none',
});

export const RoomViewFollowingPlaceholder = style([
  DefaultReset,
  {
    height: toRem(28),
  },
]);

export const RoomViewFollowing = recipe({
  base: [
    DefaultReset,
    {
      minHeight: toRem(28),
      padding: `0 ${config.space.S400}`,
      marginLeft: 'auto',
      maxWidth: '50%',
      backgroundColor: 'transparent',
      color: color.Surface.OnContainer,
      outline: 'none',
      pointerEvents: 'auto',
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
