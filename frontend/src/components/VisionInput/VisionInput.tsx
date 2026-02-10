import React, { useState, useCallback } from 'react';
import Button from '../Button/Button';
import './VisionInput.css';

export interface VisionInputProps {
  onSubmit: (text: string) => void;
  isLoading?: boolean;
  error?: string | null;
  disabled?: boolean;
}

const MAX_LENGTH = 500;

// 更有意境的灵感标签
const EXAMPLE_VISIONS = [
  '雪山与星空',
  '海边日落',
  '古镇烟雨',
  '寻味之旅',
  '山间云海',
];

const VisionInput: React.FC<VisionInputProps> = ({
  onSubmit,
  isLoading = false,
  error = null,
  disabled = false,
}) => {
  const [text, setText] = useState('');

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length <= MAX_LENGTH) {
      setText(value);
    }
  }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmedText = text.trim();
    if (trimmedText && !isLoading && !disabled) {
      onSubmit(trimmedText);
    }
  }, [text, isLoading, disabled, onSubmit]);

  const handleExampleClick = useCallback((example: string) => {
    if (!isLoading && !disabled) {
      setText(example);
    }
  }, [isLoading, disabled]);

  const charCount = text.length;
  const isNearLimit = charCount >= MAX_LENGTH * 0.8;
  const isAtLimit = charCount >= MAX_LENGTH;
  const isValid = text.trim().length > 0;

  return (
    <form className="vision-input-container" onSubmit={handleSubmit}>
      <div className="vision-input-wrapper">
        <textarea
          className={`vision-textarea ${error ? 'has-error' : ''}`}
          value={text}
          onChange={handleTextChange}
          placeholder="写下你对远方的想象..."
          disabled={isLoading || disabled}
          aria-label="旅行愿景描述"
          aria-invalid={!!error}
          aria-describedby={error ? 'vision-error' : undefined}
        />
        <div className="vision-textarea-line" />
        <span
          className={`vision-char-count ${isNearLimit ? 'near-limit' : ''} ${isAtLimit ? 'at-limit' : ''}`}
        >
          {charCount}/{MAX_LENGTH}
        </span>
      </div>

      {error && (
        <p id="vision-error" className="vision-error" role="alert">
          {error}
        </p>
      )}

      {/* 鹅卵石灵感标签 */}
      <div className="vision-pebbles">
        {EXAMPLE_VISIONS.map((example, index) => (
          <button
            key={index}
            type="button"
            className="vision-pebble"
            onClick={() => handleExampleClick(example)}
            disabled={isLoading || disabled}
            style={{
              // 略微随机的位置偏移，营造散落感
              transform: `rotate(${(index % 2 === 0 ? -1 : 1) * (index * 1.5)}deg)`,
            }}
          >
            {example}
          </button>
        ))}
      </div>

      {/* 按钮 - 卡片底部居中 */}
      <div className="vision-submit-wrapper">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={isLoading}
          disabled={!isValid || disabled}
        >
          开始探索
        </Button>
      </div>
    </form>
  );
};

export default VisionInput;
