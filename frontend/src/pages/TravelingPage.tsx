import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button, Loading } from '../components';
import { NodeRecorder, TimedNote } from '../components/NodeRecorder';
import { DiaryFragment as DiaryFragmentComponent } from '../components/DiaryFragment';
import { useItinerary, useDiary, useTrip } from '../hooks';
import { tripApi } from '../api';
import type { TravelNode, PhotoMaterial, DiaryFragment as DiaryFragmentType } from '../types';
import './TravelingPage.css';

// Local state for materials per node
interface NodeMaterials {
  [nodeId: string]: {
    photos: PhotoMaterial[];
    textNotes: TimedNote[];
    selectedMood?: string;
    selectedWeather?: string;
  };
}

const NODE_TYPE_ICONS: Record<string, string> = {
  attraction: '🏛️',
  restaurant: '🍜',
  hotel: '🏨',
  transport: '🚗',
};

const TravelingPage: React.FC = () => {
  const { tripId } = useParams<{ tripId: string }>();
  const navigate = useNavigate();
  const { itinerary, loadItinerary, isLoading: itineraryLoading } = useItinerary();
  const {
    diaryFragments,
    loadFragments,
    uploadPhoto,
    lightNode,
    regenerateNode,
    updateFragment,
    changeItinerary,
    markUnrealized,
    lightChangedNode,
    completeTrip,
    isLoading: diaryLoading,
  } = useDiary();
  const { currentTrip, loadTrip } = useTrip();

  const [nodeMaterials, setNodeMaterials] = useState<NodeMaterials>({});
  const [lightingNodeId, setLightingNodeId] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number>(1);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editingFragmentId, setEditingFragmentId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  // 分页状态：'diary' 显示日记，'edit' 显示编辑内容
  const [activeTab, setActiveTab] = useState<'diary' | 'edit'>('diary');
  // 生成回忆录的加载状态
  const [isGeneratingMemoir, setIsGeneratingMemoir] = useState(false);
  const [memoirProgress, setMemoirProgress] = useState(0);

  const isLoading = itineraryLoading || diaryLoading;

  // Load data on mount
  useEffect(() => {
    if (tripId) {
      loadItinerary(tripId);
      loadFragments(tripId);
      loadTrip(tripId);
    }
  }, [tripId, loadItinerary, loadFragments, loadTrip]);

  // Check if trip is already saved
  useEffect(() => {
    if (currentTrip) {
      setIsSaved(currentTrip.isSavedToShelf);
    }
  }, [currentTrip]);

  // Group nodes by day
  const nodesByDay = (itinerary?.nodes || []).reduce((acc: Record<number, TravelNode[]>, node: TravelNode) => {
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
      dayNodes.sort((a: TravelNode, b: TravelNode) => a.order - b.order);
    }
  });

  const totalDays = itinerary?.totalDays || Math.max(...Object.keys(nodesByDay).map(Number), 1) || 1;

  // 计算实际日期
  const getActualDate = useCallback((dayIndex: number): string | null => {
    if (!itinerary?.startDate) return null;
    const start = new Date(itinerary.startDate);
    start.setDate(start.getDate() + dayIndex - 1);
    const month = start.getMonth() + 1;
    const day = start.getDate();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = weekdays[start.getDay()];
    return `${month}月${day}日 周${weekday}`;
  }, [itinerary?.startDate]);

  // Check if a node is lit (has a diary fragment)
  const isNodeLit = useCallback((nodeId: string): boolean => {
    return Array.isArray(diaryFragments) && diaryFragments.some((f: DiaryFragmentType) => f.nodeId === nodeId);
  }, [diaryFragments]);

  // Get fragment for a node
  const getNodeFragment = useCallback((nodeId: string): DiaryFragmentType | undefined => {
    return Array.isArray(diaryFragments) ? diaryFragments.find((f: DiaryFragmentType) => f.nodeId === nodeId) : undefined;
  }, [diaryFragments]);

  // Auto-select first node when day changes
  useEffect(() => {
    const dayNodes = nodesByDay[selectedDay] || [];
    const activeNodes = dayNodes.filter((n: TravelNode) => n.nodeStatus !== 'changed_original');
    if (activeNodes.length > 0 && !selectedNodeId) {
      setSelectedNodeId(activeNodes[0].id);
    }
  }, [selectedDay, nodesByDay, selectedNodeId]);

  // Get current selected node
  const currentNode = selectedNodeId 
    ? (itinerary?.nodes || []).find((n: TravelNode) => n.id === selectedNodeId)
    : null;

  // Handle fragment edit
  const handleFragmentEdit = useCallback(async (fragmentId: string, content: string, moodEmoji?: string) => {
    setEditingFragmentId(fragmentId);
    await updateFragment(fragmentId, content, moodEmoji);
    setEditingFragmentId(null);
  }, [updateFragment]);

  // Handle photo upload
  const handlePhotoUpload = useCallback(async (nodeId: string, file: File, time: string) => {
    if (!tripId) return;
    
    const photo = await uploadPhoto(tripId, nodeId, file);
    if (photo) {
      const photoWithTime = { ...photo, time };
      setNodeMaterials((prev) => ({
        ...prev,
        [nodeId]: {
          ...prev[nodeId],
          photos: [...(prev[nodeId]?.photos || []), photoWithTime],
          textNotes: prev[nodeId]?.textNotes || [],
        },
      }));
    }
  }, [tripId, uploadPhoto]);

  // Handle text note
  const handleTextNote = useCallback((nodeId: string, note: TimedNote) => {
    setNodeMaterials((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        photos: prev[nodeId]?.photos || [],
        textNotes: [...(prev[nodeId]?.textNotes || []), note],
      },
    }));
  }, []);

  // Handle photo delete
  const handlePhotoDelete = useCallback((nodeId: string, photoId: string) => {
    setNodeMaterials((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        photos: (prev[nodeId]?.photos || []).filter((p: PhotoMaterial) => p.id !== photoId),
        textNotes: prev[nodeId]?.textNotes || [],
      },
    }));
  }, []);

  // Handle text note delete
  const handleTextNoteDelete = useCallback((nodeId: string, index: number) => {
    setNodeMaterials((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        photos: prev[nodeId]?.photos || [],
        textNotes: (prev[nodeId]?.textNotes || []).filter((_: TimedNote, i: number) => i !== index),
      },
    }));
  }, []);

  // Handle mood select
  const handleMoodSelect = useCallback((nodeId: string, emoji: string) => {
    setNodeMaterials((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        photos: prev[nodeId]?.photos || [],
        textNotes: prev[nodeId]?.textNotes || [],
        selectedMood: emoji,
      },
    }));
  }, []);

  // Handle weather select
  const handleWeatherSelect = useCallback((nodeId: string, weather: string) => {
    setNodeMaterials((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        photos: prev[nodeId]?.photos || [],
        textNotes: prev[nodeId]?.textNotes || [],
        selectedWeather: weather,
      },
    }));
  }, []);

  // Handle light node
  const handleLightNode = useCallback(async (nodeId: string) => {
    if (!tripId) return;
    
    setLightingNodeId(nodeId);
    const materials = nodeMaterials[nodeId];
    const textNotes = materials?.textNotes || [];
    const weather = materials?.selectedWeather;
    const mood = materials?.selectedMood;
    
    const formattedNotes = textNotes.map((note: TimedNote) => note.content);
    
    const fragment = await lightNode(tripId, nodeId, formattedNotes, weather, undefined, mood);
    setLightingNodeId(null);
    
    if (fragment) {
      // 点亮成功后清空所有素材
      setNodeMaterials((prev) => ({
        ...prev,
        [nodeId]: {
          photos: [],
          textNotes: [], // 清空文字记录
          selectedMood: prev[nodeId]?.selectedMood,
          selectedWeather: prev[nodeId]?.selectedWeather,
        },
      }));
    }
  }, [tripId, lightNode, nodeMaterials]);

  // Handle regenerate node
  const handleRegenerateNode = useCallback(async (nodeId: string) => {
    if (!tripId) return;
    
    setLightingNodeId(nodeId);
    const materials = nodeMaterials[nodeId];
    const textNotes = materials?.textNotes || [];
    
    const formattedNotes = textNotes.map((note: TimedNote) => note.content);
    
    const fragment = await regenerateNode(tripId, nodeId, formattedNotes);
    setLightingNodeId(null);
    
    if (fragment) {
      // 重新生成后清空素材
      setNodeMaterials((prev) => ({
        ...prev,
        [nodeId]: {
          photos: [],
          textNotes: [], // 清空文字记录
          selectedMood: prev[nodeId]?.selectedMood,
          selectedWeather: prev[nodeId]?.selectedWeather,
        },
      }));
    }
  }, [tripId, regenerateNode, nodeMaterials]);

  // Handle change itinerary
  const handleChangeItinerary = useCallback(async (nodeId: string, newDestination: string, changeReason: string) => {
    if (!tripId) return;
    
    setLightingNodeId(nodeId);
    const result = await changeItinerary(tripId, nodeId, newDestination, changeReason);
    setLightingNodeId(null);
    
    if (result) {
      loadItinerary(tripId);
      loadFragments(tripId);
    }
  }, [tripId, changeItinerary, loadItinerary, loadFragments]);

  // Handle mark unrealized
  const handleMarkUnrealized = useCallback(async (nodeId: string, reason: string, moodEmoji?: string, weather?: string) => {
    if (!tripId) return;
    
    setLightingNodeId(nodeId);
    const result = await markUnrealized(tripId, nodeId, reason, moodEmoji, weather);
    setLightingNodeId(null);
    
    if (result) {
      loadItinerary(tripId);
    }
  }, [tripId, markUnrealized, loadItinerary]);

  // Handle light changed node
  const handleLightChangedNode = useCallback(async (nodeId: string) => {
    if (!tripId) return;
    
    setLightingNodeId(nodeId);
    const materials = nodeMaterials[nodeId];
    const textNotes = materials?.textNotes || [];
    const weather = materials?.selectedWeather;
    const mood = materials?.selectedMood;
    
    const formattedNotes = textNotes.map((note: TimedNote) => note.content);
    
    const fragment = await lightChangedNode(tripId, nodeId, formattedNotes, weather, undefined, mood);
    setLightingNodeId(null);
    
    if (fragment) {
      setNodeMaterials((prev) => ({
        ...prev,
        [nodeId]: {
          photos: [],
          textNotes: [],
          selectedMood: undefined,
          selectedWeather: undefined,
        },
      }));
    }
  }, [tripId, lightChangedNode, nodeMaterials]);

  // Handle complete trip
  const handleCompleteTrip = useCallback(async () => {
    if (!tripId) return;
    
    // 开始生成回忆录，显示加载动画
    setIsGeneratingMemoir(true);
    setMemoirProgress(0);
    
    // 模拟进度更新（实际进度由后端控制，这里用动画效果）
    const progressInterval = setInterval(() => {
      setMemoirProgress(prev => {
        // 进度在90%之前缓慢增加，等待实际完成
        if (prev < 90) {
          return prev + Math.random() * 8;
        }
        return prev;
      });
    }, 500);
    
    try {
      const memoir = await completeTrip(tripId);
      
      // 清除进度定时器
      clearInterval(progressInterval);
      
      if (memoir) {
        // 完成进度到100%
        setMemoirProgress(100);
        
        // 短暂延迟后跳转，让用户看到完成状态
        setTimeout(() => {
          setIsGeneratingMemoir(false);
          navigate(`/memoir/${tripId}`);
        }, 800);
      } else {
        setIsGeneratingMemoir(false);
      }
    } catch (error) {
      clearInterval(progressInterval);
      setIsGeneratingMemoir(false);
      console.error('Failed to complete trip:', error);
    }
  }, [tripId, completeTrip, navigate]);

  // Handle save to shelf
  const handleSaveToShelf = useCallback(async () => {
    if (!tripId || isSaved) return;
    
    setIsSaving(true);
    try {
      await tripApi.saveToShelf(tripId);
      setIsSaved(true);
    } catch (error) {
      console.error('Failed to save to shelf:', error);
    } finally {
      setIsSaving(false);
    }
  }, [tripId, isSaved]);

  // Calculate progress
  const fragmentsArray = Array.isArray(diaryFragments) ? diaryFragments : [];
  const activeNodes = (itinerary?.nodes || []).filter((n: TravelNode) => n.nodeStatus !== 'changed_original');
  const litNodesCount = fragmentsArray.length;
  const totalNodesCount = activeNodes.length;
  const progressPercent = totalNodesCount > 0 
    ? Math.round((litNodesCount / totalNodesCount) * 100) 
    : 0;

  // Loading state
  if (isLoading && !itinerary) {
    return (
      <div className="traveling-page">
        <div className="traveling-page__loading">
          <Loading size="lg" />
          <p className="traveling-page__loading-text">加载行程中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="traveling-page">
      {/* 生成回忆录的全屏加载动画 */}
      {isGeneratingMemoir && (
        <div className="traveling-page__memoir-loading">
          <div className="traveling-page__memoir-loading-content">
            <div className="traveling-page__memoir-loading-icon">
              <span className="traveling-page__memoir-book">📖</span>
              <span className="traveling-page__memoir-sparkle">✨</span>
            </div>
            <h2 className="traveling-page__memoir-loading-title">正在生成旅行回忆录</h2>
            <p className="traveling-page__memoir-loading-subtitle">
              AI正在为你编织这段旅程的美好记忆...
            </p>
            <div className="traveling-page__memoir-progress">
              <div 
                className="traveling-page__memoir-progress-bar"
                style={{ width: `${Math.min(memoirProgress, 100)}%` }}
              />
            </div>
            <div className="traveling-page__memoir-loading-steps">
              <span className={memoirProgress > 10 ? 'active' : ''}>📝 整理日记片段</span>
              <span className={memoirProgress > 40 ? 'active' : ''}>🎨 生成封面</span>
              <span className={memoirProgress > 70 ? 'active' : ''}>✍️ 撰写开篇与结语</span>
              <span className={memoirProgress >= 100 ? 'active' : ''}>🎉 完成</span>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="traveling-page__header">
        <div className="traveling-page__header-left">
          <div className="traveling-page__nav-links">
            <Link to="/history" className="traveling-page__back-link">
              📚 我的迹录
            </Link>
            <span className="traveling-page__nav-divider">|</span>
            <Link to={`/planning/${tripId}`} className="traveling-page__back-link">
              ← 返回规划
            </Link>
          </div>
          <h1 className="traveling-page__title">
            🎒 {itinerary?.destination || currentTrip?.destination || ''}之旅
          </h1>
        </div>
        <div className="traveling-page__header-right">
          <div className="traveling-page__progress">
            <span className="traveling-page__progress-text">
              已点亮 {litNodesCount}/{totalNodesCount} 个节点
            </span>
            <div className="traveling-page__progress-bar">
              <div
                className="traveling-page__progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
          {!isSaved ? (
            <Button
              variant="secondary"
              onClick={handleSaveToShelf}
              disabled={isSaving}
              className="traveling-page__save-btn"
            >
              {isSaving ? '保存中...' : '📚 保存迹录'}
            </Button>
          ) : (
            <span className="traveling-page__saved-badge">✓ 已保存到书架</span>
          )}
          <Button
            variant="primary"
            onClick={handleCompleteTrip}
            disabled={isLoading || litNodesCount < totalNodesCount || !isSaved}
            title={!isSaved ? '请先保存迹录到书架' : litNodesCount < totalNodesCount ? `还有 ${totalNodesCount - litNodesCount} 个节点未点亮` : ''}
          >
            完成旅程 →
          </Button>
        </div>
      </header>

      {/* Main Content - Split Layout */}
      <div className="traveling-page__content">
        {/* Left Panel - Timeline (30%) */}
        <aside className="traveling-page__timeline">
          {/* Day Header with Navigation */}
          <header className="traveling-page__day-header">
            <button 
              className="traveling-page__day-nav traveling-page__day-nav--prev"
              onClick={() => {
                if (selectedDay > 1) {
                  setSelectedDay(selectedDay - 1);
                  setSelectedNodeId(null);
                }
              }}
              disabled={selectedDay <= 1}
              aria-label="上一天"
            >
              ‹
            </button>
            <div className="traveling-page__day-info">
              <span className="traveling-page__day-label">Day {selectedDay}</span>
              <span className="traveling-page__day-date">{getActualDate(selectedDay) || ''}</span>
              <span className="traveling-page__day-progress">
                {(() => {
                  const dayNodes = nodesByDay[selectedDay] || [];
                  const activeDayNodes = dayNodes.filter((n: TravelNode) => n.nodeStatus !== 'changed_original');
                  const dayLitCount = activeDayNodes.filter((n: TravelNode) => isNodeLit(n.id)).length;
                  return `${dayLitCount}/${activeDayNodes.length} 已点亮`;
                })()}
              </span>
            </div>
            <button 
              className="traveling-page__day-nav traveling-page__day-nav--next"
              onClick={() => {
                if (selectedDay < totalDays) {
                  setSelectedDay(selectedDay + 1);
                  setSelectedNodeId(null);
                }
              }}
              disabled={selectedDay >= totalDays}
              aria-label="下一天"
            >
              ›
            </button>
          </header>

          {/* Node Card List */}
          <div className="traveling-page__node-list">
            {(nodesByDay[selectedDay] || []).map((node: TravelNode) => {
              const isLit = isNodeLit(node.id);
              const isActive = selectedNodeId === node.id;
              const isDisabled = node.nodeStatus === 'changed_original';

              return (
                <button
                  key={node.id}
                  className={`traveling-page__node-card ${isActive ? 'traveling-page__node-card--active' : ''} ${isLit ? 'traveling-page__node-card--lit' : ''} ${!isLit && !isDisabled ? 'traveling-page__node-card--pending' : ''} ${isDisabled ? 'traveling-page__node-card--disabled' : ''}`}
                  onClick={() => {
                    if (!isDisabled) {
                      setSelectedNodeId(node.id);
                      setActiveTab('diary'); // 切换节点时重置为日记页
                    }
                  }}
                  disabled={isDisabled}
                >
                  {/* Active Indicator Bar */}
                  <div className="traveling-page__node-indicator" />
                  
                  {/* Card Content */}
                  <div className="traveling-page__node-content">
                    <div className="traveling-page__node-header">
                      <span className="traveling-page__node-time-badge">{node.scheduledTime}</span>
                      {node.nodeStatus === 'changed' && (
                        <span className="traveling-page__node-status-tag traveling-page__node-status-tag--changed">变更</span>
                      )}
                      {node.nodeStatus === 'unrealized' && (
                        <span className="traveling-page__node-status-tag traveling-page__node-status-tag--unrealized">未实现</span>
                      )}
                    </div>
                    <div className="traveling-page__node-main">
                      <span className="traveling-page__node-icon">
                        {NODE_TYPE_ICONS[node.type] || '📍'}
                      </span>
                      <div className="traveling-page__node-info">
                        <h4 className="traveling-page__node-name">{node.name}</h4>
                        {node.description && (
                          <p className="traveling-page__node-desc">{node.description}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Visited Stamp for Lit Nodes */}
                  {isLit && (
                    <div className="traveling-page__node-stamp">
                      <span className="traveling-page__node-stamp-text">到此一游</span>
                    </div>
                  )}
                </button>
              );
            })}

            {(nodesByDay[selectedDay] || []).length === 0 && (
              <div className="traveling-page__empty traveling-page__empty--timeline">
                <div className="traveling-page__empty-icon">📍</div>
                <p className="traveling-page__empty-text">这一天暂无行程</p>
              </div>
            )}
          </div>
        </aside>

        {/* Right Panel - Canvas (70%) */}
        <main className="traveling-page__canvas">
          {currentNode ? (
            <>
              {/* Canvas Header */}
              <div className="traveling-page__canvas-header">
                <div className="traveling-page__canvas-title">
                  <span className="traveling-page__canvas-icon">
                    {NODE_TYPE_ICONS[currentNode.type] || '📍'}
                  </span>
                  <div className="traveling-page__canvas-info">
                    <h2>{currentNode.name}</h2>
                    <span className="traveling-page__canvas-meta">
                      {currentNode.scheduledTime} · 第 {selectedDay} 天
                    </span>
                  </div>
                </div>
              </div>

              {/* Canvas Content */}
              <div className="traveling-page__canvas-content">
                <div className="traveling-page__canvas-inner">
                  {/* 正在生成日记时：显示加载动画 */}
                  {lightingNodeId === currentNode.id && (
                    <div className="traveling-page__generating">
                      <div className="traveling-page__generating-content">
                        <div className="traveling-page__generating-icon">✨</div>
                        <h3 className="traveling-page__generating-title">正在生成旅行日记...</h3>
                        <p className="traveling-page__generating-hint">AI正在为你记录这一刻的美好</p>
                        <div className="traveling-page__generating-dots">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 未点亮且未在生成时：显示NodeRecorder编辑界面 */}
                  {!isNodeLit(currentNode.id) && lightingNodeId !== currentNode.id && (
                    <NodeRecorder
                      node={currentNode}
                      photos={nodeMaterials[currentNode.id]?.photos || []}
                      textNotes={nodeMaterials[currentNode.id]?.textNotes || []}
                      selectedMood={nodeMaterials[currentNode.id]?.selectedMood}
                      selectedWeather={nodeMaterials[currentNode.id]?.selectedWeather}
                      onPhotoUpload={(file, time) => handlePhotoUpload(currentNode.id, file, time)}
                      onPhotoDelete={(photoId) => handlePhotoDelete(currentNode.id, photoId)}
                      onTextNote={(note) => handleTextNote(currentNode.id, note)}
                      onTextNoteDelete={(index) => handleTextNoteDelete(currentNode.id, index)}
                      onMoodSelect={(emoji) => handleMoodSelect(currentNode.id, emoji)}
                      onWeatherSelect={(weather) => handleWeatherSelect(currentNode.id, weather)}
                      onLight={() => currentNode.nodeStatus === 'changed' ? handleLightChangedNode(currentNode.id) : handleLightNode(currentNode.id)}
                      onRegenerate={() => handleRegenerateNode(currentNode.id)}
                      onChangeItinerary={(newDest, reason) => handleChangeItinerary(currentNode.id, newDest, reason)}
                      onMarkUnrealized={(reason, mood, weather) => handleMarkUnrealized(currentNode.id, reason, mood, weather)}
                      isLit={false}
                      isLoading={false}
                      destination={itinerary?.destination || currentTrip?.destination || ''}
                    />
                  )}

                  {/* 已点亮时：分页切换 */}
                  {isNodeLit(currentNode.id) && getNodeFragment(currentNode.id) && (
                    <>
                      {/* 分页Tab */}
                      <div className="traveling-page__tabs">
                        <button 
                          className={`traveling-page__tab ${activeTab === 'diary' ? 'traveling-page__tab--active' : ''}`}
                          onClick={() => setActiveTab('diary')}
                        >
                          📖 日记
                        </button>
                        <button 
                          className={`traveling-page__tab ${activeTab === 'edit' ? 'traveling-page__tab--active' : ''}`}
                          onClick={() => setActiveTab('edit')}
                        >
                          ✏️ 添加更多
                        </button>
                      </div>

                      {/* 日记展示页 */}
                      {activeTab === 'diary' && (() => {
                        const fragment = getNodeFragment(currentNode.id)!;
                        return (
                          <div className="traveling-page__tab-content">
                            <DiaryFragmentComponent
                              key={`${currentNode.id}-${fragment.id}`}
                              fragment={{
                                ...fragment,
                                nodeName: currentNode.name,
                                photos: fragment.photos || [],
                                weather: nodeMaterials[currentNode.id]?.selectedWeather || fragment.weather,
                                textNotes: fragment.textNotes || [],
                              }}
                              onEdit={(content, moodEmoji) => handleFragmentEdit(fragment.id, content, moodEmoji)}
                              isLoading={editingFragmentId === fragment.id}
                              destination={itinerary?.destination || currentTrip?.destination || ''}
                              tripId={tripId || ''}
                            />
                          </div>
                        );
                      })()}

                      {/* 编辑内容页 */}
                      {activeTab === 'edit' && (
                        <div className="traveling-page__tab-content">
                          <NodeRecorder
                            node={currentNode}
                            photos={nodeMaterials[currentNode.id]?.photos || []}
                            textNotes={nodeMaterials[currentNode.id]?.textNotes || []}
                            selectedMood={nodeMaterials[currentNode.id]?.selectedMood}
                            selectedWeather={nodeMaterials[currentNode.id]?.selectedWeather}
                            onPhotoUpload={(file, time) => handlePhotoUpload(currentNode.id, file, time)}
                            onPhotoDelete={(photoId) => handlePhotoDelete(currentNode.id, photoId)}
                            onTextNote={(note) => handleTextNote(currentNode.id, note)}
                            onTextNoteDelete={(index) => handleTextNoteDelete(currentNode.id, index)}
                            onMoodSelect={(emoji) => handleMoodSelect(currentNode.id, emoji)}
                            onWeatherSelect={(weather) => handleWeatherSelect(currentNode.id, weather)}
                            onLight={() => {}}
                            onRegenerate={() => handleRegenerateNode(currentNode.id)}
                            onChangeItinerary={(newDest, reason) => handleChangeItinerary(currentNode.id, newDest, reason)}
                            onMarkUnrealized={(reason, mood, weather) => handleMarkUnrealized(currentNode.id, reason, mood, weather)}
                            isLit={true}
                            isLoading={lightingNodeId === currentNode.id}
                            destination={itinerary?.destination || currentTrip?.destination || ''}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="traveling-page__empty traveling-page__empty--canvas">
              <div className="traveling-page__empty-icon">🎒</div>
              <p className="traveling-page__empty-text">选择左侧节点开始记录</p>
              <p className="traveling-page__empty-hint">点击行程节点，开始你的旅行日记</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default TravelingPage;
