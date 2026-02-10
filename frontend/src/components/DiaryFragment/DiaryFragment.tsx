import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { DiaryFragment as DiaryFragmentType } from '../../types';
import { Button } from '../Button';
import './DiaryFragment.css';

export interface DiaryFragmentProps {
  fragment: DiaryFragmentType;
  onEdit: (content: string, moodEmoji?: string) => void;
  template?: string;
  isLoading?: boolean;
  destination?: string;
  tripId?: string;
  onImageGenerated?: (imageUrl: string) => void;
}

const MOOD_EMOJIS = [
  { emoji: '😊', label: '开心' },
  { emoji: '🥰', label: '幸福' },
  { emoji: '😎', label: '酷' },
  { emoji: '🤩', label: '惊喜' },
  { emoji: '😌', label: '平静' },
  { emoji: '🥱', label: '疲惫' },
  { emoji: '😋', label: '美味' },
  { emoji: '🤔', label: '思考' },
  { emoji: '😢', label: '感动' },
  { emoji: '🌟', label: '精彩' },
];

const WEATHER_OPTIONS: Record<string, string> = {
  '☀️': '晴天', '⛅': '多云', '☁️': '阴天', '🌧️': '小雨',
  '⛈️': '雷雨', '🌨️': '小雪', '❄️': '大雪', '🌫️': '雾霾',
  '🌬️': '大风', '🌈': '彩虹',
};

type PhotoOrientation = 'landscape' | 'portrait' | 'unknown';

