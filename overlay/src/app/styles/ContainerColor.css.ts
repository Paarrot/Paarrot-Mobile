import { ComplexStyleRule } from '@vanilla-extract/css';
import { RecipeVariants, recipe } from '@vanilla-extract/recipes';
import { ContainerColor as TContainerColor, DefaultReset, color, config } from 'folds';

const getVariant = (variant: TContainerColor): ComplexStyleRule => ({
  vars: {
    backgroundColor: color[variant].Container,
    borderColor: color[variant].ContainerLine,
    outlineColor: color[variant].ContainerLine,
  },
  selectors: {
    // DefaultReset sets `color: inherit` with the same specificity as this rule,
    // so which one wins depends on stylesheet order. In the Android build the
    // ContainerColor chunk is emitted before folds' reset, so the theme color
    // loses and text falls back to the initial color. Raise specificity so the
    // theme color wins regardless of order.
    '&[class]': {
      color: color[variant].OnContainer,
    },
    'button&[aria-pressed=true]': {
      backgroundColor: color[variant].ContainerActive,
    },
    'button&:hover, &:focus-visible': {
      backgroundColor: color[variant].ContainerHover,
    },
    'button&:active': {
      backgroundColor: color[variant].ContainerActive,
    },
    'button&[disabled]': {
      opacity: config.opacity.Disabled,
    },
  },
});

export const ContainerColor = recipe({
  base: [DefaultReset],
  variants: {
    variant: {
      Background: getVariant('Background'),
      Surface: getVariant('Surface'),
      SurfaceVariant: getVariant('SurfaceVariant'),
      Primary: getVariant('Primary'),
      Secondary: getVariant('Secondary'),
      Success: getVariant('Success'),
      Warning: getVariant('Warning'),
      Critical: getVariant('Critical'),
    },
  },
  defaultVariants: {
    variant: 'Surface',
  },
});

export type ContainerColorVariants = RecipeVariants<typeof ContainerColor>;
