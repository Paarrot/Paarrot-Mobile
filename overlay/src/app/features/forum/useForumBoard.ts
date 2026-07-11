import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MatrixEvent, Room, RoomStateEvent } from 'matrix-js-sdk';
import { useAtomValue } from 'jotai';
import { useMatrixClient } from '../../hooks/useMatrixClient';
import { useSelectedRoom } from '../../hooks/router/useSelectedRoom';
import { useCompactNav } from '../../hooks/useCompactNav';
import { getCanonicalAliasOrRoomId } from '../../utils/matrix';
import { getSpaceFeedPath, getSpaceLobbyPath, getSpacePath } from '../../pages/pathUtils';
import { createRoomModalAtom } from '../../state/createRoomModal';
import { createSpaceModalAtom } from '../../state/createSpaceModal';
import { StateEvent } from '../../../types/matrix/room';
import {
  buildForumSections,
  buildTopicThreads,
  buildThreadSummaries,
} from './forumTopicHelpers';
import { applyTopicStatusSort } from './topicSearch';
import {
  createForumPostFromPayload,
  listForumTopics,
  listTopicFeedPosts,
  loadAggregatedTopicFeed,
} from './forumFeed';
import type {
  ForumBoardQuery,
  ForumPost,
  ForumPublishedPost,
  ForumSection,
  ForumThreadSummary,
} from './types';
import { useForumRoomLiveUpdates } from './useForumRoomLiveUpdates';

export type ForumBoardScope = {
  forumSpaceId: string;
  /** When set, only show posts from this topic room. */
  topicRoomId?: string;
};

function scopesFromSelection(
  sections: ForumSection[],
  category?: string,
  topic?: string
): Array<{ roomId: string; sectionTitle?: string; topicName?: string }> {
  if (topic) {
    for (const section of sections) {
      const match = section.topics.find((t) => t.roomId === topic);
      if (match) {
        return [{ roomId: match.roomId, sectionTitle: section.title, topicName: match.name }];
      }
    }
    return [{ roomId: topic }];
  }

  if (category) {
    const section = sections.find((s) => s.title === category);
    if (!section) return [];
    return section.topics.map((t) => ({
      roomId: t.roomId,
      sectionTitle: section.title,
      topicName: t.name,
    }));
  }

  return sections.flatMap((section) =>
    section.topics.map((t) => ({
      roomId: t.roomId,
      sectionTitle: section.title,
      topicName: t.name,
    }))
  );
}

