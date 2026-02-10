import React from 'react';
import './Loading.css';

export interface LoadingProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
  fullScreen?: boolean;
  className?: string;
}

const Loading: React.FC<LoadingProps> = ({
  size = 'md',
  text,
  fullScreen = false,
  className = '',
}) => {
  const containerClass = [
    'loading-container',
    fullScreen ? 'loading-fullscreen' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClass} role="status" aria-live="polite">
      <div className={`loading-spinner loading-${size}`}>
        <div className="loading-circle" />
        <div className="loading-circle" />
        <div className="loading-circle" />
      </div>
      {text && <p className="loading-text">{text}</p>}
      <span className="sr-only">加载中...</span>
    </div>
  );
};

export default Loading;
