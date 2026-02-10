import { useCallback } from 'react';
import { useTripContext } from '../store';
import { itineraryApi } from '../api';
import type { TravelNode, SearchConditions } from '../types';

// Backend response types
interface ItineraryResponse {
  success: boolean;
  itinerary?: any;
  error?: string;
}

interface ChatResponse {
  success: boolean;
  itinerary?: any;
  response?: string;
  error?: string;
}

interface NodeResponse {
  success: boolean;
  node?: any;
  error?: string;
}

export function useItinerary() {
  const { state, dispatch } = useTripContext();

  const loadItinerary = useCallback(async (tripId: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await itineraryApi.get(tripId);
      const data = response.data as unknown as ItineraryResponse;
      
      if (data.success && data.itinerary) {
        dispatch({ type: 'SET_ITINERARY', payload: data.itinerary });
        return data.itinerary;
      } else {
        // 行程不存在，返回 null 让 PlanningPage 触发自动生成
        return null;
      }
    } catch (error) {
      // 404 或其他错误，返回 null 让 PlanningPage 触发自动生成
      console.log('Load itinerary failed, will trigger auto-generate');
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const generateItinerary = useCallback(async (tripId: string, conditions: SearchConditions, days: number) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await itineraryApi.generate(tripId, conditions, days);
      console.log('Generate response raw:', response.data);
      const data = response.data as unknown as ItineraryResponse;
      
      console.log('Generate data parsed:', {
        success: data.success,
        hasItinerary: !!data.itinerary,
        itineraryId: data.itinerary?.id,
        nodesCount: data.itinerary?.nodes?.length,
        totalDays: data.itinerary?.totalDays,
        startDate: data.itinerary?.startDate,
        firstNode: data.itinerary?.nodes?.[0]?.name,
      });
      
      if (data.success && data.itinerary) {
        dispatch({ type: 'SET_ITINERARY', payload: data.itinerary });
        return data.itinerary;
      } else {
        const errorMsg = data.error || '生成行程失败，请稍后重试';
        dispatch({ type: 'SET_ERROR', payload: errorMsg });
        return null;
      }
    } catch (error) {
      const errorMsg = error instanceof Error 
        ? `生成行程失败: ${error.message}` 
        : '生成行程失败，请检查网络连接后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch]);

  const sendChatMessage = useCallback(async (tripId: string, message: string) => {
    console.log('Sending chat message:', { tripId, message });
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    // Add user message to chat history
    dispatch({
      type: 'ADD_CHAT_MESSAGE',
      payload: { role: 'user', content: message, timestamp: new Date() },
    });

    try {
      // 传递当前的聊天历史给后端
      const chatHistoryForApi = state.chatHistory.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));
      
      const response = await itineraryApi.chat(tripId, message, chatHistoryForApi);
      console.log('Chat response raw:', response.data);
      const data = response.data as unknown as ChatResponse;
      
      console.log('Chat data parsed:', {
        success: data.success,
        hasItinerary: !!data.itinerary,
        itineraryId: data.itinerary?.id,
        nodesCount: data.itinerary?.nodes?.length,
        nodesType: typeof data.itinerary?.nodes,
        totalDays: data.itinerary?.totalDays,
        destination: data.itinerary?.destination,
        firstNode: data.itinerary?.nodes?.[0]?.name,
        responseText: data.response?.substring(0, 100),
      });
      
      if (data.success) {
        // Add assistant response to chat history - 确保始终有回复
        const assistantResponse = data.response || '已收到您的反馈。';
        dispatch({
          type: 'ADD_CHAT_MESSAGE',
          payload: { role: 'assistant', content: assistantResponse, timestamp: new Date() },
        });
        
        // Update itinerary - 始终更新，确保 nodes 数组存在
        if (data.itinerary) {
          const itineraryWithNodes = {
            ...data.itinerary,
            nodes: Array.isArray(data.itinerary.nodes) ? data.itinerary.nodes : [],
          };
          console.log('Dispatching SET_ITINERARY with:', {
            id: itineraryWithNodes.id,
            nodesCount: itineraryWithNodes.nodes?.length,
            totalDays: itineraryWithNodes.totalDays,
            firstNodeName: itineraryWithNodes.nodes?.[0]?.name,
          });
          dispatch({ type: 'SET_ITINERARY', payload: itineraryWithNodes });
        } else {
          console.warn('No itinerary in response, reloading from server');
          // 如果响应中没有 itinerary，重新从服务器加载
          await loadItinerary(tripId);
        }
        
        return { itinerary: data.itinerary, response: data.response };
      } else {
        const errorMsg = data.error || '发送消息失败，AI助手暂时无法响应';
        // 添加错误消息到聊天历史
        dispatch({
          type: 'ADD_CHAT_MESSAGE',
          payload: { role: 'assistant', content: `抱歉，${errorMsg}`, timestamp: new Date() },
        });
        dispatch({ type: 'SET_ERROR', payload: errorMsg });
        return null;
      }
    } catch (error) {
      console.error('Chat error:', error);
      const errorMsg = error instanceof Error 
        ? `发送消息失败: ${error.message}` 
        : '发送消息失败，请检查网络连接后重试';
      // 添加错误消息到聊天历史
      dispatch({
        type: 'ADD_CHAT_MESSAGE',
        payload: { role: 'assistant', content: `抱歉，${errorMsg}`, timestamp: new Date() },
      });
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch, loadItinerary, state.chatHistory]);

  const updateNode = useCallback(async (
    tripId: string,
    nodeId: string,
    updates: Partial<TravelNode>
  ) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await itineraryApi.updateNode(tripId, nodeId, updates);
      const data = response.data as unknown as NodeResponse;
      
      if (data.success && data.node) {
        // Update the node in the itinerary
        if (state.itinerary) {
          const updatedNodes = state.itinerary.nodes.map((node) =>
            node.id === nodeId ? data.node : node
          );
          dispatch({
            type: 'SET_ITINERARY',
            payload: { ...state.itinerary, nodes: updatedNodes },
          });
        }
        
        return data.node;
      } else {
        const errorMsg = data.error || '更新节点失败，请稍后重试';
        dispatch({ type: 'SET_ERROR', payload: errorMsg });
        return null;
      }
    } catch (error) {
      const errorMsg = error instanceof Error 
        ? `更新节点失败: ${error.message}` 
        : '更新节点失败，请检查网络连接后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch, state.itinerary]);

  const verifyNode = useCallback(async (tripId: string, nodeId: string) => {
    console.log('Verifying node:', { tripId, nodeId });
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      const response = await itineraryApi.verifyNode(tripId, nodeId);
      console.log('Verify response:', response.data);
      const data = response.data as unknown as NodeResponse;
      
      if (data.success && data.node) {
        // Update the node in the itinerary
        if (state.itinerary) {
          const updatedNodes = state.itinerary.nodes.map((node) =>
            node.id === nodeId ? data.node : node
          );
          dispatch({
            type: 'SET_ITINERARY',
            payload: { ...state.itinerary, nodes: updatedNodes },
          });
        }
        
        return data.node;
      } else {
        const errorMsg = data.error || '验证节点失败，无法获取最新信息';
        dispatch({ type: 'SET_ERROR', payload: errorMsg });
        return null;
      }
    } catch (error) {
      console.error('Verify node error:', error);
      const errorMsg = error instanceof Error 
        ? `验证节点失败: ${error.message}` 
        : '验证节点失败，请检查网络连接后重试';
      dispatch({ type: 'SET_ERROR', payload: errorMsg });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [dispatch, state.itinerary]);

  // Group nodes by day
  const nodesByDay = (state.itinerary?.nodes || []).reduce((acc, node) => {
    const day = node.dayIndex;
    if (!acc[day]) {
      acc[day] = [];
    }
    acc[day].push(node);
    return acc;
  }, {} as Record<number, TravelNode[]>);

  // Sort nodes within each day by order
  Object.keys(nodesByDay).forEach((day) => {
    const dayNodes = nodesByDay[Number(day)];
    if (dayNodes) {
      dayNodes.sort((a, b) => a.order - b.order);
    }
  });

  // 清空聊天记录
  const clearChatHistory = useCallback(() => {
    dispatch({ type: 'SET_CHAT_HISTORY', payload: [] });
  }, [dispatch]);

  return {
    // State
    itinerary: state.itinerary,
    chatHistory: state.chatHistory,
    nodesByDay,
    isLoading: state.isLoading,
    error: state.error,
    // Actions
    loadItinerary,
    generateItinerary,
    sendChatMessage,
    updateNode,
    verifyNode,
    clearChatHistory,
  };
}