export function useForumBoard(scope: ForumBoardScope, forumSpace: Room) {
  const mx = useMatrixClient();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedRoomId = useSelectedRoom();
  const compact = useCompactNav();

  const searchParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search]
  );

  const filterQuery: ForumBoardQuery = useMemo(
    () => ({
      category: searchParams.get('category') || undefined,
      topic: searchParams.get('topic') || undefined,
      q: searchParams.get('q') || undefined,
      status: (searchParams.get('status') as ForumBoardQuery['status']) || 'all',
      sort: (searchParams.get('sort') as ForumBoardQuery['sort']) || 'hot',
    }),
    [searchParams]
  );

  const query: ForumBoardQuery = useMemo(
    () => ({
      ...filterQuery,
      post: searchParams.get('post') || undefined,
      postRoom: searchParams.get('postRoom') || undefined,
    }),
    [filterQuery, searchParams]
  );

  const [sections, setSections] = useState<ForumSection[]>([]);
  const [threads, setThreads] = useState<ForumThreadSummary[]>([]);
  const [loadingSections, setLoadingSections] = useState(true);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [postsNextBatch, setPostsNextBatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyForumSearchParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(location.search);
      mutate(next);
      const search = next.toString();
      const spaceIdOrAlias = getCanonicalAliasOrRoomId(mx, forumSpace.roomId);

      const onTopicRoomRoute =
        Boolean(selectedRoomId) && selectedRoomId !== forumSpace.roomId;

      // Compact master view only mounts the post list on /:spaceId/. Opening a post
      // must switch to /feed/ so ForumFeedPage mounts as the detail pane.
      let pathname = location.pathname;
      if (onTopicRoomRoute) {
        pathname = getSpaceLobbyPath(spaceIdOrAlias);
      } else if (next.get('post')) {
        pathname = getSpaceFeedPath(spaceIdOrAlias);
      } else if (compact) {
        pathname = getSpacePath(spaceIdOrAlias);
      }

      navigate(
        {
          pathname,
          search: search ? `?${search}` : '',
        },
        { replace: true }
      );
    },
    [
      location.pathname,
      location.search,
      navigate,
      mx,
      forumSpace.roomId,
      selectedRoomId,
      compact,
    ]
  );

  const setQueryParam = useCallback(
    (key: string, value: string | null) => {
      applyForumSearchParams((next) => {
        if (!value) next.delete(key);
        else next.set(key, value);
        if (key !== 'post') {
          next.delete('post');
          next.delete('postRoom');
        }
      });
    },
    [applyForumSearchParams]
  );

  const setCategory = useCallback(
    (category: string | null) => {
      applyForumSearchParams((next) => {
        if (!category) next.delete('category');
        else next.set('category', category);
        next.delete('topic');
        next.delete('post');
        next.delete('postRoom');
      });
    },
    [applyForumSearchParams]
  );

  const loadSections = useCallback(async () => {
    setLoadingSections(true);
    setError(null);
    try {
      const topics = await listForumTopics(mx, scope.forumSpaceId);
      setSections(buildForumSections(topics));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load forum categories');
    } finally {
      setLoadingSections(false);
    }
  }, [mx, scope.forumSpaceId]);

  const refreshThreads = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoadingThreads(true);
    setError(null);
    try {
      const roomScopes = scopesFromSelection(sections, filterQuery.category, filterQuery.topic);
      if (roomScopes.length === 0) {
        setThreads([]);
        return;
      }

      let posts;
      if (roomScopes.length === 1) {
        const result = await listTopicFeedPosts(mx, roomScopes[0].roomId);
        posts = result.posts;
        setPostsNextBatch(result.nextBatch);
        const scopeMeta = roomScopes[0];
        posts.forEach((post) => {
          post.topicRoomId = scopeMeta.roomId;
          if (scopeMeta.sectionTitle) post.sectionTitle = scopeMeta.sectionTitle;
          if (scopeMeta.topicName) post.topicName = scopeMeta.topicName;
        });
      } else {
        posts = await loadAggregatedTopicFeed(mx, roomScopes);
        setPostsNextBatch(null);
      }

      setThreads(buildTopicThreads(posts, filterQuery));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load forum posts');
    } finally {
      if (!options?.silent) setLoadingThreads(false);
    }
  }, [mx, sections, filterQuery]);

  useEffect(() => {
    loadSections();
  }, [loadSections]);

  useEffect(() => {
    const handleSpaceChild = (event: MatrixEvent) => {
      if (event.getType() !== StateEvent.SpaceChild) return;
      const roomId = event.getRoomId();
      if (!roomId) return;
      if (
        roomId === forumSpace.roomId ||
        sections.some((section) => section.spaceId === roomId)
      ) {
        loadSections();
      }
    };
    mx.on(RoomStateEvent.Events, handleSpaceChild);
    return () => {
      mx.removeListener(RoomStateEvent.Events, handleSpaceChild);
    };
  }, [mx, forumSpace.roomId, sections, loadSections]);

  const createSpaceModal = useAtomValue(createSpaceModalAtom);
  const createRoomModal = useAtomValue(createRoomModalAtom);
  const prevCreateSpaceModal = useRef(createSpaceModal);
  const prevCreateRoomModal = useRef(createRoomModal);
  useEffect(() => {
    if (prevCreateSpaceModal.current && !createSpaceModal) {
      loadSections();
    }
    if (prevCreateRoomModal.current && !createRoomModal) {
      loadSections();
    }
    prevCreateSpaceModal.current = createSpaceModal;
    prevCreateRoomModal.current = createRoomModal;
  }, [createSpaceModal, createRoomModal, loadSections]);

  useEffect(() => {
    if (loadingSections) return;
    void refreshThreads();
  }, [
    loadingSections,
    refreshThreads,
    filterQuery.category,
    filterQuery.topic,
    filterQuery.q,
    filterQuery.status,
    filterQuery.sort,
  ]);

  const scopedRooms = useMemo(() => {
    if (loadingSections) return [];
    const roomScopes = scopesFromSelection(sections, filterQuery.category, filterQuery.topic);
    return roomScopes
      .map((scope) => mx.getRoom(scope.roomId))
      .filter((room): room is Room => room !== null);
  }, [loadingSections, sections, filterQuery.category, filterQuery.topic, mx]);

  useForumRoomLiveUpdates(scopedRooms, () => {
    void refreshThreads({ silent: true });
  });

  const selectedPostId = query.post ?? null;
  const selectedThread = threads.find((t) => t.eventId === selectedPostId);
  const activeTopicRoomId =
    query.postRoom || selectedThread?.topicRoomId || query.topic || scope.topicRoomId || null;

  const selectPost = useCallback(
    (eventId: string | null, topicRoomId?: string) => {
      applyForumSearchParams((next) => {
        if (!eventId) {
          next.delete('post');
          next.delete('postRoom');
        } else {
          next.set('post', eventId);
          if (topicRoomId) next.set('postRoom', topicRoomId);
          else next.delete('postRoom');
        }
      });
    },
    [applyForumSearchParams]
  );

  const insertThreadFromNewPost = useCallback(
    (published: ForumPublishedPost): ForumPost | null => {
      const roomScopes = scopesFromSelection(sections, filterQuery.category, filterQuery.topic);
      const inScope =
        filterQuery.topic === published.topicRoomId ||
        (!filterQuery.topic &&
          (filterQuery.category
            ? roomScopes.some((s) => s.roomId === published.topicRoomId)
            : true));

      const scopeMeta = roomScopes.find((s) => s.roomId === published.topicRoomId);
      const post = createForumPostFromPayload(
        mx,
        published.topicRoomId,
        published.eventId,
        {
          title: published.title,
          plainText: published.plainText,
          formattedHtml: published.formattedHtml,
        },
        {
          topicRoomId: published.topicRoomId,
          sectionTitle: scopeMeta?.sectionTitle,
          topicName: scopeMeta?.topicName,
        }
      );

      if (inScope) {
        const [summary] = buildThreadSummaries([post]);
        if (summary) {
          setThreads((prev) => {
            const without = prev.filter((t) => t.eventId !== summary.eventId);
            const merged = [summary, ...without];
            return applyTopicStatusSort(merged, filterQuery.status || 'all', filterQuery.sort || 'hot');
          });
        }
      }

      return post;
    },
    [mx, sections, filterQuery]
  );

  const recordThreadReply = useCallback((rootEventId: string) => {
    setThreads((prev) =>
      prev.map((t) =>
        t.eventId === rootEventId
          ? {
              ...t,
              totalReplies: t.totalReplies + 1,
              lastActivityTs: Date.now(),
            }
          : t
      )
    );
  }, []);

  const loadMorePosts = useCallback(async () => {
    if (!postsNextBatch || loadingMore) return;
    const roomScopes = scopesFromSelection(sections, filterQuery.category, filterQuery.topic);
    if (roomScopes.length !== 1) return;

    setLoadingMore(true);
    setError(null);
    try {
      const scopeMeta = roomScopes[0];
      const result = await listTopicFeedPosts(mx, scopeMeta.roomId, {
        from: postsNextBatch,
        minRoots: 1,
      });
      setPostsNextBatch(result.nextBatch);
      result.posts.forEach((post) => {
        post.topicRoomId = scopeMeta.roomId;
        if (scopeMeta.sectionTitle) post.sectionTitle = scopeMeta.sectionTitle;
        if (scopeMeta.topicName) post.topicName = scopeMeta.topicName;
      });
      setThreads((prev) => {
        const existingIds = new Set(prev.map((t) => t.eventId));
        const added = buildTopicThreads(result.posts, filterQuery).filter(
          (t) => !existingIds.has(t.eventId)
        );
        const merged = [...prev, ...added];
        const sort = filterQuery.sort || 'hot';
        merged.sort((a, b) => {
          if (sort === 'new') return b.timestamp - a.timestamp;
          if (sort === 'top') return b.totalReplies - a.totalReplies;
          const hotA = a.totalReplies * 4 + Math.floor((a.lastActivityTs - a.timestamp) / 3600000);
          const hotB = b.totalReplies * 4 + Math.floor((b.lastActivityTs - b.timestamp) / 3600000);
          return hotB - hotA;
        });
        return merged;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load older posts');
    } finally {
      setLoadingMore(false);
    }
  }, [postsNextBatch, loadingMore, sections, filterQuery, mx]);

  return {
    forumSpace,
    sections,
    threads,
    query,
    loadingSections,
    loadingThreads,
    error,
    selectedPostId,
    selectedThread,
    activeTopicRoomId,
    setQueryParam,
    setCategory,
    selectPost,
    refreshThreads,
    insertThreadFromNewPost,
    recordThreadReply,
    loadMorePosts,
    hasMorePosts: Boolean(postsNextBatch),
    loadingMore,
  };
}
