import { matchPath, useLocation } from 'react-router-dom';
import { DIRECT_PATH, EXPLORE_PATH, HOME_PATH, INBOX_PATH, SPACE_PATH } from '../pages/paths';
import { ScreenSize, useScreenSizeContext } from './useScreenSize';

/** Skinny window layout (≤750px): master-detail instead of 3-column desktop. */
export const useCompactNav = (): boolean => {
  const screenSize = useScreenSizeContext();
  return screenSize === ScreenSize.Mobile;
};

const LIST_ROUTE_PATHS = [HOME_PATH, DIRECT_PATH, SPACE_PATH, EXPLORE_PATH, INBOX_PATH] as const;

/**
 * Routes where sidebar + channel list are shown together (no room/content pane).
 * Uses matchPath on the current pathname so trailing-slash / encoding quirks
 * after DM → space navigations still count as master list routes.
 */
export const useIsCompactListRoute = (): boolean => {
  const { pathname } = useLocation();

  return LIST_ROUTE_PATHS.some(
    (path) => matchPath({ path, caseSensitive: true, end: true }, pathname) != null
  );
};

export const useShowCompactMasterView = (): boolean => {
  const compact = useCompactNav();
  const isListRoute = useIsCompactListRoute();
  return compact && isListRoute;
};
