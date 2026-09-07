import type * as React from "react";

/**
 * Hand-written declarations for the ported Claude Design system bundle
 * (`design-system/index.js`). The bundle ships as pre-compiled
 * `React.createElement` JavaScript straight from the design export, so its
 * component signatures are declared loosely here rather than re-typed by hand;
 * re-typing 29 components would mean editing the exported bodies, which the
 * port deliberately keeps byte-identical.
 */

/** Loose props bag: every design-system component spreads unknown extra props. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DsProps = Record<string, any>;
type DsComponent = (props: DsProps) => React.ReactElement | null;

export interface DsCategory {
  id: string;
  label: string;
  icon: string;
  color: string;
  tint: string;
  metricLabel: string;
}

// components/agents
export const AgentCard: DsComponent;
export const PermissionItem: DsComponent;
export const StepIndicator: DsComponent;

// components/protocolLogos.js
export const PROTOCOL_LOGOS: Record<string, string>;

// components/badges
export const FilterChip: DsComponent;
export const Num: DsComponent;
export const StatusBadge: DsComponent;
export const TierBadge: DsComponent;

// components/categories.js
export const CATEGORIES: Record<string, DsCategory>;
export const CATEGORY_LIST: DsCategory[];
export function Category(id: string): DsCategory;

// components/data
export const ActivityRow: DsComponent;
export const ChartFrame: DsComponent;
export const DenseRow: DsComponent;
export const DenseRowHeader: DsComponent;
export const MetricTile: DsComponent;
export const Skeleton: DsComponent;
export const SkeletonCard: DsComponent;
export const SkeletonMetric: DsComponent;

// components/feedback
export const EmptyState: DsComponent;
export const Modal: DsComponent;
export const Toast: DsComponent;

// components/icons
export const IconNames: string[];
export const Icon: DsComponent;

// components/primitives
export const Button: DsComponent;
export const Checkbox: DsComponent;
export const IconButton: DsComponent;
export const Input: DsComponent;
export const SegmentedToggle: DsComponent;
export const Select: DsComponent;

/** Load errors captured by the bundle's own per-component try/catch. */
export const __errors: Array<{ path: string; error: string }>;
