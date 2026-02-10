import { useCallback } from 'react';
import { useTripContext } from '../store';
import { diaryApi, memoirApi } from '../api';
import type { TravelNode, DiaryFragment } from '../types';

export function useDiary() {
  const { state, dispatch } = useTripContext();

  const loadFragments = useCallback(async (tripId: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.getFragments(tripId);
      const data = response.data as any;
      const fragments = data.fragments || data || [];
      dispatch({ type: 'SET_DIARY_FRAGMENTS', payload: fragments });
      return fragments;
    } catch (error) {
      // 404 表示没有日记，不是错误
      dispatch({ type: 'SET_DIARY_FRAGMENTS', payload: [] });
      return [];
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const uploadPhoto = useCallback(async (tripId: string, nodeId: string, file: File) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.uploadPhoto(tripId, nodeId, file);
      return response.data.photo || response.data;
    } catch (error) {
      const errorMsg = '上传照片失败，请检查文件格式或网络连接';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const lightNode = useCallback(async (
    tripId: string, 
    nodeId: string, 
    textNotes?: string[],
    weather?: string,
    timeRange?: string,
    mood?: string
  ) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.lightNode(tripId, nodeId, textNotes, weather, timeRange, mood);
      const fragment = response.data.fragment || response.data;
      dispatch({ type: 'ADD_DIARY_FRAGMENT', payload: fragment });
      return fragment;
    } catch (error) {
      const errorMsg = '生成日记失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const regenerateNode = useCallback(async (
    tripId: string, 
    nodeId: string, 
    textNotes?: string[],
    weather?: string,
    timeRange?: string,
    mood?: string
  ) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.regenerateNode(tripId, nodeId, textNotes, weather, timeRange, mood);
      const fragment = response.data.fragment || response.data;
      dispatch({ type: 'UPDATE_DIARY_FRAGMENT', payload: fragment });
      return fragment;
    } catch (error) {
      const errorMsg = '重新生成日记失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const updateFragment = useCallback(async (fragmentId: string, content: string, moodEmoji?: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.updateFragment(fragmentId, content, moodEmoji);
      const fragment = response.data.fragment || response.data;
      dispatch({ type: 'UPDATE_DIARY_FRAGMENT', payload: fragment });
      return fragment;
    } catch (error) {
      const errorMsg = '更新日记失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  // 变更行程
  const changeItinerary = useCallback(async (
    tripId: string,
    nodeId: string,
    newDestination: string,
    changeReason: string
  ): Promise<{ originalNode: TravelNode; newNode: TravelNode } | null> => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.changeItinerary(tripId, nodeId, newDestination, changeReason);
      const data = response.data as any;
      return {
        originalNode: data.originalNode,
        newNode: data.newNode,
      };
    } catch (error) {
      const errorMsg = '变更行程失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  // 标记未实现
  const markUnrealized = useCallback(async (
    tripId: string,
    nodeId: string,
    reason: string,
    moodEmoji?: string,
    weather?: string
  ): Promise<{ node: TravelNode; fragment: DiaryFragment } | null> => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.markUnrealized(tripId, nodeId, reason, moodEmoji, weather);
      const data = response.data as any;
      // 添加日记片段到状态
      if (data.fragment) {
        dispatch({ type: 'ADD_DIARY_FRAGMENT', payload: data.fragment });
      }
      return {
        node: data.node,
        fragment: data.fragment,
      };
    } catch (error) {
      const errorMsg = '标记未实现失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  // 点亮变更节点
  const lightChangedNode = useCallback(async (
    tripId: string,
    nodeId: string,
    textNotes?: string[],
    weather?: string,
    timeRange?: string,
    mood?: string
  ) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await diaryApi.lightChangedNode(tripId, nodeId, textNotes, weather, timeRange, mood);
      const fragment = response.data.fragment || response.data;
      dispatch({ type: 'ADD_DIARY_FRAGMENT', payload: fragment });
      return fragment;
    } catch (error) {
      const errorMsg = '点亮变更节点失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const completeTrip = useCallback(async (tripId: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await memoirApi.complete(tripId);
      // API returns { success: true, memoir: {...} }
      const data = response.data as any;
      const memoir = data.memoir || data;
      dispatch({ type: 'SET_MEMOIR', payload: memoir });
      return memoir;
    } catch (error) {
      const errorMsg = '生成回忆录失败，请确保已记录旅行日记';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const loadMemoir = useCallback(async (tripId: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await memoirApi.get(tripId);
      // API returns { success: true, memoir: {...} }
      const data = response.data as any;
      const memoir = data.memoir || data;
      dispatch({ type: 'SET_MEMOIR', payload: memoir });
      return memoir;
    } catch (error) {
      const errorMsg = '加载回忆录失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const changeTemplate = useCallback(async (tripId: string, templateId: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await memoirApi.changeTemplate(tripId, templateId);
      return response.data;
    } catch (error) {
      const errorMsg = '切换模板失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  return {
    // State
    diaryFragments: state.diaryFragments,
    memoir: state.memoir,
    isLoading: state.isLoading,
    error: state.error,
    // Actions
    loadFragments,
    uploadPhoto,
    lightNode,
    regenerateNode,
    updateFragment,
    changeItinerary,
    markUnrealized,
    lightChangedNode,
    completeTrip,
    loadMemoir,
    changeTemplate,
  };
}
