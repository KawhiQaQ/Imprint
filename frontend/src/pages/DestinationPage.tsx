import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { DestinationCard, Button, Loading, LoadingOverlay } from '../components';
import { useTrip } from '../hooks';
import type { DestinationCard as DestinationCardType } from '../types';
import './DestinationPage.css';

const DestinationPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    visionText,
    searchConditions,
    destinations,
    isLoading,
    error,
    recommendDestinations,
    selectDestination,
  } = useTrip();

  const [selectedDestination, setSelectedDestination] = useState<DestinationCardType | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [hasLoadedInitial, setHasLoadedInitial] = useState(false);
  const [pageEntered, setPageEntered] = useState(false);
  
  // 日期选择器展开状态
  const [isDateExpanded, setIsDateExpanded] = useState(false);
  
  // 悬停状态 - 用于手风琴效果
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  
  // 加载状态
  const [showLoading, setShowLoading] = useState(false);
  
  // 日期选择状态
  const [startDate, setStartDate] = useState<string>(() => {
    // 默认为明天
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  });
  const [totalDays, setTotalDays] = useState<number>(3);
  const [arrivalTime, setArrivalTime] = useState<string>('10:00'); // 默认上午10点抵达
  const [departureTime, setDepartureTime] = useState<string>('17:00'); // 默认下午5点离开

  // 格式化日期摘要显示
  const formatDateSummary = useCallback(() => {
    const date = new Date(startDate);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}.${month}.${day} 起，共 ${totalDays} 天`;
  }, [startDate, totalDays]);

  // Load destinations on mount if we have search conditions
  useEffect(() => {
    if (searchConditions && !hasLoadedInitial && destinations.length === 0) {
      recommendDestinations(searchConditions, false);
      setHasLoadedInitial(true);
    }
  }, [searchConditions, hasLoadedInitial, destinations.length, recommendDestinations]);

  // 页面进入动画
  useEffect(() => {
    const timer = setTimeout(() => setPageEntered(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Redirect to home if no search conditions
  useEffect(() => {
    if (!searchConditions && !isLoading) {
      navigate('/');
    }
  }, [searchConditions, isLoading, navigate]);

  const handleDestinationSelect = useCallback((destination: DestinationCardType) => {
    setSelectedDestination(destination);
  }, []);

  const handleCardHover = useCallback((id: string | null) => {
    setHoveredId(id);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (searchConditions) {
      setSelectedDestination(null);
      await recommendDestinations(searchConditions, true);
    }
  }, [searchConditions, recommendDestinations]);

  const handleConfirmSelection = useCallback(async () => {
    if (!selectedDestination || !searchConditions) {
      console.log('handleConfirmSelection - missing data:', { selectedDestination, searchConditions });
      return;
    }

    console.log('handleConfirmSelection - starting...');
    setShowLoading(true);
    setIsSelecting(true);
    
    try {
      // Use a default userId for MVP (in production, this would come from auth)
      const userId = 'default-user';
      console.log('Selecting destination:', selectedDestination.cityName);
      
      // 更新 searchConditions 包含日期信息
      const conditionsWithDate = {
        ...searchConditions,
        startDate,
        totalDays,
        arrivalTime,
        departureTime,
      };
      
      console.log('Conditions with date:', conditionsWithDate);
      
      const result = await selectDestination(
        userId,
        selectedDestination.cityName,
        conditionsWithDate
      );

      console.log('Selection result:', result);
      
      if (result && result.trip) {
        const targetUrl = `/planning/${result.trip.id}`;
        console.log('Navigating to:', targetUrl);
        // 直接导航，保持 loading 状态，让 PlanningPage 的 LoadingOverlay 无缝接管
        setTimeout(() => {
          navigate(targetUrl);
        }, 500);
      } else {
        console.error('No trip returned from selectDestination');
        setShowLoading(false);
        setIsSelecting(false);
      }
    } catch (err) {
      console.error('Error selecting destination:', err);
      setShowLoading(false);
      setIsSelecting(false);
    }
  }, [selectedDestination, searchConditions, selectDestination, startDate, totalDays, arrivalTime, departureTime, navigate]);

  // Loading state
  if (isLoading && destinations.length === 0) {
    return (
      <div className="destination-page">
        <div className="destination-page__container">
          <div className="destination-page__loading">
            <Loading size="lg" />
            <p className="destination-page__loading-text">
              正在为您寻找理想目的地...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error && destinations.length === 0) {
    return (
      <div className="destination-page">
        <div className="destination-page__container">
          <Link to="/" className="destination-page__back-link">
            ← 返回首页
          </Link>
          <div className="destination-page__error">
            <div className="destination-page__error-icon">😕</div>
            <p className="destination-page__error-message">{error}</p>
            <Button onClick={() => searchConditions && recommendDestinations(searchConditions, false)}>
              重新加载
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Empty state (no search conditions)
  if (!searchConditions) {
    return (
      <div className="destination-page">
        <div className="destination-page__container">
          <div className="destination-page__empty">
            <div className="destination-page__empty-icon">🗺️</div>
            <h2 className="destination-page__empty-title">还没有旅行愿景</h2>
            <p className="destination-page__empty-text">
              请先描述您的理想旅行，我们将为您推荐目的地
            </p>
            <Button onClick={() => navigate('/')}>开始规划</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`destination-page ${pageEntered ? 'destination-page--entered' : ''}`}>
      {/* 左侧面板 - 缘侧（控制区） */}
      <aside className="destination-page__left-panel">
        <Link to="/" className="destination-page__back-link">
          ← 返回首页
        </Link>

        {/* A. 愿景回顾 - 俳句/引言样式 */}
        <div className="destination-page__vision-section">
          <div className="destination-page__vision-text">
            <div className="destination-page__vision-label">您的愿景</div>
            <p className="destination-page__vision-content">
              {visionText || '探索未知的旅程'}
            </p>
          </div>
          
          {/* 选中城市简介 - 动态显示 */}
          <div className={`destination-page__selected-info ${selectedDestination ? 'destination-page__selected-info--visible' : ''}`}>
            {selectedDestination && (
              <>
                <h3 className="destination-page__selected-city">
                  {selectedDestination.cityName}
                  <span className="destination-page__selected-province">{selectedDestination.province}</span>
                </h3>
                <p className="destination-page__selected-reason">
                  {selectedDestination.recommendReason}
                </p>
                <div className="destination-page__selected-tags">
                  {selectedDestination.hotSpots.slice(0, 4).map((spot, index) => (
                    <span key={index} className="destination-page__selected-tag">{spot}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        
        {/* B. 日期与时间 - 极简时间轴 */}
        <div className="destination-page__date-picker">
          <div 
            className="destination-page__date-summary"
            onClick={() => setIsDateExpanded(!isDateExpanded)}
          >
            <span className="destination-page__date-summary-text">
              {formatDateSummary()}
            </span>
            <span className={`destination-page__date-summary-icon ${isDateExpanded ? 'destination-page__date-summary-icon--expanded' : ''}`}>
              ▼
            </span>
          </div>
          
          <div className={`destination-page__date-expanded ${isDateExpanded ? 'destination-page__date-expanded--open' : ''}`}>
            <div className="destination-page__date-row">
              <div className="destination-page__date-field">
                <label className="destination-page__date-label">出发日期</label>
                <input
                  type="date"
                  className="destination-page__date-input"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                />
              </div>
              <div className="destination-page__date-field">
                <label className="destination-page__date-label">旅行天数</label>
                <select
                  className="destination-page__days-select"
                  value={totalDays}
                  onChange={(e) => setTotalDays(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((day) => (
                    <option key={day} value={day}>
                      {day} 天
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="destination-page__date-row">
              <div className="destination-page__date-field">
                <label className="destination-page__date-label">抵达时间</label>
                <select
                  className="destination-page__time-select"
                  value={arrivalTime}
                  onChange={(e) => setArrivalTime(e.target.value)}
                >
                  <option value="08:00">08:00</option>
                  <option value="09:00">09:00</option>
                  <option value="10:00">10:00</option>
                  <option value="11:00">11:00</option>
                  <option value="12:00">12:00</option>
                  <option value="13:00">13:00</option>
                  <option value="14:00">14:00</option>
                  <option value="15:00">15:00</option>
                  <option value="16:00">16:00</option>
                  <option value="17:00">17:00</option>
                  <option value="18:00">18:00</option>
                  <option value="19:00">19:00</option>
                  <option value="20:00">20:00</option>
                  <option value="21:00">21:00</option>
                  <option value="22:00">22:00</option>
                  <option value="23:00">23:00</option>
                </select>
              </div>
              <div className="destination-page__date-field">
                <label className="destination-page__date-label">离开时间</label>
                <select
                  className="destination-page__time-select"
                  value={departureTime}
                  onChange={(e) => setDepartureTime(e.target.value)}
                >
                  <option value="08:00">08:00</option>
                  <option value="09:00">09:00</option>
                  <option value="10:00">10:00</option>
                  <option value="11:00">11:00</option>
                  <option value="12:00">12:00</option>
                  <option value="13:00">13:00</option>
                  <option value="14:00">14:00</option>
                  <option value="15:00">15:00</option>
                  <option value="16:00">16:00</option>
                  <option value="17:00">17:00</option>
                  <option value="18:00">18:00</option>
                  <option value="19:00">19:00</option>
                  <option value="20:00">20:00</option>
                  <option value="21:00">21:00</option>
                  <option value="22:00">22:00</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* C. 底部操作区 */}
        <div className="destination-page__actions">
          {/* 换一批 - 圆形图标按钮 */}
          <button
            className={`destination-page__refresh-btn ${isLoading ? 'destination-page__refresh-btn--loading' : ''}`}
            onClick={handleRefresh}
            disabled={isLoading || isSelecting}
            title="换一批推荐"
          >
            ↻
          </button>
          
          {/* 确认按钮 - 选择城市后显示 */}
          <button
            className={`destination-page__confirm-btn ${selectedDestination ? 'destination-page__confirm-btn--visible' : ''} ${isSelecting ? 'destination-page__confirm-btn--loading' : ''}`}
            onClick={handleConfirmSelection}
            disabled={!selectedDestination || isSelecting}
          >
            开启{selectedDestination?.cityName || ''}之旅 →
          </button>
        </div>
      </aside>

      {/* 右侧面板 - 借景（展示区）- 挂轴设计 */}
      <main className="destination-page__right-panel">
        {destinations.length > 0 ? (
          <div className="destination-page__scrolls">
            {destinations.map((destination) => (
              <DestinationCard
                key={destination.id}
                destination={destination}
                onSelect={handleDestinationSelect}
                isSelected={selectedDestination?.id === destination.id}
                isLoading={isSelecting}
                isExpanded={hoveredId === destination.id}
                isDimmed={hoveredId !== null && hoveredId !== destination.id}
                onHover={handleCardHover}
              />
            ))}
          </div>
        ) : (
          <div className="destination-page__empty">
            <div className="destination-page__empty-icon">🔍</div>
            <h2 className="destination-page__empty-title">暂无推荐结果</h2>
            <p className="destination-page__empty-text">
              请尝试调整您的旅行愿景描述
            </p>
            <Button onClick={() => navigate('/')}>重新描述愿景</Button>
          </div>
        )}
      </main>

      {/* 加载遮罩 */}
      <LoadingOverlay
        isVisible={showLoading}
        message="正在生成您的专属行程..."
        subMessage="请稍候片刻"
      />
    </div>
  );
};

export default DestinationPage;
