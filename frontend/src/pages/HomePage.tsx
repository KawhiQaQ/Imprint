import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { VisionInput, CitySearch, LoadingOverlay } from '../components';
import { useTrip } from '../hooks';
import type { CitySearchResult } from '../types';
import './HomePage.css';

type InputMode = 'vision' | 'search';

const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { analyzeVision, directSelectCity, recommendDestinations, isLoading, error } = useTrip();
  const [inputMode, setInputMode] = useState<InputMode>('vision');
  const [selectedCity, setSelectedCity] = useState<CitySearchResult | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  
  // 加载状态
  const [showLoading, setShowLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  
  // 日期选择状态
  const [startDate, setStartDate] = useState<string>(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  });
  const [totalDays, setTotalDays] = useState<number>(3);
  const [arrivalTime, setArrivalTime] = useState<string>('10:00');
  const [departureTime, setDepartureTime] = useState<string>('17:00');

  const handleVisionSubmit = useCallback(async (text: string) => {
    setLoadingMessage('正在分析您的旅行愿景...');
    setShowLoading(true);
    
    try {
      // 1. 先分析愿景
      const result = await analyzeVision(text);
      console.log('Vision analysis result:', result);
      
      if (result && result.success && result.conditions) {
        // 2. 分析成功后，继续加载推荐目的地
        setLoadingMessage('正在为您匹配理想目的地...');
        
        const destResult = await recommendDestinations(result.conditions, false);
        console.log('Destination recommend result:', destResult);
        
        // 3. 无论推荐是否成功都跳转（目的地页面会处理空状态）
        setTimeout(() => {
          setShowLoading(false);
          navigate('/destinations');
        }, 300);
      } else {
        console.log('Vision analysis failed or no success');
        setShowLoading(false);
      }
    } catch (err) {
      console.error('Vision submit error:', err);
      setShowLoading(false);
    }
  }, [analyzeVision, recommendDestinations, navigate]);

  const handleCitySelect = useCallback((city: CitySearchResult) => {
    setSelectedCity(city);
    setShowDatePicker(true);
  }, []);

  const handleDirectSelect = useCallback(async () => {
    if (!selectedCity) return;
    
    setShowDatePicker(false);
    setLoadingMessage('正在规划您的旅程...');
    setShowLoading(true);
    
    try {
      const result = await directSelectCity('default-user', selectedCity.cityName, {
        startDate,
        totalDays,
        arrivalTime,
        departureTime,
      });
      
      if (result && result.trip) {
        setTimeout(() => {
          setShowLoading(false);
          navigate(`/planning/${result.trip.id}`);
        }, 1000);
      } else {
        setShowLoading(false);
      }
    } catch (err) {
      console.error('Direct select error:', err);
      setShowLoading(false);
    }
  }, [selectedCity, directSelectCity, startDate, totalDays, arrivalTime, departureTime, navigate]);

  const handleCancelDatePicker = useCallback(() => {
    setShowDatePicker(false);
    setSelectedCity(null);
  }, []);

  return (
    <div className="home-page">
      {/* 背景装饰层 */}
      <div className="home-bg-decor">
        <div className="home-bg-branch" />
        <div className="home-bg-glow home-bg-glow--top" />
        <div className="home-bg-glow home-bg-glow--bottom" />
        <div className="home-bg-monstera" />
        <div className="home-bg-pine" />
      </div>

      {/* 顶部导航 */}
      <header className="home-header">
        <div className="home-logo">
          <span className="home-logo-text">迹录</span>
          <span className="home-logo-en">Imprint</span>
          <span className="home-logo-seal">迹</span>
        </div>
        <button 
          className="home-shelf-btn"
          onClick={() => navigate('/history')}
        >
          我的书架
        </button>
      </header>

      {/* 核心交互区 - 中心卡片 */}
      <main className="home-card">
        {/* 卡片标题区 */}
        <div className="home-card-header">
          <h1 className="home-card-title">开启你的旅程</h1>
          <p className="home-card-subtitle">描述心中的远方，或直接搜索目的地</p>
        </div>

        {/* 分段控制器 */}
        <div className="home-segmented">
          <button 
            className={`home-segment ${inputMode === 'vision' ? 'home-segment--active' : ''}`}
            onClick={() => setInputMode('vision')}
          >
            书写愿景
          </button>
          <button 
            className={`home-segment ${inputMode === 'search' ? 'home-segment--active' : ''}`}
            onClick={() => setInputMode('search')}
          >
            搜索目的地
          </button>
          <div 
            className="home-segment-indicator" 
            style={{ transform: inputMode === 'search' ? 'translateX(100%)' : 'translateX(0)' }}
          />
        </div>

        {/* 输入区域 */}
        <div className="home-input-container">
          <div className={`home-input-panel ${inputMode === 'vision' ? 'home-input-panel--active' : ''}`}>
            <VisionInput
              onSubmit={handleVisionSubmit}
              isLoading={isLoading}
              error={error}
            />
          </div>
          <div className={`home-input-panel ${inputMode === 'search' ? 'home-input-panel--active' : ''}`}>
            <p className="home-search-hint">输入城市名称，开启你的旅程</p>
            <CitySearch
              onCitySelect={handleCitySelect}
              isLoading={isLoading}
              disabled={isLoading}
            />
            <div className="home-search-suggestions">
              <span className="home-search-suggestions-label">热门目的地</span>
              <div className="home-search-suggestions-list">
                {['杭州', '成都', '大理', '厦门', '西安'].map((city) => (
                  <button
                    key={city}
                    className="home-search-suggestion"
                    onClick={() => {
                      const input = document.querySelector('.city-search__input') as HTMLInputElement;
                      if (input) {
                        input.value = city;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                      }
                    }}
                  >
                    {city}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 卡片底部 */}
        <div className="home-card-footer">
          <span className="home-card-motto">记录旅途中的每一个瞬间，让回忆成为永恒的印记</span>
        </div>
      </main>

      {/* 日期选择模态框 */}
      {showDatePicker && selectedCity && (
        <div className="home-modal-overlay" onClick={handleCancelDatePicker}>
          <div className="home-modal" onClick={(e) => e.stopPropagation()}>
            <div className="home-modal-header">
              <h2 className="home-modal-title">前往 {selectedCity.cityName}</h2>
              <p className="home-modal-subtitle">{selectedCity.province} · {selectedCity.description}</p>
            </div>
            
            <div className="home-modal-body">
              <div className="home-date-picker">
                <div className="home-date-field">
                  <label className="home-date-label">出发日期</label>
                  <input
                    type="date"
                    className="home-date-input"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                  />
                </div>
                <div className="home-date-field">
                  <label className="home-date-label">旅行天数</label>
                  <select
                    className="home-days-select"
                    value={totalDays}
                    onChange={(e) => setTotalDays(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((day) => (
                      <option key={day} value={day}>{day} 天</option>
                    ))}
                  </select>
                </div>
                <div className="home-date-field">
                  <label className="home-date-label">抵达时间</label>
                  <select
                    className="home-time-select"
                    value={arrivalTime}
                    onChange={(e) => setArrivalTime(e.target.value)}
                  >
                    {['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'].map((time) => (
                      <option key={time} value={time}>{time}</option>
                    ))}
                  </select>
                </div>
                <div className="home-date-field">
                  <label className="home-date-label">离开时间</label>
                  <select
                    className="home-time-select"
                    value={departureTime}
                    onChange={(e) => setDepartureTime(e.target.value)}
                  >
                    {['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00'].map((time) => (
                      <option key={time} value={time}>{time}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="home-modal-footer">
              <button className="home-btn home-btn--ghost" onClick={handleCancelDatePicker}>
                取消
              </button>
              <button 
                className="home-btn home-btn--primary"
                onClick={handleDirectSelect}
                disabled={isLoading}
              >
                {isLoading ? '规划中...' : '开始探索'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 加载遮罩 */}
      <LoadingOverlay
        isVisible={showLoading}
        message={loadingMessage}
        subMessage="请稍候片刻"
      />
    </div>
  );
};

export default HomePage;
