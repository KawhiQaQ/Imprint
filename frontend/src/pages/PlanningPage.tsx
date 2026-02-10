import React, { useEffect, useCallback, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ChatPanel, ItineraryBoard, Button, LoadingOverlay } from '../components';
import { useItinerary, useTrip } from '../hooks';
import type { TravelNode } from '../types';
import './PlanningPage.css';

const PlanningPage: React.FC = () => {
  const { tripId } = useParams<{ tripId: string }>();
  const navigate = useNavigate();
  const {
    itinerary,
    chatHistory,
    isLoading,
    error,
    loadItinerary,
    generateItinerary,
    sendChatMessage,
    updateNode,
    verifyNode,
    clearChatHistory,
  } = useItinerary();
  const { currentTrip, searchConditions, loadTrip } = useTrip();
  const [isGenerating, setIsGenerating] = useState(false);
  const hasTriedGenerate = useRef(false);
  // 初始化时显示 loading，避免页面跳转时的白屏闪烁
  const [initialLoading, setInitialLoading] = useState(true);

  // Debug: log itinerary changes
  useEffect(() => {
    console.log('PlanningPage - itinerary updated:', {
      id: itinerary?.id,
      nodesCount: itinerary?.nodes?.length,
      firstNode: itinerary?.nodes?.[0]?.name,
    });
  }, [itinerary]);

  // Load trip and itinerary on mount
  useEffect(() => {
    if (tripId) {
      console.log('Loading trip and itinerary for:', tripId);
      // 切换到新行程时清空聊天记录
      clearChatHistory();
      loadTrip(tripId);
      loadItinerary(tripId);
    }
  }, [tripId, loadTrip, loadItinerary, clearChatHistory]);

  // Auto-generate itinerary if empty - triggered when trip is loaded
  useEffect(() => {
    // 优先使用 currentTrip.searchConditions，因为它包含最新的 startDate 和 totalDays
    const conditions = currentTrip?.searchConditions || searchConditions;
    
    console.log('Auto-generate check:', {
      tripId,
      hasItinerary: !!itinerary,
      nodesLength: itinerary?.nodes?.length,
      isLoading,
      isGenerating,
      hasTriedGenerate: hasTriedGenerate.current,
      hasConditions: !!conditions,
      currentTrip: currentTrip?.id
    });

    const shouldGenerate = 
      tripId && 
      itinerary && 
      (!itinerary.nodes || itinerary.nodes.length === 0) && 
      !isLoading && 
      !isGenerating &&
      !hasTriedGenerate.current &&
      conditions;

    if (shouldGenerate) {
      console.log('Starting itinerary generation with conditions:', conditions);
      console.log('conditions.startDate:', conditions.startDate);
      console.log('conditions.totalDays:', conditions.totalDays);
      hasTriedGenerate.current = true;
      setIsGenerating(true);
      // 使用 conditions 中的 totalDays，如果没有则使用 itinerary.totalDays，最后默认 3 天
      const days = conditions.totalDays || itinerary?.totalDays || 3;
      generateItinerary(tripId, conditions!, days)
        .then((result) => {
          console.log('Generation result:', result);
        })
        .catch((err) => {
          console.error('Generation error:', err);
        })
        .finally(() => {
          setIsGenerating(false);
        });
    }
  }, [tripId, itinerary, isLoading, isGenerating, searchConditions, currentTrip, generateItinerary]);

  // Handle sending chat messages
  const handleSendMessage = useCallback(async (message: string) => {
    if (tripId) {
      await sendChatMessage(tripId, message);
    }
  }, [tripId, sendChatMessage]);

  // Handle node updates
  const handleNodeUpdate = useCallback(async (nodeId: string, updates: Partial<TravelNode>) => {
    if (tripId) {
      await updateNode(tripId, nodeId, updates);
    }
  }, [tripId, updateNode]);

  // Handle node reordering
  const handleNodeReorder = useCallback(async (nodeId: string, newOrder: number, newDay: number) => {
    if (tripId) {
      await updateNode(tripId, nodeId, { order: newOrder, dayIndex: newDay });
    }
  }, [tripId, updateNode]);

  // Handle node verification
  const handleNodeVerify = useCallback(async (nodeId: string) => {
    if (tripId) {
      await verifyNode(tripId, nodeId);
    }
  }, [tripId, verifyNode]);

  // Handle starting the trip
  const handleStartTrip = useCallback(() => {
    if (tripId) {
      navigate(`/traveling/${tripId}`);
    }
  }, [tripId, navigate]);

  // 是否显示全屏加载动画
  const showFullScreenLoading = initialLoading || ((isLoading || isGenerating) && (!itinerary || itinerary.nodes.length === 0));

  // 当行程数据加载完成后，关闭初始 loading
  useEffect(() => {
    if (itinerary && itinerary.nodes && itinerary.nodes.length > 0) {
      setInitialLoading(false);
    }
  }, [itinerary]);

  // Error state (only show if not loading)
  if (error && !itinerary && !showFullScreenLoading) {
    return (
      <div className="planning-page">
        <div className="planning-page__error">
          <div className="planning-page__error-icon">😕</div>
          <p className="planning-page__error-message">{error}</p>
          <Button onClick={() => tripId && loadItinerary(tripId)}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="planning-page">
      {/* 左侧面板 - The Companion (AI 助手区域) */}
      <aside className="planning-page__sidebar">
        <div className="planning-page__sidebar-header">
          <Link to="/destinations" className="planning-page__back-link">
            ← 返回选择
          </Link>
          <h1 className="planning-page__sidebar-title">
            🗺️ AI规划助手
          </h1>
          <p className="planning-page__sidebar-subtitle">
            告诉我您的偏好，我来帮您调整行程
          </p>
        </div>
        <div className="planning-page__chat-container">
          <ChatPanel
            messages={chatHistory}
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
          />
        </div>
      </aside>

      {/* 右侧面板 - The Path (行程可视化区域) */}
      <main className="planning-page__main">
        <header className="planning-page__main-header">
          <div className="planning-page__destination-info">
            <span className="planning-page__destination-marker"></span>
            <h2 className="planning-page__destination-name">
              {itinerary?.destination || currentTrip?.destination || ''}行程
            </h2>
            <span className="planning-page__trip-duration">
              {itinerary?.totalDays || currentTrip?.searchConditions?.totalDays || 3}天行程
            </span>
          </div>
          <button
            className="planning-page__start-btn"
            onClick={handleStartTrip}
            disabled={!itinerary || itinerary.nodes.length === 0}
          >
            开始旅程 →
          </button>
        </header>
        <div className="planning-page__itinerary-container">
          <ItineraryBoard
            itinerary={itinerary}
            onNodeUpdate={handleNodeUpdate}
            onNodeReorder={handleNodeReorder}
            onNodeVerify={handleNodeVerify}
            isLoading={isLoading}
          />
        </div>
      </main>

      {/* 全屏加载遮罩 - 生成行程时显示 */}
      <LoadingOverlay
        isVisible={showFullScreenLoading}
        message={isGenerating ? '正在生成您的专属行程...' : '正在加载行程...'}
        subMessage="请稍候片刻"
      />
    </div>
  );
};

export default PlanningPage;
