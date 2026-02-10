import React, { useEffect, useState } from 'react';
import './PageTransition.css';

interface PageTransitionProps {
  isActive: boolean;
  onComplete?: () => void;
  type?: 'fade' | 'slide' | 'ink';
}

/**
 * 页面过渡动画组件 - 苔原静谧风格
 * 墨染效果：像水墨在宣纸上晕染
 */
const PageTransition: React.FC<PageTransitionProps> = ({
  isActive,
  onComplete,
  type = 'ink'
}) => {
  const [phase, setPhase] = useState<'idle' | 'enter' | 'active' | 'exit'>('idle');

  useEffect(() => {
    if (isActive && phase === 'idle') {
      setPhase('enter');
      
      // 进入动画完成后
      const enterTimer = setTimeout(() => {
        setPhase('active');
        onComplete?.();
      }, 600);

      return () => clearTimeout(enterTimer);
    }
  }, [isActive, phase, onComplete]);

  if (phase === 'idle') return null;

  return (
    <div className={`page-transition page-transition--${type} page-transition--${phase}`}>
      <div className="page-transition__layer page-transition__layer--1" />
      <div className="page-transition__layer page-transition__layer--2" />
      <div className="page-transition__layer page-transition__layer--3" />
    </div>
  );
};

export default PageTransition;
