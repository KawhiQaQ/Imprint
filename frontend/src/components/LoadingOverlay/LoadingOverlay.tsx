import React, { useEffect, useState, useRef } from 'react';
import './LoadingOverlay.css';

interface LoadingOverlayProps {
  isVisible: boolean;
  message?: string;
  subMessage?: string;
  onExitComplete?: () => void;
}

/**
 * 全屏加载遮罩 - 苔原静谧风格
 * 禅意加载动画
 */
const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  isVisible,
  message = '正在为您寻找理想目的地...',
  subMessage = '请稍候片刻',
  onExitComplete
}) => {
  // 如果初始就是 visible，直接显示，避免白屏闪烁
  const [phase, setPhase] = useState<'hidden' | 'entering' | 'visible' | 'exiting'>(
    isVisible ? 'visible' : 'hidden'
  );
  const onExitCompleteRef = useRef(onExitComplete);
  
  // 保持 ref 最新
  useEffect(() => {
    onExitCompleteRef.current = onExitComplete;
  }, [onExitComplete]);

  useEffect(() => {
    if (isVisible && phase === 'hidden') {
      setPhase('entering');
      const timer = setTimeout(() => setPhase('visible'), 50);
      return () => clearTimeout(timer);
    } else if (!isVisible && (phase === 'visible' || phase === 'entering')) {
      setPhase('exiting');
      const timer = setTimeout(() => {
        setPhase('hidden');
        onExitCompleteRef.current?.();
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [isVisible, phase]);

  if (phase === 'hidden') return null;

  return (
    <div className={`loading-overlay loading-overlay--${phase}`}>
      {/* 背景层 */}
      <div className="loading-overlay__bg" />
      
      {/* 装饰元素 */}
      <div className="loading-overlay__decor loading-overlay__decor--tl" />
      <div className="loading-overlay__decor loading-overlay__decor--br" />
      <div className="loading-overlay__decor loading-overlay__decor--tr" />
      <div className="loading-overlay__decor loading-overlay__decor--bl" />
      <div className="loading-overlay__decor loading-overlay__decor--ml" />
      <div className="loading-overlay__decor loading-overlay__decor--mr" />
      
      {/* 内容 */}
      <div className="loading-overlay__content">
        {/* 装饰性诗句 - 移到上方 */}
        <div className="loading-overlay__poem">
          <span>山川异域</span>
          <span className="loading-overlay__poem-dot">·</span>
          <span>风月同天</span>
        </div>

        {/* 禅意圆环动画 */}
        <div className="loading-overlay__zen">
          <div className="loading-overlay__circle loading-overlay__circle--outer" />
          <div className="loading-overlay__circle loading-overlay__circle--middle" />
          <div className="loading-overlay__circle loading-overlay__circle--inner" />
          <div className="loading-overlay__dot" />
        </div>

        {/* 文字 */}
        <div className="loading-overlay__text">
          <p className="loading-overlay__message">{message}</p>
          <p className="loading-overlay__sub">{subMessage}</p>
        </div>
      </div>
    </div>
  );
};

export default LoadingOverlay;