const DiaryFragment: React.FC<DiaryFragmentProps> = ({
  fragment,
  onEdit,
  template = 'default',
  isLoading = false,
  destination = '',
  tripId: _tripId = '',
  onImageGenerated: _onImageGenerated,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(fragment.content);
  const [selectedMood, setSelectedMood] = useState(fragment.moodEmoji || '📝');
  const [showMoodPicker, setShowMoodPicker] = useState(false);
  const [photoOrientation, setPhotoOrientation] = useState<PhotoOrientation>('unknown');
  const [isFlipping, setIsFlipping] = useState(false);
  const [flipDirection, setFlipDirection] = useState<'next' | 'prev'>('next');
  const prevFragmentId = useRef<string>(fragment.id);
  
  // 多图切换状态
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);

  // 检查是否有AI生成的图像（支持新旧格式）
  const aiGeneratedPhoto = fragment.photos.find(p => {
    const photo = p as any;
    return photo.isAiGenerated || 
           photo.visionAnalysis === 'AI_GENERATED' ||
           photo.visionAnalysis?.startsWith('AI_GENERATED');
  });
  // 用户上传的照片（排除AI生成的）
  const userPhotos = fragment.photos.filter(p => {
    const photo = p as any;
    return !photo.isAiGenerated && 
           photo.visionAnalysis !== 'AI_GENERATED' &&
           !photo.visionAnalysis?.startsWith('AI_GENERATED');
  });
  // 当前显示的用户照片
  const currentUserPhoto = userPhotos.length > 0 ? userPhotos[currentPhotoIndex % userPhotos.length] : null;
  // 主照片：优先用户上传的，否则用AI生成的
  const mainPhoto = currentUserPhoto || aiGeneratedPhoto;
  const hasUserPhotos = userPhotos.length > 0;
  const hasMultiplePhotos = userPhotos.length > 1;

  // 切换到下一张照片
  const handleNextPhoto = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasMultiplePhotos) {
      setCurrentPhotoIndex((prev) => (prev + 1) % userPhotos.length);
    }
  }, [hasMultiplePhotos, userPhotos.length]);

  // 切换到上一张照片
  const handlePrevPhoto = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasMultiplePhotos) {
      setCurrentPhotoIndex((prev) => (prev - 1 + userPhotos.length) % userPhotos.length);
    }
  }, [hasMultiplePhotos, userPhotos.length]);

  // 当 fragment 变化时重置照片索引
  useEffect(() => {
    setCurrentPhotoIndex(0);
  }, [fragment.id]);

  // 获取 AI 图片的方向（从 visionAnalysis 或 aiImageOrientation 字段）
  const getAiPhotoOrientation = useCallback((): PhotoOrientation => {
    if (!aiGeneratedPhoto) return 'unknown';
    const photo = aiGeneratedPhoto as any;
    if (photo.aiImageOrientation) {
      return photo.aiImageOrientation;
    }
    if (photo.visionAnalysis?.includes('LANDSCAPE')) {
      return 'landscape';
    }
    if (photo.visionAnalysis?.includes('PORTRAIT')) {
      return 'portrait';
    }
    return 'unknown';
  }, [aiGeneratedPhoto]);

  // 当fragment.id变化时，立即计算新的方向（避免布局闪烁）
  useEffect(() => {
    // 如果是 AI 生成的图片且有方向信息，立即使用
    if (!hasUserPhotos && aiGeneratedPhoto) {
      const aiOrientation = getAiPhotoOrientation();
      if (aiOrientation !== 'unknown') {
        setPhotoOrientation(aiOrientation);
        return;
      }
    }
    // 否则重置为 unknown，等待图片加载后检测
    setPhotoOrientation('unknown');
  }, [fragment.id, hasUserPhotos, aiGeneratedPhoto, getAiPhotoOrientation]);

  // 检测节点切换，触发翻页动画
  useEffect(() => {
    if (prevFragmentId.current !== fragment.id) {
      // 判断翻页方向（可以根据实际需求调整）
      setFlipDirection('next');
      setIsFlipping(true);
      
      const timer = setTimeout(() => {
        setIsFlipping(false);
        prevFragmentId.current = fragment.id;
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [fragment.id]);

  // 获取主照片URL（用于依赖追踪）
  const mainPhotoUrl = mainPhoto?.url;

  // 检测用户上传照片的方向（通过加载图片）
  useEffect(() => {
    // AI 图片方向已在上面的 useEffect 中处理，这里只处理用户上传的照片
    if (hasUserPhotos && mainPhotoUrl) {
      const img = new Image();
      img.onload = () => {
        setPhotoOrientation(img.width > img.height ? 'landscape' : 'portrait');
      };
      img.onerror = () => setPhotoOrientation('unknown');
      // 添加时间戳防止浏览器缓存导致的问题
      const urlWithCacheBuster = mainPhotoUrl.includes('?') 
        ? `${mainPhotoUrl}&_t=${Date.now()}` 
        : `${mainPhotoUrl}?_t=${Date.now()}`;
      img.src = urlWithCacheBuster;
    }
  }, [mainPhotoUrl, hasUserPhotos, fragment.id]);

  const handleEditStart = useCallback(() => {
    setEditContent(fragment.content);
    setSelectedMood(fragment.moodEmoji || '📝');
    setIsEditing(true);
  }, [fragment.content, fragment.moodEmoji]);

  const handleEditSave = useCallback(() => {
    if (editContent.trim() !== fragment.content || selectedMood !== fragment.moodEmoji) {
      onEdit(editContent.trim(), selectedMood);
    }
    setIsEditing(false);
    setShowMoodPicker(false);
  }, [editContent, selectedMood, fragment.content, fragment.moodEmoji, onEdit]);

  const handleEditCancel = useCallback(() => {
    setEditContent(fragment.content);
    setSelectedMood(fragment.moodEmoji || '📝');
    setIsEditing(false);
    setShowMoodPicker(false);
  }, [fragment.content, fragment.moodEmoji]);

  const handleMoodSelect = useCallback((emoji: string) => {
    setSelectedMood(emoji);
    setShowMoodPicker(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleEditCancel();
  }, [handleEditCancel]);

  const getStatusBadge = () => {
    const status = (fragment as any).nodeStatus;
    if (status === 'changed') return <span className="diary-fragment__status-badge diary-fragment__status-badge--changed">🔄 变更</span>;
    if (status === 'unrealized') return <span className="diary-fragment__status-badge diary-fragment__status-badge--unrealized">⏭️ 未实现</span>;
    return null;
  };

  const handleOpenNavigation = useCallback(() => {
    const keyword = destination ? `${destination}${fragment.nodeName}` : fragment.nodeName;
    window.open(`https://uri.amap.com/search?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent(destination)}`, '_blank');
  }, [destination, fragment.nodeName]);

  const handleOpenDetails = useCallback(() => {
    const searchQuery = destination ? `${destination} ${fragment.nodeName} 攻略` : `${fragment.nodeName} 攻略`;
    window.open(`https://www.baidu.com/s?wd=${encodeURIComponent(searchQuery)}`, '_blank');
  }, [destination, fragment.nodeName]);

  // 格式化时间显示
  const formatTime = (timeRange: string) => {
    const match = timeRange.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})?/);
    if (match) {
      const [, year, month, day, time] = match;
      return { 
        date: `${year}.${month.padStart(2, '0')}.${day.padStart(2, '0')}`, 
        time: time || '',
        verticalDate: `${month}月${day}日`,
        chineseMonth: ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'][parseInt(month) - 1] + '月',
        chineseDay: day + '日'
      };
    }
    return { date: timeRange, time: '', verticalDate: '', chineseMonth: '', chineseDay: '' };
  };

  const { date: formattedDate, time: formattedTime } = formatTime(fragment.timeRange);

  // 获取首字（用于首字下沉）
  const getFirstChar = (text: string) => {
    const trimmed = text.trim();
    return trimmed.charAt(0);
  };

  const getRestContent = (text: string) => {
    const trimmed = text.trim();
    return trimmed.slice(1);
  };

  const isLandscape = photoOrientation === 'landscape';

  // 判断是否应该使用横版布局（用户横版照片或AI生成的横版图片）
  const shouldUseLandscapeLayout = isLandscape && (hasUserPhotos || aiGeneratedPhoto);

  // ========== 横版照片：明信片布局 (Postcard) ==========
  if (shouldUseLandscapeLayout) {
    // 获取要显示的主图片URL
    const landscapePhotoUrl = hasUserPhotos ? currentUserPhoto!.url : aiGeneratedPhoto!.url;
    const isAiLandscape = !hasUserPhotos && aiGeneratedPhoto;
    
    return (
      <div className={`diary-fragment diary-fragment--postcard diary-fragment--${template} ${isFlipping ? `diary-fragment--flip-${flipDirection}` : ''}`}>
        <div className="diary-fragment__postcard-layout">
          {/* 上部：照片 + 用户语录（明信片风格） */}
          <div className="diary-fragment__postcard-top">
            {/* 横置拍立得明信片 */}
            <div className="diary-fragment__landscape-polaroid">
              {/* 印章式天气标签 - 左上角 */}
              {fragment.weather && (
                <div className="diary-fragment__corner-stamp diary-fragment__corner-stamp--weather">
                  <span className="diary-fragment__corner-stamp-emoji">{fragment.weather}</span>
                  <span className="diary-fragment__corner-stamp-text">{WEATHER_OPTIONS[fragment.weather] || ''}</span>
                </div>
              )}
              
              <div className="diary-fragment__landscape-frame">
                {/* 模糊弥散背景层 */}
                <div 
                  className="diary-fragment__polaroid-blur-bg"
                  style={{ backgroundImage: `url(${landscapePhotoUrl})` }}
                />
                <img src={landscapePhotoUrl} alt={isAiLandscape ? 'AI生成' : ''} />
              </div>
              
              {/* 多图切换按钮 - 横版 */}
              {hasMultiplePhotos && (
                <>
                  <button 
                    className="diary-fragment__photo-nav diary-fragment__photo-nav--prev diary-fragment__photo-nav--landscape"
                    onClick={handlePrevPhoto}
                    title="上一张"
                  >
                    ‹
                  </button>
                  <button 
                    className="diary-fragment__photo-nav diary-fragment__photo-nav--next diary-fragment__photo-nav--landscape"
                    onClick={handleNextPhoto}
                    title="下一张"
                  >
                    ›
                  </button>
                  <div className="diary-fragment__photo-indicator diary-fragment__photo-indicator--landscape">
                    {currentPhotoIndex + 1} / {userPhotos.length}
                  </div>
                </>
              )}
              
              <div className="diary-fragment__polaroid-meta">
                <span className="diary-fragment__meta-item">
                  <span className="diary-fragment__meta-label">LOC</span>
                  <span className="diary-fragment__meta-value">
                    {destination || fragment.nodeName}
                    {/* AI 生成标识 - 放在位置名称旁 */}
                    {isAiLandscape && <span className="diary-fragment__ai-tag">AI</span>}
                  </span>
                </span>
                {/* 心情标识 - 放在日期旁边 */}
                {fragment.moodEmoji && (
                  <span className="diary-fragment__meta-item diary-fragment__meta-item--mood">
                    <span className="diary-fragment__meta-mood-emoji">{fragment.moodEmoji}</span>
                  </span>
                )}
                <span className="diary-fragment__meta-item">
                  <span className="diary-fragment__meta-label">DATE</span>
                  <span className="diary-fragment__meta-value">{formattedDate}</span>
                </span>
              </div>
            </div>

            {/* 右侧：用户语录 */}
            <div className="diary-fragment__postcard-side">
              {/* 用户原句 */}
              {fragment.textNotes && fragment.textNotes.length > 0 ? (
                <div className="diary-fragment__postcard-quote">
                  <span className="diary-fragment__postcard-quote-mark">"</span>
                  <p className="diary-fragment__postcard-quote-text">
                    {fragment.textNotes.map((note) => note.replace(/^\[\d{1,2}:\d{2}\]\s*/, '')).join(' ')}
                  </p>
                </div>
              ) : (
                <div className="diary-fragment__postcard-quote diary-fragment__postcard-quote--empty">
                  <span className="diary-fragment__postcard-quote-icon">📝</span>
                  <p className="diary-fragment__postcard-quote-placeholder">这一刻的心情，留在了照片里...</p>
                </div>
              )}

              {/* 快捷操作 */}
              <div className="diary-fragment__quick-actions">
                <button className="diary-fragment__action-btn" onClick={handleOpenNavigation}>📍 导航</button>
                <button className="diary-fragment__action-btn" onClick={handleOpenDetails}>🔗 详情</button>
              </div>
            </div>
          </div>

          {/* 下部：标题 + AI 日记 */}
          <div className="diary-fragment__postcard-bottom">
            <header className="diary-fragment__postcard-header">
              <h3 className="diary-fragment__postcard-title">{fragment.nodeName}</h3>
              {getStatusBadge()}
              {!isEditing && (
                <button className="diary-fragment__regenerate-btn" onClick={handleEditStart} disabled={isLoading} title="润色">
                  ✨
                </button>
              )}
            </header>

            {/* AI 日记 */}
            <div className="diary-fragment__flower diary-fragment__flower--horizontal">
              {isEditing ? (
                <div className="diary-fragment__edit-area">
                  <textarea className="diary-fragment__textarea" value={editContent} onChange={(e) => setEditContent(e.target.value)} onKeyDown={handleKeyDown} autoFocus />
                  <div className="diary-fragment__edit-actions">
                    <span className="diary-fragment__char-count">{editContent.length} 字</span>
                    <div className="diary-fragment__edit-buttons">
                      <Button variant="secondary" size="sm" onClick={handleEditCancel}>取消</Button>
                      <Button variant="primary" size="sm" onClick={handleEditSave} disabled={isLoading}>{isLoading ? '...' : '保存'}</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="diary-fragment__prose diary-fragment__prose--horizontal">
                  <span className="diary-fragment__dropcap">{getFirstChar(fragment.content)}</span>
                  {getRestContent(fragment.content)}
                </p>
              )}
            </div>

            {fragment.isEdited && (
              <span className="diary-fragment__edited-badge">已编辑</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ========== 竖版照片/无照片/AI生成图像：杂志页布局（优化版） ==========
  return (
    <div className={`diary-fragment diary-fragment--magazine diary-fragment--${template} ${isFlipping ? `diary-fragment--flip-${flipDirection}` : ''}`}>
      <div className="diary-fragment__spread">
        {/* 左半区：视觉与印记 */}
        <div className="diary-fragment__left-panel">
          {/* 拍立得风格照片 */}
          <div className="diary-fragment__polaroid-area">
            {hasUserPhotos ? (
              <div className="diary-fragment__polaroid">
                <div className="diary-fragment__polaroid-frame">
                  {/* 模糊弥散背景层 */}
                  <div 
                    className="diary-fragment__polaroid-blur-bg"
                    style={{ backgroundImage: `url(${currentUserPhoto!.url})` }}
                  />
                  <img src={currentUserPhoto!.url} alt="" />
                </div>
                <div className="diary-fragment__polaroid-caption">{fragment.nodeName}</div>
                
                {/* 多图切换按钮 */}
                {hasMultiplePhotos && (
                  <>
                    <button 
                      className="diary-fragment__photo-nav diary-fragment__photo-nav--prev"
                      onClick={handlePrevPhoto}
                      title="上一张"
                    >
                      ‹
                    </button>
                    <button 
                      className="diary-fragment__photo-nav diary-fragment__photo-nav--next"
                      onClick={handleNextPhoto}
                      title="下一张"
                    >
                      ›
                    </button>
                    <div className="diary-fragment__photo-indicator">
                      {currentPhotoIndex + 1} / {userPhotos.length}
                    </div>
                  </>
                )}
                
                {/* 红泥印章 - 盖在照片边角 */}
                {fragment.weather && (
                  <div className="diary-fragment__seal diary-fragment__seal--weather diary-fragment__seal--on-photo">
                    {WEATHER_OPTIONS[fragment.weather] || fragment.weather}
                  </div>
                )}
                {fragment.moodEmoji && (
                  <div className="diary-fragment__seal diary-fragment__seal--mood diary-fragment__seal--on-photo-right">
                    {MOOD_EMOJIS.find(m => m.emoji === fragment.moodEmoji)?.label || ''}
                  </div>
                )}
              </div>
            ) : aiGeneratedPhoto ? (
              <div className="diary-fragment__polaroid diary-fragment__polaroid--ai">
                <div className="diary-fragment__polaroid-frame">
                  {/* 模糊弥散背景层 */}
                  <div 
                    className="diary-fragment__polaroid-blur-bg"
                    style={{ backgroundImage: `url(${aiGeneratedPhoto.url})` }}
                  />
                  <img src={aiGeneratedPhoto.url} alt="AI生成" />
                </div>
                <div className="diary-fragment__polaroid-caption">
                  <span className="diary-fragment__ai-badge">🎨 AI</span>
                  {fragment.nodeName}
                </div>
                
                {/* 天气心情印章 */}
                {fragment.weather && (
                  <div className="diary-fragment__seal diary-fragment__seal--weather diary-fragment__seal--on-photo">
                    {WEATHER_OPTIONS[fragment.weather] || fragment.weather}
                  </div>
                )}
                {fragment.moodEmoji && (
                  <div className="diary-fragment__seal diary-fragment__seal--mood diary-fragment__seal--on-photo-right">
                    {MOOD_EMOJIS.find(m => m.emoji === fragment.moodEmoji)?.label || ''}
                  </div>
                )}
              </div>
            ) : (
              <div className="diary-fragment__no-photo">
                <span className="diary-fragment__no-photo-icon">📷</span>
                <span className="diary-fragment__no-photo-text">暂无照片</span>
              </div>
            )}
          </div>

          {/* 地理位置 */}
          <div className="diary-fragment__location" onClick={handleOpenNavigation}>
            <span className="diary-fragment__location-icon">📍</span>
            <span className="diary-fragment__location-text">{destination || fragment.nodeName}</span>
          </div>

          {/* 快捷操作 */}
          <div className="diary-fragment__quick-actions">
            <button className="diary-fragment__action-btn" onClick={handleOpenNavigation}>导航</button>
            <button className="diary-fragment__action-btn" onClick={handleOpenDetails}>详情</button>
          </div>
        </div>

        {/* 右半区：对话与升华 */}
        <div className="diary-fragment__right-panel">
          {/* A. 头部：标题与时间 */}
          <header className="diary-fragment__header">
            <div className="diary-fragment__header-main">
              <h3 className="diary-fragment__title">{fragment.nodeName}</h3>
              {getStatusBadge()}
            </div>
            <div className="diary-fragment__header-meta">
              <span className="diary-fragment__date">{formattedDate}</span>
              {formattedTime && <span className="diary-fragment__time-divider">/</span>}
              {formattedTime && <span className="diary-fragment__time">{formattedTime}</span>}
            </div>
            {!isEditing && (
              <button className="diary-fragment__regenerate-btn" onClick={handleEditStart} disabled={isLoading} title="润色编辑">
                ✨
              </button>
            )}
          </header>

          {/* B. 用户原句 (The Seed) */}
          {fragment.textNotes && fragment.textNotes.length > 0 && (
            <div className="diary-fragment__seed">
              <span className="diary-fragment__seed-quote">"</span>
              <div className="diary-fragment__seed-content">
                {fragment.textNotes.map((note, index) => {
                  const content = note.replace(/^\[\d{1,2}:\d{2}\]\s*/, '');
                  return <span key={index} className="diary-fragment__seed-text">{content}</span>;
                })}
              </div>
            </div>
          )}

          {/* C. 分割线 (The Bridge) */}
          <div className="diary-fragment__bridge">
            <span className="diary-fragment__bridge-icon">✨</span>
          </div>

          {/* D. AI 日记 (The Flower) */}
          <div className="diary-fragment__flower">
            {isEditing ? (
              <div className="diary-fragment__edit-area">
                {showMoodPicker && (
                  <div className="diary-fragment__mood-picker">
                    {MOOD_EMOJIS.map(({ emoji, label }) => (
                      <button key={emoji} className={`diary-fragment__mood-option ${selectedMood === emoji ? 'diary-fragment__mood-option--selected' : ''}`} onClick={() => handleMoodSelect(emoji)} title={label} type="button">
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
                <textarea className="diary-fragment__textarea" value={editContent} onChange={(e) => setEditContent(e.target.value)} onKeyDown={handleKeyDown} autoFocus placeholder="写下你的旅行感受..." />
                <div className="diary-fragment__edit-actions">
                  <span className="diary-fragment__char-count">{editContent.length} 字</span>
                  <div className="diary-fragment__edit-buttons">
                    <Button variant="secondary" size="sm" onClick={handleEditCancel}>取消</Button>
                    <Button variant="primary" size="sm" onClick={handleEditSave} disabled={isLoading || editContent.trim().length === 0}>
                      {isLoading ? '保存中...' : '保存'}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="diary-fragment__prose diary-fragment__prose--dropcap">
                <span className="diary-fragment__dropcap">{getFirstChar(fragment.content)}</span>
                {getRestContent(fragment.content)}
              </p>
            )}
          </div>

          {/* 已编辑标记 */}
          {fragment.isEdited && (
            <div className="diary-fragment__footer">
              <span className="diary-fragment__edited-badge">已编辑</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DiaryFragment;
