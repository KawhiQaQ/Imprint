import { useCallback } from 'react';
import { useTripContext } from '../store';
import { visionApi, destinationApi, tripApi } from '../api';
import type { SearchConditions } from '../types';

export function useTrip() {
  const { state, dispatch } = useTripContext();

  const analyzeVision = useCallback(async (text: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });
    dispatch({ type: 'SET_VISION_TEXT', payload: text });
    // 清除旧的推荐结果，避免显示上次的城市
    dispatch({ type: 'SET_DESTINATIONS', payload: [] });
    dispatch({ type: 'CLEAR_EXCLUDED_CITIES' });

    try {
      const response = await visionApi.analyze(text);
      if (response.data.success) {
        dispatch({ type: 'SET_SEARCH_CONDITIONS', payload: response.data.conditions });
        return response.data;
      } else {
        const errorMsg = response.data.errorMessage || '分析失败，请重新描述您的旅行愿景';
        dispatch({ type: 'SET_ERROR', payload: errorMsg });
        return null;
      }
    } catch (error) {
      const errorMsg = '网络错误，请检查网络连接后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const recommendDestinations = useCallback(async (conditions: SearchConditions, refresh = false) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    // 换一批时，排除当前显示的城市
    const excludedCities = refresh ? state.excludedCities : [];

    try {
      const response = await destinationApi.recommend(conditions, excludedCities);
      if (response.data.success) {
        dispatch({ type: 'SET_DESTINATIONS', payload: response.data.destinations });
        // 无论是否刷新，都把新的城市加入排除列表
        dispatch({ 
          type: 'ADD_EXCLUDED_CITIES', 
          payload: response.data.destinations.map(d => d.cityName) 
        });
        return response.data;
      } else {
        const errorMsg = response.data.errorMessage || '推荐失败，请稍后重试';
        dispatch({ type: 'SET_ERROR', payload: errorMsg });
        return null;
      }
    } catch (error) {
      const errorMsg = '网络错误，请检查网络连接后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch, state.excludedCities]);

  const selectDestination = useCallback(async (
    userId: string,
    destination: string,
    conditions: SearchConditions
  ) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      console.log('selectDestination - startDate:', conditions.startDate);
      console.log('selectDestination - totalDays:', conditions.totalDays);
      
      const response = await destinationApi.select(
        userId,
        state.visionText,
        destination,
        conditions
      );
      
      console.log('destinationApi.select response - itinerary startDate:', response.data.itinerary?.startDate);
      
      dispatch({ type: 'SET_CURRENT_TRIP', payload: response.data.trip });
      dispatch({ type: 'SET_ITINERARY', payload: response.data.itinerary });
      return response.data;
    } catch (error: any) {
      console.error('selectDestination error:', error);
      const errorMsg = error?.response?.data?.error || '创建旅程失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch, state.visionText]);

  const loadTrip = useCallback(async (tripId: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await tripApi.getTrip(tripId);
      // 后端直接返回 trip 对象
      const trip = response.data;
      console.log('Loaded trip:', trip);
      dispatch({ type: 'SET_CURRENT_TRIP', payload: trip });
      // 如果 trip 包含 searchConditions，也设置到 state
      if (trip.searchConditions) {
        dispatch({ type: 'SET_SEARCH_CONDITIONS', payload: trip.searchConditions });
      }
      return trip;
    } catch (error) {
      const errorMsg = '加载旅程失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const resetTrip = useCallback(() => {
    dispatch({ type: 'RESET_STATE' });
  }, [dispatch]);

  const updateSearchConditions = useCallback((updates: Partial<SearchConditions>) => {
    if (state.searchConditions) {
      dispatch({ 
        type: 'SET_SEARCH_CONDITIONS', 
        payload: { ...state.searchConditions, ...updates } 
      });
    }
  }, [dispatch, state.searchConditions]);

  const directSelectCity = useCallback(async (
    userId: string,
    cityName: string,
    options?: {
      startDate?: string;
      totalDays?: number;
      arrivalTime?: string;
      departureTime?: string;
    }
  ) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });
    dispatch({ type: 'SET_VISION_TEXT', payload: `直接选择目的地：${cityName}` });

    try {
      const response = await destinationApi.directSelect(userId, cityName, options);
      dispatch({ type: 'SET_CURRENT_TRIP', payload: response.data.trip });
      dispatch({ type: 'SET_ITINERARY', payload: response.data.itinerary });
      return response.data;
    } catch (error: any) {
      console.error('directSelectCity error:', error);
      const errorMsg = error?.response?.data?.error || '选择城市失败，请稍后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  return {
    // State
    currentTrip: state.currentTrip,
    visionText: state.visionText,
    searchConditions: state.searchConditions,
    destinations: state.destinations,
    isLoading: state.isLoading,
    error: state.error,
    // Actions
    analyzeVision,
    recommendDestinations,
    selectDestination,
    directSelectCity,
    loadTrip,
    resetTrip,
    updateSearchConditions,
  };
}
