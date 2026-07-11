import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { DefaultReset, color, config } from 'folds';

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
