import React, { useState, useCallback, useMemo } from 'react';
import type { Itinerary, TravelNode } from '../../types';
import './ItineraryBoard.css';

export interface ItineraryBoardProps {
  itinerary: Itinerary | null;
  onNodeUpdate: (nodeId: string, updates: Partial<TravelNode>) => void;
  onNodeReorder?: (nodeId: string, newOrder: number, newDay: number) => void;
  onNodeVerify?: (nodeId: string) => void;
  isLoading?: boolean;
}

interface EditingNode {
  id: string;
  field: 'name' | 'description' | 'scheduledTime';
  value: string;
}

// 节点类型配置 - 色彩编码体系
const NODE_TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  transport: { icon: '🚗', label: '交通', color: '#7C9CB5' },
  restaurant: { icon: '🍜', label: '餐饮', color: '#C67B5C' },
  attraction: { icon: '⛰️', label: '景点', color: '#5D7260' },
  hotel: { icon: '🏨', label: '住宿', color: '#9B8AA6' },
};

const ItineraryBoard: React.FC<ItineraryBoardProps> = ({
  itinerary,
  onNodeUpdate,
  onNodeReorder: _onNodeReorder,
  onNodeVerify: _onNodeVerify,
  isLoading = false,
}) => {
  const [editingNode, setEditingNode] = useState<EditingNode | null>(null);
  const [activeDay, setActiveDay] = useState<number>(1);
  // 折叠状态管理 —— 默认全部展开，记录被用户手动折叠的节点
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  // Group nodes by day
  const nodesByDay = useMemo(() => {
    return (itinerary?.nodes || []).reduce((acc, node) => {
      const day = node.dayIndex;
      if (!acc[day]) acc[day] = [];
      acc[day].push(node);
      return acc;
    }, {} as Record<number, TravelNode[]>);
  }, [itinerary?.nodes]);

  // Sort nodes within each day
  Object.keys(nodesByDay).forEach((day) => {
    nodesByDay[Number(day)]?.sort((a, b) => a.order - b.order);
  });

  // 计算总天数
  const totalDays = useMemo(() => {
    const maxDayFromNodes = Object.keys(nodesByDay).length > 0 
      ? Math.max(...Object.keys(nodesByDay).map(Number)) 
      : 0;
    return Math.max(itinerary?.totalDays || 0, maxDayFromNodes, 1);
  }, [itinerary?.totalDays, nodesByDay]);

  // 计算实际日期
  const getActualDate = useCallback((dayIndex: number): { date: string; weekday: string; full: string } | null => {
    if (!itinerary?.startDate) return null;
    const start = new Date(itinerary.startDate);
    start.setDate(start.getDate() + dayIndex - 1);
    const month = start.getMonth() + 1;
    const day = start.getDate();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = weekdays[start.getDay()];
    return {
      date: `${month}月${day}日`,
      weekday: `周${weekday}`,
      full: `${month}月${day}日 · ${itinerary.destination || ''}`
    };
  }, [itinerary?.startDate, itinerary?.destination]);

  // 格式化时长
  const formatDuration = (minutes: number): string => {
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h${mins}m` : `${hours}小时`;
  };

  // 切换卡片展开/折叠状态
  const toggleExpand = useCallback((nodeId: string, e: React.MouseEvent) => {
    // 阻止事件冒泡，避免触发编辑
    e.stopPropagation();
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId); // 展开
      } else {
        next.add(nodeId); // 折叠
      }
      return next;
    });
  }, []);

  // 编辑处理
  const handleEditStart = useCallback((node: TravelNode, field: 'name' | 'description' | 'scheduledTime', e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingNode({ id: node.id, field, value: node[field] });
  }, []);

  const handleEditChange = useCallback((value: string) => {
    if (editingNode) setEditingNode({ ...editingNode, value });
  }, [editingNode]);

  const handleEditSave = useCallback(() => {
    if (editingNode) {
      onNodeUpdate(editingNode.id, { [editingNode.field]: editingNode.value });
      setEditingNode(null);
    }
  }, [editingNode, onNodeUpdate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(); }
    else if (e.key === 'Escape') setEditingNode(null);
  }, [handleEditSave]);

  // 获取节点类型配置
  const getNodeConfig = (type: string) => NODE_TYPE_CONFIG[type] || NODE_TYPE_CONFIG.attraction;

  // 获取关键标签
  const getKeyTags = (node: TravelNode): string[] => {
    const tags: string[] = [];
    if (node.ticketInfo && node.ticketInfo !== '不适用' && node.ticketInfo.includes('必')) {
      tags.push(node.ticketInfo);
    }
    if (node.priceInfo && node.priceInfo !== '不适用') {
      tags.push(node.priceInfo);
    }
    return tags.slice(0, 2);
  };

  if (!itinerary) {
    return (
      <div className="itinerary-board itinerary-board--empty">
        <div className="itinerary-board__empty-state">
          <div className="itinerary-board__empty-icon">📋</div>
          <h3 className="itinerary-board__empty-title">暂无行程</h3>
          <p className="itinerary-board__empty-text">行程正在生成中，请稍候...</p>
        </div>
      </div>
    );
  }

  const currentDayNodes = nodesByDay[activeDay] || [];
  const currentDateInfo = getActualDate(activeDay);

  return (
    <div className="itinerary-board">
      {/* A. 顶部导航：时间轴 Day Tabs */}
      <div className="itinerary-board__nav">
        <div className="itinerary-board__day-tabs">
          {Array.from({ length: totalDays }, (_, i) => i + 1).map((dayIndex) => (
            <button
              key={dayIndex}
              className={`itinerary-board__day-tab ${activeDay === dayIndex ? 'itinerary-board__day-tab--active' : ''}`}
              onClick={() => setActiveDay(dayIndex)}
            >
              第{dayIndex}天
            </button>
          ))}
        </div>
        {currentDateInfo && (
          <div className="itinerary-board__day-summary">
            {currentDateInfo.full} · {currentDateInfo.weekday}
          </div>
        )}
      </div>

      {/* B. 核心内容区：踏脚石卡片 */}
      <div className="itinerary-board__content">
        {currentDayNodes.length === 0 ? (
          <div className="itinerary-board__empty-day">
            <span>暂无安排</span>
          </div>
        ) : (
          <div className="itinerary-board__stones">
            {currentDayNodes.map((node, nodeIndex) => {
              const config = getNodeConfig(node.type);
              const isExpanded = !collapsedNodes.has(node.id);
              const keyTags = getKeyTags(node);
              
              return (
                <React.Fragment key={node.id}>
                  <div className="itinerary-board__stone">
                    {/* 左列：时间锚点 */}
                    <div className="itinerary-board__stone-time">
                      <span className="itinerary-board__stone-time-main">
                        {node.scheduledTime?.split(':').slice(0, 2).join(':') || '--:--'}
                      </span>
                      {node.estimatedDuration > 0 && (
                        <span className="itinerary-board__stone-time-duration">
                          {formatDuration(node.estimatedDuration)}
                        </span>
                      )}
                    </div>

                    {/* 中列：时间线图标 */}
                    <div className="itinerary-board__stone-timeline">
                      <div 
                        className="itinerary-board__stone-dot"
                        style={{ backgroundColor: config.color }}
                      >
                        <span className="itinerary-board__stone-dot-icon">{config.icon}</span>
                      </div>
                    </div>

                    {/* 右列：事件卡片 */}
                  <div 
                    className={`itinerary-board__stone-card ${isExpanded ? 'itinerary-board__stone-card--expanded' : ''}`}
                    style={{ borderLeftColor: config.color }}
                    onClick={(e) => toggleExpand(node.id, e)}
                  >
                    {/* 收纳状态：核心信息 */}
                    <div className="itinerary-board__stone-summary">
                      <div className="itinerary-board__stone-main">
                        <span className="itinerary-board__stone-icon">{config.icon}</span>
                        <span className="itinerary-board__stone-name-text">
                          {node.isStartingPoint && node.scenicAreaName 
                            ? node.scenicAreaName 
                            : (node.activity || node.name)}
                        </span>
                        {keyTags.length > 0 && (
                          <span className="itinerary-board__stone-key-tag">
                            {keyTags[0]}
                          </span>
                        )}
                      </div>
                      <span className={`itinerary-board__stone-expand-icon ${isExpanded ? 'itinerary-board__stone-expand-icon--expanded' : ''}`}>
                        ▼
                      </span>
                    </div>

                    {/* 展开状态：详细信息 */}
                    <div className={`itinerary-board__stone-details ${isExpanded ? 'itinerary-board__stone-details--visible' : ''}`}>
                      {/* 类型标签 */}
                      <div className="itinerary-board__stone-header">
                        <span className="itinerary-board__stone-type" style={{ color: config.color }}>
                          {config.label}
                        </span>
                        {node.verified && (
                          <span className="itinerary-board__stone-verified">✓ 已验证</span>
                        )}
                      </div>

                      {/* 地点名称 - 可编辑 */}
                      {editingNode?.id === node.id && editingNode.field === 'name' ? (
                        <input
                          type="text"
                          className="itinerary-board__edit-input"
                          value={editingNode.value}
                          onChange={(e) => handleEditChange(e.target.value)}
                          onKeyDown={handleKeyDown}
                          onBlur={handleEditSave}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                        />
                      ) : (
                        <h4
                          className="itinerary-board__stone-name"
                          onClick={(e) => handleEditStart(node, 'name', e)}
                        >
                          {node.name}
                          {node.isStartingPoint && (
                            <span className="itinerary-board__stone-starting">（起点）</span>
                          )}
                        </h4>
                      )}

                      {/* 价格和门票标签 */}
                      <div className="itinerary-board__stone-tags">
                        {node.priceInfo && node.priceInfo !== '不适用' && (
                          <span className="itinerary-board__stone-tag itinerary-board__stone-tag--price">
                            💰 {node.priceInfo}
                          </span>
                        )}
                        {node.ticketInfo && node.ticketInfo !== '不适用' && (
                          <span className="itinerary-board__stone-tag itinerary-board__stone-tag--ticket">
                            🎫 {node.ticketInfo}
                          </span>
                        )}
                      </div>

                      {/* AI 推荐语 */}
                      {editingNode?.id === node.id && editingNode.field === 'description' ? (
                        <textarea
                          className="itinerary-board__edit-textarea"
                          value={editingNode.value}
                          onChange={(e) => handleEditChange(e.target.value)}
                          onKeyDown={handleKeyDown}
                          onBlur={handleEditSave}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                          rows={2}
                        />
                      ) : (
                        node.description && (
                          <p
                            className="itinerary-board__stone-desc"
                            onClick={(e) => handleEditStart(node, 'description', e)}
                          >
                            {node.description}
                          </p>
                        )
                      )}

                      {/* 小贴士 */}
                      {node.tips && (
                        <div className="itinerary-board__stone-tips">
                          💡 {node.tips}
                        </div>
                      )}

                      {/* 操作按钮 */}
                      <div className="itinerary-board__stone-actions">
                        <button 
                          className="itinerary-board__stone-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            const city = itinerary?.destination || '';
                            const keyword = node.address 
                              ? `${city}${node.address}` 
                              : `${city}${node.name}`;
                            const url = `https://uri.amap.com/search?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}`;
                            window.open(url, '_blank');
                          }}
                        >
                          📍 地图导航
                        </button>
                        <button 
                          className="itinerary-board__stone-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            const city = itinerary?.destination || '';
                            const searchQuery = `${city} ${node.name} 攻略`;
                            const url = `https://www.baidu.com/s?wd=${encodeURIComponent(searchQuery)}`;
                            window.open(url, '_blank');
                          }}
                        >
                          🔗 查看详情
                        </button>
                      </div>
                    </div>
                  </div>
                  </div>

                  {/* 连接线 - 纵向时间轴串联 */}
                  {nodeIndex < currentDayNodes.length - 1 && (() => {
                    const nextNode = currentDayNodes[nodeIndex + 1];
                    const nextConfig = getNodeConfig(nextNode.type);
                    return (
                      <div className="itinerary-board__connector">
                        <div className="itinerary-board__connector-time"></div>
                        <div className="itinerary-board__connector-line">
                          <div
                            className="itinerary-board__connector-stem"
                            style={{
                              background: `linear-gradient(to bottom, ${config.color}, ${nextConfig.color})`
                            }}
                          ></div>
                          <div
                            className="itinerary-board__connector-midpoint"
                            style={{
                              background: `linear-gradient(135deg, ${config.color}, ${nextConfig.color})`
                            }}
                          ></div>
                          <div
                            className="itinerary-board__connector-stem"
                            style={{
                              background: `linear-gradient(to bottom, ${config.color}, ${nextConfig.color})`
                            }}
                          ></div>
                        </div>
                        <div className="itinerary-board__connector-spacer"></div>
                      </div>
                    );
                  })()}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

      {/* 加载遮罩 */}
      {isLoading && (
        <div className="itinerary-board__loading">
          <div className="itinerary-board__loading-spinner"></div>
          <span>AI 正在重新计算时间...</span>
        </div>
      )}
    </div>
  );
};

export default ItineraryBoard;
