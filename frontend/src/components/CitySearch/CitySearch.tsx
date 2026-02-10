import React, { useState, useCallback, useRef, useEffect } from 'react';
import { destinationApi } from '../../api';
import type { CitySearchResult } from '../../types';
import './CitySearch.css';

export interface CitySearchProps {
  onCitySelect: (city: CitySearchResult) => void;
  isLoading?: boolean;
  disabled?: boolean;
}

const CitySearch: React.FC<CitySearchProps> = ({
  onCitySelect,
  isLoading = false,
  disabled = false,
}) => {
  const [query, setQuery] = useState('');
  const [cities, setCities] = useState<CitySearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 防抖搜索
  const searchCities = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setCities([]);
      setShowDropdown(false);
      return;
    }

    setIsSearching(true);
    setError(null);

    try {
      const response = await destinationApi.searchCities(searchQuery);
      if (response.data.success) {
        setCities(response.data.cities);
        setShowDropdown(response.data.cities.length > 0);
      } else {
        setCities([]);
        setShowDropdown(false);
      }
    } catch (err) {
      setError('搜索失败，请重试');
      setCities([]);
      setShowDropdown(false);
    } finally {
      setIsSearching(false);
    }
  }, []);

  // 输入变化时触发防抖搜索
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    // 清除之前的定时器
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // 设置新的防抖定时器
    searchTimeoutRef.current = setTimeout(() => {
      searchCities(value);
    }, 300);
  }, [searchCities]);

  // 选择城市
  const handleCityClick = useCallback((city: CitySearchResult) => {
    setQuery(city.cityName);
    setShowDropdown(false);
    onCitySelect(city);
  }, [onCitySelect]);

  // 点击外部关闭下拉框
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // 键盘导航
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showDropdown || cities.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => (prev < cities.length - 1 ? prev + 1 : prev));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : prev));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < cities.length) {
          handleCityClick(cities[selectedIndex]);
        }
        break;
      case 'Escape':
        setShowDropdown(false);
        setSelectedIndex(-1);
        break;
    }
  }, [showDropdown, cities, selectedIndex, handleCityClick]);

  // 重置选中索引
  useEffect(() => {
    setSelectedIndex(-1);
  }, [cities]);

  return (
    <div className="city-search">
      <div className="city-search__input-wrapper">
        <input
          ref={inputRef}
          type="text"
          className="city-search__input"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => cities.length > 0 && setShowDropdown(true)}
          placeholder="杭州、成都、大理..."
          disabled={disabled || isLoading}
          aria-label="搜索城市"
          aria-expanded={showDropdown}
          aria-haspopup="listbox"
          autoComplete="off"
        />
        {isSearching ? (
          <span className="city-search__spinner" />
        ) : (
          <button 
            type="button"
            className="city-search__search-btn"
            onClick={() => searchCities(query)}
            disabled={disabled || isLoading || !query.trim()}
            aria-label="搜索"
          >
            ⌕
          </button>
        )}
      </div>

      {error && <p className="city-search__error">{error}</p>}

      {showDropdown && cities.length > 0 && (
        <div
          ref={dropdownRef}
          className="city-search__dropdown"
          role="listbox"
          aria-label="城市搜索结果"
        >
          {cities.map((city, index) => (
            <div
              key={`${city.cityName}-${city.province}`}
              className={`city-search__item ${selectedIndex === index ? 'city-search__item--selected' : ''}`}
              onClick={() => handleCityClick(city)}
              role="option"
              aria-selected={selectedIndex === index}
            >
              <div className="city-search__item-main">
                <span className="city-search__item-name">{city.cityName}</span>
                <span className="city-search__item-province">{city.province}</span>
              </div>
              <p className="city-search__item-desc">{city.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CitySearch;
