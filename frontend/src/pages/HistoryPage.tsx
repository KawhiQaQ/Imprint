import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Loading } from '../components';
import { tripApi, memoirApi } from '../api';
import type { Trip, TripStatus } from '../types';
import './HistoryPage.css';

type FilterStatus = 'all' | TripStatus;

interface FilterOption {
  value: FilterStatus;
  label: string;
}

const filterOptions: FilterOption[] = [
  { value: 'all', label: '全部' },
  { value: 'traveling', label: '撰写中' },
  { value: 'completed', label: '已珍藏' },
];

const HistoryPage: React.FC = () => {
  const navigate = useNavigate();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterStatus>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  
  // 批量选择状态
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);

  // 水平滚动
  const bookshelfRef = useRef<HTMLDivElement>(null);
  
  // 封面图缓存 (tripId -> coverImageUrl)
  const [coverImages, setCoverImages] = useState<Record<string, string>>({});

  const userId = 'default-user';

  // 获取已完成行程的回忆录封面
  const fetchCoverImages = useCallback(async (completedTrips: Trip[]) => {
    if (completedTrips.length === 0) return;
    
    const coverPromises = completedTrips.map(async (trip: Trip) => {
      try {
        const memoirResponse = await memoirApi.get(trip.id);
        // 后端返回格式: { success: true, memoir: { coverImageUrl: '...' } }
        const data = memoirResponse.data as unknown as { success: boolean; memoir: { coverImageUrl?: string } };
        const memoir = data?.memoir;
        if (memoir?.coverImageUrl) {
          return { tripId: trip.id, coverUrl: memoir.coverImageUrl };
        }
      } catch {
        // 回忆录可能还未生成，忽略错误
      }
      return null;
    });
    
    const covers = await Promise.all(coverPromises);
    const coverMap: Record<string, string> = {};
    covers.forEach(cover => {
      if (cover) {
        coverMap[cover.tripId] = cover.coverUrl;
      }
    });
    setCoverImages(coverMap);
  }, []);

  const fetchTrips = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await tripApi.getUserTrips(userId);
      // 只显示已保存到书架的迹录
      const savedTrips = response.data.filter((trip: Trip) => trip.isSavedToShelf);
      setTrips(savedTrips);
      
      // 异步获取封面图，不阻塞主列表显示
      const completedTrips = savedTrips.filter((trip: Trip) => trip.status === 'completed');
      fetchCoverImages(completedTrips);
    } catch (err) {
      console.error('Failed to fetch trips:', err);
      setError('无法加载旅程列表，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  }, [userId, fetchCoverImages]);

  useEffect(() => {
    fetchTrips();
  }, [fetchTrips]);

  // 水平滚动 - 鼠标滚轮转为水平方向（优化版）
  useEffect(() => {
    const bookshelf = bookshelfRef.current;
    if (!bookshelf) return;

    let targetScrollLeft = bookshelf.scrollLeft;
    let animationId: number | null = null;

    const smoothScroll = () => {
      const diff = targetScrollLeft - bookshelf.scrollLeft;
      if (Math.abs(diff) < 0.5) {
        bookshelf.scrollLeft = targetScrollLeft;
        animationId = null;
        return;
      }
      // 平滑插值
      bookshelf.scrollLeft += diff * 0.15;
      animationId = requestAnimationFrame(smoothScroll);
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      // 累加目标位置
      targetScrollLeft += e.deltaY;
      // 限制范围
      const maxScroll = bookshelf.scrollWidth - bookshelf.clientWidth;
      targetScrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScroll));
      
      // 启动动画
      if (!animationId) {
        animationId = requestAnimationFrame(smoothScroll);
      }
    };

    bookshelf.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      bookshelf.removeEventListener('wheel', handleWheel);
      if (animationId) cancelAnimationFrame(animationId);
    };
  }, [trips]);

  // 只显示 traveling 和 completed 状态（已保存的迹录不会是 planning 状态）
  const filteredTrips = useMemo(() => {
    if (activeFilter === 'all') {
      return trips;
    }
    return trips.filter((trip) => trip.status === activeFilter);
  }, [trips, activeFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<FilterStatus, number> = {
      all: trips.length,
      planning: 0,
      traveling: 0,
      completed: 0,
    };
    trips.forEach((trip) => {
      counts[trip.status]++;
    });
    return counts;
  }, [trips]);

  const handleContinue = useCallback((trip: Trip) => {
    if (isSelectMode) return;
    switch (trip.status) {
      case 'planning':
        navigate(`/planning/${trip.id}`);
        break;
      case 'traveling':
        navigate(`/traveling/${trip.id}`);
        break;
      case 'completed':
        navigate(`/memoir/${trip.id}`);
        break;
    }
  }, [navigate, isSelectMode]);

  const handleDelete = useCallback(async (tripId: string) => {
    if (!tripId) {
      console.error('tripId is empty or undefined!');
      return;
    }
    setDeletingId(tripId);
    try {
      await tripApi.deleteTrip(tripId);
      setTrips((prev) => prev.filter((t) => t.id !== tripId));
      setConfirmDeleteId(null);
    } catch (err) {
      console.error('Failed to delete trip:', err);
      setError('删除失败，请稍后重试');
    } finally {
      setDeletingId(null);
    }
  }, []);

  // 批量删除
  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    
    setIsBatchDeleting(true);
    try {
      await tripApi.deleteTrips(Array.from(selectedIds));
      setTrips((prev) => prev.filter((t) => !selectedIds.has(t.id)));
      setSelectedIds(new Set());
      setIsSelectMode(false);
      setShowBatchDeleteConfirm(false);
    } catch (err) {
      console.error('Failed to batch delete:', err);
      setError('批量删除失败，请稍后重试');
    } finally {
      setIsBatchDeleting(false);
    }
  }, [selectedIds]);

  // 切换选择
  const toggleSelect = useCallback((tripId: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(tripId)) {
        newSet.delete(tripId);
      } else {
        newSet.add(tripId);
      }
      return newSet;
    });
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredTrips.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredTrips.map((t) => t.id)));
    }
  }, [filteredTrips, selectedIds.size]);

  // 退出选择模式
  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const formatDate = (date: Date): string => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}.${month}.${day}`;
  };

  if (isLoading) {
    return (
      <div className="history-page">
        <div className="history-loading">
          <Loading size="lg" text="加载迹录中..." />
        </div>
      </div>
    );
  }

  return (
    <div className="history-page">
      {/* Control Deck - 左上角控制区 */}
      <div className="history-control-deck">
        <div className="history-control-left">
          <Link to="/" className="history-back-link">
            ← 返回首页
          </Link>
          <div className="history-title-wrapper">
            <h1 className="history-title">我的迹录书架</h1>
            <span className="history-stamp">藏</span>
          </div>
          {/* 筛选器 - 文字标签 */}
          <div className="history-filters">
            {filterOptions.map((option) => (
              <button
                key={option.value}
                className={`filter-label ${activeFilter === option.value ? 'active' : ''}`}
                onClick={() => setActiveFilter(option.value)}
              >
                {option.label}
                <span className="filter-count">{statusCounts[option.value]}</span>
              </button>
            ))}
          </div>
        </div>
        
        {/* 右上角极简图标 */}
        <div className="history-control-right">
          {isSelectMode ? (
            <div className="history-select-bar">
              <span className="select-bar-text">已选 {selectedIds.size} 项</span>
              <button className="select-bar-btn" onClick={toggleSelectAll}>
                {selectedIds.size === filteredTrips.length ? '取消全选' : '全选'}
              </button>
              <button 
                className="select-bar-btn danger" 
                onClick={() => setShowBatchDeleteConfirm(true)}
                disabled={selectedIds.size === 0}
              >
                删除
              </button>
              <button className="select-bar-btn" onClick={exitSelectMode}>
                完成
              </button>
            </div>
          ) : (
            <>
              {trips.length > 0 && (
                <button 
                  className="control-icon-btn"
                  data-tooltip="批量管理"
                  onClick={() => setIsSelectMode(true)}
                >
                  ☑️
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="history-error-toast">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="history-content">
        {filteredTrips.length === 0 ? (
          <div className="bookshelf">
            <div className="bookshelf-row bookshelf-row--empty" ref={bookshelfRef}>
              {/* 空状态也显示空白书 */}
              <NewBook onClick={() => navigate('/')} />
            </div>
            <div className="bookshelf-wood"></div>
            <div className="history-empty-hint">
              {activeFilter === 'all'
                ? '点击空白书，开启你的第一段旅程'
                : `没有${filterOptions.find((o) => o.value === activeFilter)?.label}的迹录`}
            </div>
          </div>
        ) : (
          <div className="bookshelf">
            <div className="bookshelf-row" ref={bookshelfRef}>
              {/* 新建入口 - 空白书放在最左侧 */}
              {!isSelectMode && <NewBook onClick={() => navigate('/')} />}
              {filteredTrips.map((trip) => (
                <DiaryBook
                  key={trip.id}
                  trip={trip}
                  coverImageUrl={coverImages[trip.id]}
                  onOpen={() => handleContinue(trip)}
                  onDelete={() => setConfirmDeleteId(trip.id)}
                  onSelect={() => toggleSelect(trip.id)}
                  formatDate={formatDate}
                  isDeleting={deletingId === trip.id}
                  isSelectMode={isSelectMode}
                  isSelected={selectedIds.has(trip.id)}
                />
              ))}
            </div>
            <div className="bookshelf-wood"></div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {confirmDeleteId && (
        <DeleteConfirmModal
          tripId={confirmDeleteId}
          isDeleting={deletingId === confirmDeleteId}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={handleDelete}
        />
      )}

      {/* Batch Delete Confirmation Modal */}
      {showBatchDeleteConfirm && (
        <div className="delete-modal-overlay" onClick={() => setShowBatchDeleteConfirm(false)}>
          <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="delete-modal-icon">🗑️</div>
            <h3 className="delete-modal-title">批量删除</h3>
            <p className="delete-modal-text">
              确定要删除选中的 {selectedIds.size} 本迹录吗？删除后将无法恢复。
            </p>
            <div className="delete-modal-actions">
              <Button
                variant="secondary"
                onClick={() => setShowBatchDeleteConfirm(false)}
                disabled={isBatchDeleting}
              >
                取消
              </Button>
              <Button
                variant="primary"
                onClick={handleBatchDelete}
                disabled={isBatchDeleting}
                className="delete-confirm-btn"
              >
                {isBatchDeleting ? '删除中...' : '确认删除'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface DeleteConfirmModalProps {
  tripId: string;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: (tripId: string) => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  tripId,
  isDeleting,
  onCancel,
  onConfirm,
}) => {
  const handleConfirmClick = () => {
    onConfirm(tripId);
  };

  return (
    <div className="delete-modal-overlay" onClick={onCancel}>
      <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="delete-modal-icon">🗑️</div>
        <h3 className="delete-modal-title">确认删除</h3>
        <p className="delete-modal-text">
          删除后将无法恢复这本迹录日记，确定要删除吗？
        </p>
        <div className="delete-modal-actions">
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={isDeleting}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirmClick}
            disabled={isDeleting}
            className="delete-confirm-btn"
          >
            {isDeleting ? '删除中...' : '确认删除'}
          </Button>
        </div>
      </div>
    </div>
  );
};

interface DiaryBookProps {
  trip: Trip;
  coverImageUrl?: string; // AI 生成的回忆录封面
  onOpen: () => void;
  onDelete: () => void;
  onSelect: () => void;
  formatDate: (date: Date) => string;
  isDeleting: boolean;
  isSelectMode: boolean;
  isSelected: boolean;
}

const DiaryBook: React.FC<DiaryBookProps> = ({
  trip,
  coverImageUrl,
  onOpen,
  onDelete,
  onSelect,
  formatDate,
  isDeleting,
  isSelectMode,
  isSelected,
}) => {
  // 默认封面图 - 旅行中的书本使用图库图片
  const getDefaultCover = (destination: string): string => {
    const covers = [
      // 山脉与雪景
      'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=400&h=600&fit=crop',
      // 森林与湖泊
      'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1439066615861-d1af74d74000?w=400&h=600&fit=crop',
      // 海滩与日落
      'https://images.unsplash.com/photo-1505144808419-1957a94ca61e?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1519046904884-53103b34b206?w=400&h=600&fit=crop',
      // 山间小路与瀑布
      'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=400&h=600&fit=crop',
      // 城市与建筑
      'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=400&h=600&fit=crop',
      // 田野与花海
      'https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=400&h=600&fit=crop',
      'https://images.unsplash.com/photo-1462275646964-a0e3571f4f83?w=400&h=600&fit=crop',
    ];
    // 使用字符串哈希选择图片
    let hash = 0;
    for (let i = 0; i < destination.length; i++) {
      hash = ((hash << 5) - hash) + destination.charCodeAt(i);
      hash = hash & hash;
    }
    const index = Math.abs(hash) % covers.length;
    return covers[index];
  };

  const handleClick = () => {
    if (isSelectMode) {
      onSelect();
    } else {
      onOpen();
    }
  };

  // 已完成的书使用 AI 生成的回忆录封面，旅行中的书使用图库图片
  const coverImage = coverImageUrl || getDefaultCover(trip.destination || trip.visionText);

  return (
    <div className={`diary-book ${trip.status} ${isSelected ? 'selected' : ''}`}>
      {isSelectMode && (
        <div className="book-checkbox" onClick={onSelect}>
          {isSelected ? '✓' : ''}
        </div>
      )}
      <div className="book-cover" onClick={handleClick}>
        {/* 封面图片 */}
        <img 
          src={coverImage} 
          alt={trip.destination || '旅行封面'} 
          className="book-cover-image"
        />
        {/* 书脊 - 包含日期 */}
        <div className="book-spine">
          <span className="book-spine-date">{formatDate(trip.createdAt)}</span>
        </div>
        
        {/* 日式签条 - 竖排标题 */}
        <div className="book-title-label">
          <h3>{trip.destination || '未定'}</h3>
          {/* 已完成状态 - 朱砂闲章在签条底部 */}
          {trip.status === 'completed' && (
            <div className="book-stamp-completed">藏</div>
          )}
        </div>
        
        {/* 腰封 (Obi) */}
        <div className="book-obi">
          {trip.status === 'traveling' ? (
            <span className="book-obi-status">撰写中</span>
          ) : (
            <span className="book-obi-title">旅行回忆</span>
          )}
        </div>
        

      </div>
      {!isSelectMode && (
        <div className="book-actions">
          <button 
            className="book-delete-btn" 
            onClick={onDelete}
            disabled={isDeleting}
            title="删除迹录"
          >
            🗑️
          </button>
        </div>
      )}
    </div>
  );
};

/* 新建入口 - 空白书 */
interface NewBookProps {
  onClick: () => void;
}

const NewBook: React.FC<NewBookProps> = ({ onClick }) => {
  return (
    <div className="new-book" onClick={onClick}>
      <div className="new-book-cover">
        {/* 羽毛笔线条插画 */}
        <div className="new-book-illustration">
          <svg viewBox="0 0 36 44" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* 羽毛笔主体 */}
            <path 
              d="M28 4C24 8 20 16 18 24C16 32 16 40 16 42" 
              stroke="#A08060" 
              strokeWidth="1.2" 
              strokeLinecap="round"
            />
            {/* 羽毛 */}
            <path 
              d="M28 4C30 6 32 4 34 2" 
              stroke="#A08060" 
              strokeWidth="1" 
              strokeLinecap="round"
            />
            <path 
              d="M28 4C26 2 28 0 30 0" 
              stroke="#A08060" 
              strokeWidth="1" 
              strokeLinecap="round"
            />
            <path 
              d="M26 8C28 7 30 8 31 6" 
              stroke="#A08060" 
              strokeWidth="0.8" 
              strokeLinecap="round"
            />
            <path 
              d="M24 12C26 10 28 11 29 9" 
              stroke="#A08060" 
              strokeWidth="0.8" 
              strokeLinecap="round"
            />
            {/* 笔尖 */}
            <path 
              d="M16 42L15 44L17 44L16 42Z" 
              stroke="#A08060" 
              strokeWidth="0.8" 
              fill="none"
            />
          </svg>
        </div>
        <span className="new-book-text">开启新篇章</span>
        <span className="new-book-hint">下一站</span>
      </div>
    </div>
  );
};

export default HistoryPage;
