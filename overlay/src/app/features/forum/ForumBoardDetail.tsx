import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Scroll, Text, color } from 'folds';
import { Icon, Icons } from '../../components/icons';
import classNames from 'classnames';
import { useSetAtom } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { useMatrixClient } from '../../hooks/useMatrixClient';
import { useCompactNav } from '../../hooks/useCompactNav';
import { Page, PageContent } from '../../components/page';
import { ContainerColor } from '../../styles/ContainerColor.css';
import { activeThreadIdAtomFamily } from '../../state/activeThread';
import { getCanonicalAliasOrRoomId } from '../../utils/matrix';
import { getSpacePath } from '../../pages/pathUtils';
import { useForumBoardContext } from './ForumBoardContext';
import { ForumThreadDetail } from './ForumThreadDetail';
import type { ForumPost } from './types';
import * as theme from './forumTheme.css';

/** Thread detail in the main pane; post list lives in ForumFeedSidebar. */
export function ForumBoardDetail() {
  const mx = useMatrixClient();
  const navigate = useNavigate();
  const compact = useCompactNav();
  const [optimisticPost, setOptimisticPost] = useState<ForumPost | null>(null);

  const {
    forumSpace,
    query,
    error,
    selectedPostId,
    activeTopicRoomId,
    threads,
    recordThreadReply,
  } = useForumBoardContext();

  // Compact: /feed/ without a selected post has no detail content — return to the list
  // so an empty detail layer cannot cover the forum sidebar.
  useEffect(() => {
    if (!compact || selectedPostId) return;
    navigate(getSpacePath(getCanonicalAliasOrRoomId(mx, forumSpace.roomId)), { replace: true });
  }, [compact, selectedPostId, navigate, mx, forumSpace.roomId]);

  const activeTopicRoom = activeTopicRoomId ? mx.getRoom(activeTopicRoomId) : null;
  const topicSelected = Boolean(query.topic);

  const setActiveThreadId = useSetAtom(
    activeThreadIdAtomFamily(activeTopicRoomId ?? forumSpace.roomId)
  );

  useEffect(() => {
    if (selectedPostId && activeTopicRoomId) {
      setActiveThreadId(selectedPostId);
      return () => setActiveThreadId(undefined);
    }
    setActiveThreadId(undefined);
    return undefined;
  }, [selectedPostId, activeTopicRoomId, setActiveThreadId]);

  useEffect(() => {
    if (optimisticPost && optimisticPost.eventId !== selectedPostId) {
      setOptimisticPost(null);
    }
  }, [optimisticPost, selectedPostId]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.eventId === selectedPostId),
    [threads, selectedPostId]
  );

  const handleReplySent = useCallback(
    (_reply: ForumPost) => {
      if (selectedPostId) {
        recordThreadReply(selectedPostId);
      }
    },
    [recordThreadReply, selectedPostId]
  );

  const showThread = Boolean(selectedPostId && activeTopicRoom);
  const threadInitialPost =
    optimisticPost?.eventId === selectedPostId ? optimisticPost : null;
  const detailDropRef = useRef<HTMLDivElement>(null);

  return (
    <Page className={classNames(ContainerColor({ variant: 'Background' }), theme.ForumAppRoot)}>
      <PageContent className={theme.ForumPageContent}>
        {error && (
          <Text as="p" style={{ color: color.Critical.Main, padding: '0.5rem 1rem' }}>
            {error}
          </Text>
        )}
        <aside className={theme.ForumDetailPane}>
          {showThread && activeTopicRoom ? (
            <div ref={detailDropRef} className={theme.ForumTopicPostDetailThreadLayout}>
              <ForumThreadDetail
                roomId={activeTopicRoom.roomId}
                rootEventId={selectedPostId!}
                titleHint={selectedThread?.title}
                initialPost={threadInitialPost}
                fileDropContainerRef={detailDropRef}
                onReplySent={handleReplySent}
              />
            </div>
          ) : (
            <Scroll
              id="topicPostDetail"
              className={theme.ForumTopicPostDetailScroll}
              variant="Surface"
              direction="Vertical"
              size="300"
              hideTrack
              visibility="Hover"
            >
              <div className={theme.ForumTopicPostDetailInner}>
                <Box
                  className={theme.ForumEmptyDetail}
                  direction="Column"
                  alignItems="Center"
                  justifyContent="Center"
                  gap="300"
                >
                  <Icon src={Icons.Thread} size="600" />
                  <Text size="T300" priority="300">
                    {topicSelected
                      ? 'Select a post to read the thread'
                      : 'Pick a category and topic, then choose a post'}
                  </Text>
                </Box>
              </div>
            </Scroll>
          )}
        </aside>
      </PageContent>
    </Page>
  );
}
