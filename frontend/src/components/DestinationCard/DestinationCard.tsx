import React, { useState } from 'react';
import type { DestinationCard as DestinationCardType } from '../../types';
import './DestinationCard.css';

export interface DestinationCardProps {
  destination: DestinationCardType;
  onSelect: (destination: DestinationCardType) => void;
  isSelected?: boolean;
  isLoading?: boolean;
  isExpanded?: boolean;
  isDimmed?: boolean;
  onHover?: (id: string | null) => void;
}

const DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800';

// 将匹配度转换为中文描述
const getMatchLabel = (score: number): string => {
  if (score >= 90) return '九成契合';
  if (score >= 80) return '八成契合';
  if (score >= 70) return '七成契合';
  if (score >= 60) return '六成契合';
  return '五成契合';
};

const DestinationCard: React.FC<DestinationCardProps> = ({
  destination,
  onSelect,
  isSelected = false,
  isLoading = false,
  isExpanded = false,
  isDimmed = false,
  onHover,
}) => {
  const [imageError, setImageError] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);

  const handleClick = () => {
    if (!isLoading) {
      onSelect(destination);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  const handleMouseEnter = () => {
    onHover?.(destination.id);
  };

  const handleMouseLeave = () => {
    onHover?.(null);
  };

  const handleImageError = () => {
    setImageError(true);
  };

  const handleShowDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDetailModal(true);
  };

  const handleCloseModal = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDetailModal(false);
  };

  const handleModalBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setShowDetailModal(false);
    }
  };

  const imageUrl = imageError || !destination.coverImageUrl 
    ? DEFAULT_IMAGE 
    : destination.coverImageUrl;

  const cardClasses = [
    'destination-card',
    isSelected && 'destination-card--selected',
    isLoading && 'destination-card--loading',
    isExpanded && 'destination-card--expanded',
    isDimmed && 'destination-card--dimmed',
    !isExpanded && !isDimmed && 'destination-card--default',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={cardClasses}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-busy={isLoading}
    >
      {/* 图片容器 */}
      <div className="destination-card__image-container">
        <img
          src={imageUrl}
          alt={`${destination.cityName}风景`}
          className="destination-card__image"
          loading="lazy"
          onError={handleImageError}
        />
        {/* 渐变蒙版 */}
        <div className="destination-card__overlay" />
      </div>

      {/* 印章 - 匹配度 */}
      <div className="destination-card__stamp">
        <span className="destination-card__stamp-score">
          {getMatchLabel(destination.matchScore)}
        </span>
      </div>

      {/* 选中印章 */}
      <div className="destination-card__selected-stamp">
        <span>✓</span>
      </div>

      {/* 城市名 - 竖排，省份在左，城市名在右 */}
      <div className="destination-card__city-vertical">
        <span className="destination-card__province">{destination.province}</span>
        <h3 className="destination-card__city">{destination.cityName}</h3>
      </div>

      {/* 详情内容 - 展开时显示 */}
      <div className="destination-card__content">
        <button 
          className="destination-card__detail-btn"
          onClick={handleShowDetail}
        >
          查看详情
        </button>
        <p className="destination-card__reason">
          {destination.recommendReason}
        </p>
        <div className="destination-card__tags">
          {destination.hotSpots.slice(0, 4).map((spot, index) => (
            <span key={index} className="destination-card__tag">
              {spot}
            </span>
          ))}
        </div>
      </div>

      {/* 详情弹窗 */}
      {showDetailModal && (
        <div 
          className="destination-card__modal-backdrop"
          onClick={handleModalBackdropClick}
        >
          <div className="destination-card__modal">
            <button 
              className="destination-card__modal-close"
              onClick={handleCloseModal}
              aria-label="关闭"
            >
              ×
            </button>
            
            <div className="destination-card__modal-header">
              <img 
                src={imageUrl} 
                alt={destination.cityName}
                className="destination-card__modal-image"
              />
              <div className="destination-card__modal-title-area">
                <h2 className="destination-card__modal-title">{destination.cityName}</h2>
                <span className="destination-card__modal-province">{destination.province}</span>
                <div className="destination-card__modal-score">
                  {getMatchLabel(destination.matchScore)}
                </div>
              </div>
            </div>
            
            <div className="destination-card__modal-body">
              <h3 className="destination-card__modal-section-title">推荐理由</h3>
              <p className="destination-card__modal-reason">
                {destination.recommendReason}
              </p>
              
              <h3 className="destination-card__modal-section-title">热门景点</h3>
              <div className="destination-card__modal-tags">
                {destination.hotSpots.map((spot, index) => (
                  <span key={index} className="destination-card__modal-tag">
                    {spot}
                  </span>
                ))}
              </div>
            </div>
            
            <div className="destination-card__modal-footer">
              <button 
                className="destination-card__modal-select-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClick();
                  setShowDetailModal(false);
                }}
              >
                {isSelected ? '✓ 已选择' : '选择此目的地'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DestinationCard;
