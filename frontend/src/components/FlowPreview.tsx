import React, { useMemo } from 'react';
import ReactFlow, { 
  Background, 
  BackgroundVariant,
  type Node,
  type Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { SourceNode, TargetNode, ProcessorNode } from './CustomNodes';

const nodeTypes = {
  sourceNode: SourceNode,
  targetNode: TargetNode,
  processorNode: ProcessorNode,
};

interface FlowPreviewProps {
  nodes?: Node[];
  edges?: Edge[];
}

export const FlowPreview: React.FC<FlowPreviewProps> = ({ nodes = [], edges = [] }) => {
  // Ensure we have arrays
  const safeNodes = useMemo(() => Array.isArray(nodes) ? nodes : [], [nodes]);
  const safeEdges = useMemo(() => Array.isArray(edges) ? edges : [], [edges]);

  return (
    <div className="w-full h-full bg-background">
      <ReactFlow
        nodes={safeNodes}
        edges={safeEdges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.5}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll={true}
        zoomOnScroll={true}
        panOnDrag={true}
        proOptions={{ hideAttribution: true }}
        attributionPosition="bottom-right"
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="var(--border-color)"
          gap={20}
          size={1}
        />
      </ReactFlow>
    </div>
  );
};
