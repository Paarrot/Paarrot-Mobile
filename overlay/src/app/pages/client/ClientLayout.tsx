import React, { ReactNode } from 'react';
import { Box } from 'folds';
import { DockedCallPanel } from '../../features/call/DockedCallPanel';
import { useMobileKeyboardLayout } from '../../hooks/useMobileKeyboardLayout';

type ClientLayoutProps = {
  nav: ReactNode;
  children: ReactNode;
};

export function ClientLayout({ nav, children }: ClientLayoutProps) {
  const { keyboardOpen } = useMobileKeyboardLayout();

  return (
    <Box grow="Yes">
      {!keyboardOpen && <Box shrink="No">{nav}</Box>}
      <Box grow="Yes">{children}</Box>
      <DockedCallPanel />
    </Box>
  );
}
