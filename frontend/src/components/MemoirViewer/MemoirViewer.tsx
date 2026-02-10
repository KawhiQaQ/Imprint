import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { TravelMemoir, MemoirTemplate, DiaryFragment } from '../../types';
import './MemoirViewer.css';

export interface MemoirViewerProps {
  memoir: TravelMemoir;
  template: MemoirTemplate;
}

// 幻灯片类型定义
type SlideType = 'cover' | 'opening' | 'chapter' | 'closing' | 'personality' | 'outro';
type PhotoOrientation = 'landscape' | 'portrait' | 'square' | 'unknown';

interface Slide {
  type: SlideType;
  fragment?: DiaryFragment;
  index: number;
  label: string; // 用于进度指示器
}

const MemoirViewer: React.FC<MemoirViewerProps> = ({ memoir, template }) => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [parallaxOffset, setParallaxOffset] = useState(0); // 视差偏移量
  const [photoOrientations, setPhotoOrientations] = useState<Record<string, PhotoOrientation>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  // 检测所有照片的方向
  useEffect(() => {
    const fragments = memoir.fragments || [];
    fragments.forEach((fragment) => {
      const photos = fragment.photos || [];
      if (photos.length > 0 && !photoOrientations[fragment.id]) {
        const img = new Image();
        img.onload = () => {
          const ratio = img.width / img.height;
          let orientation: PhotoOrientation;
          if (ratio > 1.2) {
            orientation = 'landscape';
          } else if (ratio < 0.8) {
            orientation = 'portrait';
          } else {
            orientation = 'square';
          }
          setPhotoOrientations(prev => ({ ...prev, [fragment.id]: orientation }));
        };
        img.onerror = () => {
          setPhotoOrientations(prev => ({ ...prev, [fragment.id]: 'unknown' }));
        };
        img.src = photos[0].url;
      }
    });
  }, [memoir.fragments, photoOrientations]);

  // 构建幻灯片序列
  const slides: Slide[] = React.useMemo(() => {
    const result: Slide[] = [];
    let idx = 0;
    let chapterNum = 0;

    // 1. 封面页
    result.push({ type: 'cover', index: idx++, label: '封面' });

    // 2. 开篇页（如果有）
    if (memoir.openingText) {
      result.push({ type: 'opening', index: idx++, label: '序' });
    }

    // 3. 内容页 - 每个日记片段一页
    (memoir.fragments || []).forEach((fragment) => {
      chapterNum++;
      result.push({ 
        type: 'chapter', 
        fragment, 
        index: idx++, 
        label: String(chapterNum).padStart(2, '0') 
      });
    });

    // 4. 结语页（如果有）
    if (memoir.closingText) {
      result.push({ type: 'closing', index: idx++, label: '结' });
    }

    // 5. 旅行人格页
    if (memoir.personalityReport) {
      result.push({ type: 'personality', index: idx++, label: '析' });
    }

    // 6. 封底页
    result.push({ type: 'outro', index: idx++, label: '终' });

    return result;
  }, [memoir]);

  const totalSlides = slides.length;

  // 翻页函数
  const goToSlide = useCallback((index: number) => {
    if (isTransitioning || index < 0 || index >= totalSlides) return;
    setIsTransitioning(true);
    setParallaxOffset(0); // 重置视差
    setCurrentSlide(index);
    setTimeout(() => setIsTransitioning(false), 600);
  }, [isTransitioning, totalSlides]);

  const nextSlide = useCallback(() => {
    goToSlide(currentSlide + 1);
  }, [currentSlide, goToSlide]);

  const prevSlide = useCallback(() => {
    goToSlide(currentSlide - 1);
  }, [currentSlide, goToSlide]);

  // 鼠标滚轮 - 仅用于文字区域滚动，不再翻页
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // 检查是否在可滚动的文字区域内
      const target = e.target as HTMLElement;
      const scrollableArea = target.closest('.memoir-slide__chapter-body, .memoir-slide__cinematic-body');
      
      if (scrollableArea) {
        // 在文字区域内，让文字区域自己滚动，不做任何干预
        return;
      }
      
      // 不在文字区域内时，阻止默认滚动行为（防止页面滚动）
      e.preventDefault();
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // 键盘翻页
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        nextSlide();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        prevSlide();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextSlide, prevSlide]);

  // 触摸翻页
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.touches[0].clientX);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const touchEnd = e.changedTouches[0].clientX;
    const diff = touchStart - touchEnd;

    if (Math.abs(diff) > 50) {
      if (diff > 0) {
        nextSlide();
      } else {
        prevSlide();
      }
    }
    setTouchStart(null);
  };

  // 格式化日期范围
  const formatDateRange = (date: Date): string => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${year}年${month}月${day}日`;
  };

  // 从标题中提取目的地名称（用于竖排）
  const extractDestination = (title: string): { main: string; sub: string } => {
    // 尝试匹配 "XX · XX" 格式
    const match = title.match(/^(.+?)\s*[·•]\s*(.+)$/);
    if (match) {
      return { main: match[1], sub: match[2] };
    }
    return { main: title, sub: '' };
  };

  // 将日记内容分行显示（诗歌排版）
  const formatContentAsPoetry = (content: string): string[] => {
    // 按句号、感叹号、问号分割，保留标点
    const sentences = content.split(/(?<=[。！？])/g).filter(s => s.trim());
    return sentences;
  };

  // 格式化章节序号
  const formatChapterIndex = (index: number): string => {
    return String(index + 1).padStart(2, '0');
  };

  // 获取时间段标签
  const getTimeLabel = (fragment: DiaryFragment): string => {
    // 从 timeRange 中提取时间
    const timeMatch = fragment.timeRange?.match(/(\d{1,2}:\d{2})/);
    return timeMatch ? timeMatch[1] : '';
  };

  // 渲染封面页 - 全屏铺满 + 纸质纹理 + 竖排标题 + 视差
  const renderCoverSlide = () => {
    const { main, sub } = extractDestination(memoir.title);
    
    // 视差：背景移动慢，文字移动快
    const bgParallax = { transform: `translateX(${parallaxOffset * 0.2}px) scale(1.05)` };
    const contentParallax = { transform: `translateX(${parallaxOffset * -0.5}px)` };
    
    return (
      <div className="memoir-slide memoir-slide--cover">
        {/* 背景图层 */}
        <div className="memoir-slide__cover-bg" style={bgParallax}>
          <img src={memoir.coverImageUrl} alt="" className="memoir-slide__cover-image" />
          {/* 纸质纹理叠加层 */}
          <div className="memoir-slide__cover-texture" />
          {/* 渐变遮罩 */}
          <div className="memoir-slide__cover-overlay" />
        </div>
        
        {/* 内容层 - 右侧竖排 */}
        <div className="memoir-slide__cover-content" style={contentParallax}>
          {/* 竖排标题区域 */}
          <div className="memoir-slide__cover-title-area">
            <h1 className="memoir-slide__cover-title memoir-slide__cover-title--vertical">
              <span className="memoir-slide__cover-title-main">{main}</span>
              {sub && (
                <>
                  <span className="memoir-slide__cover-title-dot">·</span>
                  <span className="memoir-slide__cover-title-sub">{sub}</span>
                </>
              )}
            </h1>
          </div>
          
          {/* 落款 */}
          <div className="memoir-slide__cover-meta">
            <span className="memoir-slide__cover-date">{formatDateRange(memoir.generatedAt)}</span>
            <span className="memoir-slide__cover-badge">旅行回忆录</span>
          </div>
        </div>

        {/* 翻页提示 */}
        <div className="memoir-slide__cover-hint" onClick={nextSlide}>
          <span className="memoir-slide__cover-hint-text">开启回忆</span>
          <span className="memoir-slide__cover-hint-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      </div>
    );
  };

  // 渲染开篇页
  const renderOpeningSlide = () => (
    <div className="memoir-slide memoir-slide--opening">
      <div className="memoir-slide__opening-content">
        <span className="memoir-slide__opening-icon">✈️</span>
        <blockquote className="memoir-slide__opening-text">
          {memoir.openingText}
        </blockquote>
        <div className="memoir-slide__opening-decoration" />
      </div>
    </div>
  );

  // 格式化照片元数据（日期和地点）
  const formatPhotoMeta = (fragment: DiaryFragment): { date: string; location: string } => {
    // 从 timeRange 提取日期
    const dateMatch = fragment.timeRange?.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const date = dateMatch ? `${dateMatch[1]}.${dateMatch[2].padStart(2, '0')}.${dateMatch[3].padStart(2, '0')}` : '';
    // 地点使用节点名称
    const location = fragment.nodeName || '';
    return { date, location };
  };

  // 渲染章节页 - 根据照片比例动态切换布局
  const renderChapterSlide = (fragment: DiaryFragment, chapterIndex: number) => {
    const photos = fragment.photos || [];
    const hasPhotos = photos.length > 0;
    const contentLines = formatContentAsPoetry(fragment.content);
    const timeLabel = getTimeLabel(fragment);
    const orientation = photoOrientations[fragment.id] || 'unknown';
    const isLandscape = orientation === 'landscape';
    const isPortrait = orientation === 'portrait';
    const photoMeta = formatPhotoMeta(fragment);

    // 视差样式
    const visualParallax = { transform: `translateX(${parallaxOffset * 0.3}px)` };
    const textParallax = { transform: `translateX(${parallaxOffset * -0.6}px)` };

    // ========== 横版照片：宽幅电影布局 (The Cinematic Wide) ==========
    if (isLandscape && hasPhotos) {
      return (
        <div className="memoir-slide memoir-slide--chapter memoir-slide--chapter-cinematic">
          {/* 上部：照片区 (60% 高度) */}
          <div className="memoir-slide__cinematic-visual" style={visualParallax}>
            {/* 日式装裱照片框 - 横版固定尺寸 */}
            <div className="memoir-slide__mounted-frame memoir-slide__mounted-frame--landscape">
              <div className="memoir-slide__mounted-inner">
                <div 
                  className="memoir-slide__chapter-photo-blur"
                  style={{ backgroundImage: `url(${photos[0].url})` }}
                />
                <img src={photos[0].url} alt="" className="memoir-slide__mounted-photo" />
              </div>
              {/* 元数据落款 */}
              <div className="memoir-slide__photo-meta">
                <span className="memoir-slide__photo-meta-date">{photoMeta.date}</span>
                <span className="memoir-slide__photo-meta-loc">{photoMeta.location}</span>
              </div>
              {/* 朱砂印章 - 心情 */}
              {fragment.moodEmoji && (
                <div className="memoir-slide__seal memoir-slide__seal--cinematic">
                  <span className="memoir-slide__seal-char">{fragment.moodEmoji}</span>
                </div>
              )}
            </div>
            {/* 更多照片缩略图 */}
            {photos.length > 1 && (
              <div className="memoir-slide__cinematic-thumbs">
                {photos.slice(1, 4).map((photo) => (
                  <div key={photo.id} className="memoir-slide__cinematic-thumb">
                    <img src={photo.url} alt="" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 下部：文字区 (40% 高度) - 三栏式布局 */}
          <div className="memoir-slide__cinematic-text" style={textParallax}>
            {/* 左栏：序号与时间 */}
            <div className="memoir-slide__cinematic-meta">
              <span className="memoir-slide__chapter-index">{formatChapterIndex(chapterIndex)}</span>
              <h3 className="memoir-slide__cinematic-title">{fragment.nodeName}</h3>
              {timeLabel && <span className="memoir-slide__cinematic-time">{timeLabel}</span>}
            </div>

            {/* 中栏：日记文本 - 双栏阅读 */}
            <div className="memoir-slide__cinematic-body">
              <div className="memoir-slide__cinematic-poetry">
                {contentLines.map((line, i) => (
                  <p key={i} className="memoir-slide__chapter-line">{line}</p>
                ))}
              </div>
            </div>

            {/* 右栏留空（印章已移到照片上） */}
            <div className="memoir-slide__cinematic-spacer" />
          </div>
        </div>
      );
    }

    // ========== 竖版/方形照片：挂轴画意布局 (The Vertical Scroll) ==========
    // 根据照片方向确定邮票框架类名
    const frameOrientationClass = isPortrait 
      ? 'memoir-slide__mounted-frame--portrait' 
      : 'memoir-slide__mounted-frame--square';
    
    return (
      <div className="memoir-slide memoir-slide--chapter memoir-slide--chapter-scroll">
        {/* 左侧：视觉主导区 (45%) */}
        <div className="memoir-slide__scroll-visual" style={visualParallax}>
          {hasPhotos ? (
            <div className="memoir-slide__scroll-photo-area">
              {/* 日式装裱照片框 - 固定尺寸 */}
              <div className={`memoir-slide__mounted-frame ${frameOrientationClass}`}>
                <div className="memoir-slide__mounted-inner">
                  <div 
                    className="memoir-slide__chapter-photo-blur"
                    style={{ backgroundImage: `url(${photos[0].url})` }}
                  />
                  <img 
                    src={photos[0].url} 
                    alt="" 
                    className="memoir-slide__mounted-photo"
                  />
                </div>
                {/* 元数据落款 */}
                <div className="memoir-slide__photo-meta">
                  <span className="memoir-slide__photo-meta-date">{photoMeta.date}</span>
                  <span className="memoir-slide__photo-meta-loc">{photoMeta.location}</span>
                </div>
              </div>
              {/* 朱砂印章 - 心情 - 移到照片框外部，避免被遮挡 */}
              {fragment.moodEmoji && (
                <div className="memoir-slide__seal memoir-slide__seal--scroll-external">
                  <span className="memoir-slide__seal-char">{fragment.moodEmoji}</span>
                </div>
              )}
              {/* 更多照片 */}
              {photos.length > 1 && (
                <div className="memoir-slide__scroll-more">
                  {photos.slice(1, 3).map((photo) => (
                    <div key={photo.id} className="memoir-slide__scroll-thumb">
                      <img src={photo.url} alt="" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="memoir-slide__chapter-placeholder">
              <div className="memoir-slide__chapter-placeholder-content">
                <span className="memoir-slide__chapter-placeholder-emoji">{fragment.moodEmoji || '✨'}</span>
                <span className="memoir-slide__chapter-placeholder-text">回忆中...</span>
              </div>
            </div>
          )}
        </div>

        {/* 右侧：文字留白区 (55%) */}
        <div className="memoir-slide__scroll-text" style={textParallax}>
          {/* 角落序号 */}
          <div className="memoir-slide__chapter-index-area">
            <span className="memoir-slide__chapter-index">{formatChapterIndex(chapterIndex)}</span>
            <span className="memoir-slide__chapter-index-label">{fragment.nodeName}</span>
          </div>
          
          {/* 时间 */}
          {timeLabel && (
            <div className="memoir-slide__chapter-time">
              {timeLabel}
            </div>
          )}
          
          {/* 诗歌式日记文本 */}
          <div className="memoir-slide__chapter-body">
            <div className="memoir-slide__chapter-poetry">
              {contentLines.map((line, i) => (
                <p key={i} className="memoir-slide__chapter-line">{line}</p>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // 渲染结语页
  const renderClosingSlide = () => (
    <div className="memoir-slide memoir-slide--closing">
      <div className="memoir-slide__closing-content">
        <span className="memoir-slide__closing-icon">🌟</span>
        <blockquote className="memoir-slide__closing-text">
          {memoir.closingText}
        </blockquote>
        <div className="memoir-slide__closing-decoration" />
      </div>
    </div>
  );

  // 渲染旅行人格页 - 星图样式 + 标签云
  const renderPersonalitySlide = () => {
    const report = memoir.personalityReport;
    if (!report) return null;

    const stats = report.statistics || {};
    const traits = report.traits || [];

    return (
      <div className="memoir-slide memoir-slide--personality">
        {/* 背景装饰 */}
        <div className="memoir-slide__personality-bg">
          <div className="memoir-slide__personality-stars" />
        </div>

        {/* 居中悬浮卡片 */}
        <div className="memoir-slide__personality-card">
          {/* 称号 - 艺术字体 */}
          <h2 className="memoir-slide__personality-title">{report.title}</h2>
          
          {/* 描述 */}
          <p className="memoir-slide__personality-desc">{report.description}</p>
          
          {/* 星图式数据展示 */}
          <div className="memoir-slide__personality-constellation">
            <div className="memoir-slide__personality-stat memoir-slide__personality-stat--days">
              <span className="memoir-slide__personality-stat-value">{stats.totalDays || 0}</span>
              <span className="memoir-slide__personality-stat-label">天</span>
              <div className="memoir-slide__personality-stat-star" />
            </div>
            <div className="memoir-slide__personality-stat-line memoir-slide__personality-stat-line--1" />
            <div className="memoir-slide__personality-stat memoir-slide__personality-stat--nodes">
              <span className="memoir-slide__personality-stat-value">{stats.totalNodes || 0}</span>
              <span className="memoir-slide__personality-stat-label">地点</span>
              <div className="memoir-slide__personality-stat-star" />
            </div>
            <div className="memoir-slide__personality-stat-line memoir-slide__personality-stat-line--2" />
            <div className="memoir-slide__personality-stat memoir-slide__personality-stat--photos">
              <span className="memoir-slide__personality-stat-value">{stats.totalPhotos || 0}</span>
              <span className="memoir-slide__personality-stat-label">照片</span>
              <div className="memoir-slide__personality-stat-star" />
            </div>
          </div>

          {/* 心情展示 */}
          {(stats.topMoods || []).length > 0 && (
            <div className="memoir-slide__personality-moods">
              {(stats.topMoods || []).map((mood, i) => (
                <span key={i} className="memoir-slide__personality-mood">{mood}</span>
              ))}
            </div>
          )}
        </div>

        {/* 标签云 - 散落在周围 */}
        <div className="memoir-slide__personality-tags">
          {traits.map((trait, i) => (
            <span 
              key={i} 
              className={`memoir-slide__personality-tag memoir-slide__personality-tag--${i % 5}`}
              style={{ animationDelay: `${i * 0.2}s` }}
            >
              {trait}
            </span>
          ))}
        </div>
      </div>
    );
  };

  // 渲染封底页 + 视差
  const renderOutroSlide = () => {
    const bgParallax = { transform: `translateX(${parallaxOffset * 0.2}px) scale(1.05)` };
    const contentParallax = { transform: `translateX(${parallaxOffset * -0.5}px)` };
    
    return (
      <div className="memoir-slide memoir-slide--outro">
        <div className="memoir-slide__outro-bg" style={bgParallax}>
          <img src={memoir.endImageUrl} alt="" className="memoir-slide__outro-image" />
          <div className="memoir-slide__outro-texture" />
          <div className="memoir-slide__outro-overlay" />
        </div>
        <div className="memoir-slide__outro-content" style={contentParallax}>
          <p className="memoir-slide__outro-message">
            旅途的终点
            <br />
            是下一段旅程的起点
          </p>
          <div className="memoir-slide__outro-end">— 完 —</div>
        </div>
      </div>
    );
  };

  // 渲染当前幻灯片
  const renderSlide = (slide: Slide) => {
    switch (slide.type) {
      case 'cover':
        return renderCoverSlide();
      case 'opening':
        return renderOpeningSlide();
      case 'chapter':
        if (!slide.fragment) return null;
        const chapterIndex = slides
          .filter(s => s.type === 'chapter')
          .findIndex(s => s.fragment?.id === slide.fragment?.id);
        return renderChapterSlide(slide.fragment, chapterIndex);
      case 'closing':
        return renderClosingSlide();
      case 'personality':
        return renderPersonalitySlide();
      case 'outro':
        return renderOutroSlide();
      default:
        return null;
    }
  };

  return (
    <div
      ref={containerRef}
      className={`memoir-viewer memoir-viewer--immersive ${template.cssClass}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* 幻灯片容器 */}
      <div
        className="memoir-viewer__slides"
        style={{ transform: `translateX(-${currentSlide * 100}%)` }}
      >
        {slides.map((slide) => (
          <div key={slide.index} className="memoir-viewer__slide-wrapper">
            {renderSlide(slide)}
          </div>
        ))}
      </div>

      {/* 导航箭头 */}
      {currentSlide > 0 && (
        <button
          className="memoir-viewer__nav memoir-viewer__nav--prev"
          onClick={prevSlide}
          aria-label="上一页"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      {currentSlide < totalSlides - 1 && (
        <button
          className="memoir-viewer__nav memoir-viewer__nav--next"
          onClick={nextSlide}
          aria-label="下一页"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {/* 底部进度条 */}
      <div className="memoir-viewer__progress-bar">
        <div 
          className="memoir-viewer__progress-fill"
          style={{ width: `${((currentSlide + 1) / totalSlides) * 100}%` }}
        />
      </div>

      {/* 右侧垂直进度指示器 - 旅行者路径 */}
      <div className="memoir-viewer__progress-vertical">
        {/* 路径连接线 */}
        <div className="memoir-viewer__progress-path">
          <div 
            className="memoir-viewer__progress-path-fill"
            style={{ height: `${(currentSlide / (totalSlides - 1)) * 100}%` }}
          />
        </div>
        
        {/* 旅行者图标 - 跟随当前进度 */}
        <div 
          className="memoir-viewer__traveler"
          style={{ top: `${(currentSlide / (totalSlides - 1)) * 100}%` }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="memoir-viewer__traveler-icon">
            {/* 背包客剪影 */}
            <circle cx="12" cy="5" r="3" /> {/* 头 */}
            <path d="M9 9h6l1 3h-8l1-3z" /> {/* 肩膀 */}
            <rect x="10" y="12" width="4" height="6" rx="1" /> {/* 身体 */}
            <path d="M8 11h2v7l-2 3v-10z" /> {/* 左腿 */}
            <path d="M14 11h2v10l-2-3v-7z" /> {/* 右腿 */}
            <ellipse cx="15" cy="10" rx="2.5" ry="3.5" /> {/* 背包 */}
          </svg>
        </div>
        
        {/* 节点 */}
        {slides.map((slide, i) => (
          <button
            key={i}
            className={`memoir-viewer__progress-dot ${i === currentSlide ? 'memoir-viewer__progress-dot--active' : ''} ${i < currentSlide ? 'memoir-viewer__progress-dot--passed' : ''}`}
            onClick={() => goToSlide(i)}
            aria-label={`跳转到 ${slide.label}`}
          >
            <span className="memoir-viewer__progress-dot-label">{slide.label}</span>
          </button>
        ))}
      </div>

      {/* 页码文字 */}
      <div className="memoir-viewer__page-number">
        {currentSlide + 1} / {totalSlides}
      </div>
    </div>
  );
};

export default MemoirViewer;
