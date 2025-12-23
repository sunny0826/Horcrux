import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { SyncIndicatorState } from '../types';

export interface NodeHandleConfig {
  type: 'source' | 'target';
  position: Position;
  id?: string;
  className?: string;
}

export interface BaseNodeProps {
  title: string;
  icon: React.ReactNode;
  label: string;
  subLabel?: string;
  syncState?: SyncIndicatorState;
  variant?: 'default' | 'processor';
  handles?: NodeHandleConfig[];
  className?: string;
  headerRight?: React.ReactNode;
  indicatorColor?: string;
  children?: React.ReactNode;
}

const getSyncStateClassName = (state?: SyncIndicatorState): string => {
  return state ? String(state) : 'idle';
};

export const BaseNode = memo(({
  title,
  icon,
  label,
  subLabel,
  syncState,
  variant = 'default',
  handles = [],
  className = '',
  headerRight,
  indicatorColor = 'bg-primary',
  children
}: BaseNodeProps) => {
  const isProcessor = variant === 'processor';
  
  // Base styles using CSS variables for theme consistency
  const containerBase = "min-w-[180px] rounded-sm shadow-lg transition-all duration-300 ease-out group relative backdrop-blur-sm";
  const containerColors = isProcessor
    ? "bg-panel/90 border border-primary/30 hover:border-primary hover:shadow-[0_0_15px_rgba(0,255,65,0.15)]"
    : "bg-background/90 border border-border hover:border-primary hover:shadow-[0_0_15px_rgba(0,255,65,0.1)]";

  const headerBase = "p-2.5 border-b flex items-center justify-between transition-colors duration-300";
  const headerColors = isProcessor
    ? "bg-primary/5 border-primary/20 group-hover:bg-primary/10"
    : "bg-panel border-border group-hover:bg-panel/80";

  const titleColor = isProcessor ? "text-primary/80" : "text-textMain/60";
  const contentColor = isProcessor ? "text-primary" : "text-textMain";
  const subContentColor = isProcessor ? "text-dim" : "text-textMain/40";

  return (
    <div className={`${containerBase} ${containerColors} ${className}`}>
      {/* Header Section */}
      <div className={headerBase + " " + headerColors}>
        <div className="flex items-center gap-2">
          {icon}
          <span className={`text-[9px] font-bold uppercase tracking-[0.15em] ${titleColor}`}>
            {title}
          </span>
        </div>
        
        {/* Header Right (Status or Custom) */}
        {headerRight ? headerRight : (
          <div 
            className={`w-2 h-2 rounded-full transition-all duration-300 hx-sync-indicator ${indicatorColor} ${getSyncStateClassName(syncState)}`}
            title={`Status: ${syncState || 'idle'}`}
          />
        )}
      </div>

      {/* Content Section */}
      <div className="p-3.5 space-y-2">
        <div className={`text-[11px] font-bold tracking-wide ${contentColor} truncate`} title={label}>
          {label}
        </div>
        {subLabel && (
          <div className={`text-[9px] font-mono truncate ${subContentColor}`} title={subLabel}>
            {subLabel}
          </div>
        )}
        {children}
      </div>

      {/* Handles */}
      {handles.map((handle, index) => (
        <Handle
          key={`${handle.type}-${index}`}
          type={handle.type}
          position={handle.position}
          id={handle.id}
          className={`
            w-2.5 h-2.5 !border-none rounded-none rotate-45 transition-all duration-300
            ${isProcessor ? '!bg-primary' : '!bg-primary'}
            hover:scale-125
            ${handle.className || ''}
          `}
        />
      ))}
    </div>
  );
});

BaseNode.displayName = 'BaseNode';
