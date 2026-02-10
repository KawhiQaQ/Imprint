import React from 'react';
import type { MemoirTemplate } from '../../types';
import './TemplateSelector.css';

export interface TemplateSelectorProps {
  templates: MemoirTemplate[];
  selectedTemplateId: string;
  onSelect: (templateId: string) => void;
  isLoading?: boolean;
}

const TemplateSelector: React.FC<TemplateSelectorProps> = ({
  templates,
  selectedTemplateId,
  onSelect,
  isLoading = false,
}) => {
  return (
    <div className="template-selector">
      <h3 className="template-selector__title">选择模板风格</h3>
      <div className="template-selector__grid">
        {(templates || []).map((template) => (
          <button
            key={template.id}
            className={`template-selector__item ${
              selectedTemplateId === template.id ? 'template-selector__item--selected' : ''
            }`}
            onClick={() => onSelect(template.id)}
            disabled={isLoading}
            type="button"
          >
            <div className="template-selector__preview">
              <div className={`template-selector__preview-inner ${template.cssClass}`}>
                <div className="template-selector__preview-header" />
                <div className="template-selector__preview-content">
                  <div className="template-selector__preview-line" />
                  <div className="template-selector__preview-line template-selector__preview-line--short" />
                </div>
              </div>
            </div>
            <span className="template-selector__name">{template.name}</span>
            {selectedTemplateId === template.id && (
              <span className="template-selector__check">✓</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default TemplateSelector;
