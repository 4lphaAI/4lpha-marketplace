"use client";
/* Ported verbatim from the Claude Design export (design system bundle
   Ds4lphaMarketplaceDesignSystem_2fcb39). Component bodies are byte-identical to
   the export; only the IIFE/namespace wrapper was replaced by ES exports. */
import React from "react";

const __ds_ns = { __errors: [] };
const __ds_scope = {};

// components/badges/Num.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Every number a user might compare. Mono, tabular, signed, coloured by tone. */
function Num({
  value,
  tone = "auto",
  sign,
  size,
  style,
  className = "",
  ...rest
}) {
  let resolved = tone;
  if (tone === "auto") {
    const s = String(value);
    resolved = s.trim().startsWith("-") ? "loss" : s.trim().startsWith("+") ? "profit" : "flat";
  }
  const showSign = sign && typeof value === "number" && value > 0;
  return /*#__PURE__*/React.createElement("span", _extends({
    className: `fl-num fl-num--${resolved} ${className}`,
    style: {
      fontSize: size,
      ...style
    }
  }, rest), showSign ? "+" : "", value);
}
Object.assign(__ds_scope, { Num });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/badges/Num.jsx", error: String((e && e.message) || e) }); }

// components/badges/StatusBadge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const LABELS = {
  live: "Live",
  paused: "Paused",
  warning: "Attention",
  danger: "Stopped"
};

/** Agent run state. The dot is the primary signal; the word is the confirmation. */
function StatusBadge({
  status = "live",
  label,
  pill,
  ...rest
}) {
  const cls = ["fl-status", `fl-status--${status}`, pill ? "fl-status--pill" : ""].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "fl-status__dot"
  }), label || LABELS[status]);
}
Object.assign(__ds_scope, { StatusBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/badges/StatusBadge.jsx", error: String((e && e.message) || e) }); }

// components/categories.js
try { (() => {
/** The four agent categories. Colour, icon and headline-metric label are fixed per category. */
const CATEGORIES = {
  grid: {
    id: "grid",
    label: "Grid Agent",
    icon: "grid-trading",
    color: "var(--cat-grid)",
    tint: "var(--cat-grid-tint)",
    metricLabel: "30d PnL"
  },
  trading: {
    id: "trading",
    label: "Trading Agent",
    icon: "yield",
    color: "var(--cat-yield)",
    tint: "var(--cat-yield-tint)",
    metricLabel: "30d PnL"
  },
  lp: {
    id: "lp",
    label: "LP Agent",
    icon: "lp-rebalance",
    color: "var(--cat-lp)",
    tint: "var(--cat-lp-tint)",
    metricLabel: "Fees earned vs IL"
  },
  health: {
    id: "health",
    label: "Lending Agent",
    icon: "health-shield",
    color: "var(--cat-health)",
    tint: "var(--cat-health-tint)",
    metricLabel: "Positions saved"
  }
};
const CATEGORY_LIST = Object.values(CATEGORIES);
function category(id) {
  return CATEGORIES[id] || CATEGORIES.grid;
}

/** Capitalized alias so the compiled bundle exposes it. */
const Category = category;
Object.assign(__ds_scope, { CATEGORIES, CATEGORY_LIST, category, Category });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/categories.js", error: String((e && e.message) || e) }); }

// components/badges/FilterChip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Marketplace filter chip. `categoryId` adds the category dot; omit it for "All". */
function FilterChip({
  label,
  categoryId,
  count,
  active,
  onClick,
  ...rest
}) {
  const cat = categoryId ? __ds_scope.category(categoryId) : null;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    "aria-pressed": !!active,
    className: `fl-chip${active ? " fl-chip--active" : ""}`,
    onClick: onClick
  }, rest), cat && /*#__PURE__*/React.createElement("span", {
    className: "fl-chip__dot",
    style: {
      background: cat.color
    }
  }), label || (cat ? cat.label : "All"), count != null && /*#__PURE__*/React.createElement("span", {
    className: "fl-chip__count"
  }, count));
}
Object.assign(__ds_scope, { FilterChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/badges/FilterChip.jsx", error: String((e && e.message) || e) }); }

// components/data/ChartFrame.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function path(values, w, h, pad) {
  const min = Math.min(...values),
    max = Math.max(...values);
  const span = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1 || 1);
  return values.map((v, i) => `${i ? "L" : "M"}${(pad + i * step).toFixed(1)} ${(pad + (1 - (v - min) / span) * (h - pad * 2)).toFixed(1)}`).join(" ");
}

/** Bordered chart container with an optional area sparkline and a degraded-data footer. */
function ChartFrame({
  title,
  value,
  valueTone = "flat",
  right,
  series,
  height = 160,
  axis,
  stale,
  color = "var(--chart-line)",
  children,
  ...rest
}) {
  const w = 600,
    pad = 6;
  const line = series && series.length ? path(series, w, height, pad) : null;
  const tone = valueTone === "profit" ? "var(--profit)" : valueTone === "loss" ? "var(--loss)" : "var(--ink-1)";
  return /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-chart"
  }, rest), (title || right) && /*#__PURE__*/React.createElement("div", {
    className: "fl-chart__head"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-3)"
    }
  }, title && /*#__PURE__*/React.createElement("span", {
    className: "fl-chart__title"
  }, title), value != null && /*#__PURE__*/React.createElement("span", {
    className: "fl-chart__value",
    style: {
      color: tone
    }
  }, value)), right), /*#__PURE__*/React.createElement("div", {
    className: "fl-chart__body"
  }, children, line && /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${height}`,
    width: "100%",
    height: height,
    preserveAspectRatio: "none",
    "aria-hidden": "true",
    style: {
      display: "block",
      overflow: "visible"
    }
  }, [0.25, 0.5, 0.75].map(f => /*#__PURE__*/React.createElement("line", {
    key: f,
    x1: "0",
    x2: w,
    y1: height * f,
    y2: height * f,
    stroke: "var(--chart-grid)",
    strokeWidth: "1"
  })), /*#__PURE__*/React.createElement("path", {
    d: `${line} L${w - pad} ${height - pad} L${pad} ${height - pad} Z`,
    fill: "var(--chart-area)",
    stroke: "none"
  }), /*#__PURE__*/React.createElement("path", {
    d: line,
    fill: "none",
    stroke: color,
    strokeWidth: "1.5",
    strokeLinejoin: "round",
    vectorEffect: "non-scaling-stroke"
  })), axis && /*#__PURE__*/React.createElement("div", {
    className: "fl-chart__axis"
  }, axis.map(a => /*#__PURE__*/React.createElement("span", {
    key: a
  }, a)))), stale && /*#__PURE__*/React.createElement("div", {
    className: "fl-chart__stale"
  }, stale));
}
Object.assign(__ds_scope, { ChartFrame });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/ChartFrame.jsx", error: String((e && e.message) || e) }); }

// components/data/MetricTile.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Summary number with an uppercase mono label. Used in rows of 3–4. */
function MetricTile({
  label,
  value,
  tone = "flat",
  delta,
  deltaTone = "auto",
  note,
  icon,
  size = "md",
  plain,
  credit,
  ...rest
}) {
  const cls = ["fl-metric", plain ? "fl-metric--plain" : "", size === "sm" ? "fl-metric--sm" : ""].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "fl-metric__label"
  }, icon, label), /*#__PURE__*/React.createElement("span", {
    className: "fl-metric__value"
  }, /*#__PURE__*/React.createElement(__ds_scope.Num, {
    value: value,
    tone: tone
  })), (delta || note) && /*#__PURE__*/React.createElement("span", {
    className: "fl-metric__foot"
  }, delta && /*#__PURE__*/React.createElement(__ds_scope.Num, {
    value: delta,
    tone: deltaTone
  }), note), credit || null);
}
Object.assign(__ds_scope, { MetricTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/MetricTile.jsx", error: String((e && e.message) || e) }); }

// components/data/Skeleton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Loading placeholder. Mirrors the shape of the content it replaces. */
function Skeleton({
  w = "100%",
  h = 12,
  radius = "var(--radius-xs)",
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: "fl-skel",
    style: {
      display: "block",
      width: w,
      height: h,
      borderRadius: radius,
      ...style
    }
  }, rest));
}

/** Agent-card-shaped skeleton for the marketplace grid. */
function SkeletonCard({
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-skel--card"
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Skeleton, {
    w: 32,
    h: 32,
    radius: "var(--radius-sm)"
  }), /*#__PURE__*/React.createElement(Skeleton, {
    w: 54,
    h: 20,
    radius: "var(--radius-pill)"
  })), /*#__PURE__*/React.createElement(Skeleton, {
    w: "62%",
    h: 14
  }), /*#__PURE__*/React.createElement(Skeleton, {
    w: "100%",
    h: 10
  }), /*#__PURE__*/React.createElement(Skeleton, {
    w: "78%",
    h: 10
  }), /*#__PURE__*/React.createElement(Skeleton, {
    w: "100%",
    h: 58,
    radius: "var(--radius-sm)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      gap: 12,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement(Skeleton, {
    w: 80,
    h: 16
  }), /*#__PURE__*/React.createElement(Skeleton, {
    w: 92,
    h: 28,
    radius: "var(--radius-sm)"
  })));
}

/** Metric-tile-shaped skeleton. */
function SkeletonMetric({
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-skel--card",
    style: {
      gap: "var(--space-4)"
    }
  }, rest), /*#__PURE__*/React.createElement(Skeleton, {
    w: 92,
    h: 9
  }), /*#__PURE__*/React.createElement(Skeleton, {
    w: 132,
    h: 24
  }), /*#__PURE__*/React.createElement(Skeleton, {
    w: 70,
    h: 9
  }));
}
Object.assign(__ds_scope, { Skeleton, SkeletonCard, SkeletonMetric });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Skeleton.jsx", error: String((e && e.message) || e) }); }

// components/icons/Icon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const PATHS = {
  "grid-trading": `<path d="M4.9 6.6h14.2"/><path d="M4.9 17.4h14.2"/><path d="M6.1 13.6 10.1 9.6 13.8 13.3 17.7 9.6"/>`,
  "lp-rebalance": `<path d="M12 8.4c-1.9 2.2-3.1 3.7-3.1 5.1a3.1 3.1 0 0 0 6.2 0c0-1.4-1.2-2.9-3.1-5.1z"/><path d="M5.76 8.4A7.2 7.2 0 0 1 19.2 12"/><path d="M7.84 7.2 5.76 8.4 5.76 6"/><path d="M4.8 12a7.2 7.2 0 0 0 13.44 3.6"/><path d="M16.16 16.8 18.24 15.6 18.24 18"/>`,
  "yield": `<rect x="4.4" y="15.6" width="4" height="4.8" rx="0.8"/><rect x="10" y="13" width="4" height="7.4" rx="0.8"/><rect x="15.6" y="10" width="4" height="10.4" rx="0.8"/><path d="M4.4 12.6 19.4 4.2"/><path d="M16.61 4.07 19.4 4.2 18.06 6.65"/>`,
  "health-shield": `<path d="M12 3.1 4.8 5.9v6c0 4.4 3.1 7.6 7.2 9 4.1-1.4 7.2-4.6 7.2-9v-6z"/><path d="M10.75 8.8h2.5v2.15h2.15v2.5h-2.15v2.15h-2.5v-2.15H8.6v-2.5h2.15z" fill="currentColor" stroke="none"/>`,
  "wallet": `<rect x="3" y="5.6" width="18" height="12.8" rx="2.4"/><path d="M3 10.1h18"/><circle cx="16.6" cy="14.6" r="1.3" fill="currentColor" stroke="none"/>`,
  "activate": `<path d="M12 3.6v6.2"/><path d="M6.9 7.6a7.4 7.4 0 1 0 10.2 0"/>`,
  "pause": `<path d="M9.5 5v14M14.5 5v14"/>`,
  "key": `<circle cx="8.4" cy="15.6" r="3.6"/><path d="M11 13 20 4M16.4 7.6l2.4 2.4M14.4 9.6l2 2"/>`,
  "revoke": `<circle cx="12" cy="12" r="8.6"/><path d="M6.4 17.6 17.6 6.4"/>`,
  "live": `<circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 15.8a5.4 5.4 0 0 0 0-7.6M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 18.6a9.3 9.3 0 0 0 0-13.2"/>`,
  "verified": `<path d="M8.8 3.5h6.4l4.3 4.3v6.4l-4.3 4.3H8.8l-4.3-4.3V7.8z"/><path d="M8.9 11.9l2.4 2.4 4.4-4.8"/>`,
  "identity": `<path d="M12 3.2l7.4 4.3v8.6L12 20.4 4.6 16.1V7.5z"/><path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z"/>`,
  "payment": `<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2v9.6M9.4 10.1h5.2M9.4 13.9h5.2"/>`,
  "activity": `<circle cx="4.6" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.6" cy="17" r="1.2" fill="currentColor" stroke="none"/><path d="M8.2 7h12M8.2 12h9M8.2 17h11"/>`,
  "search": `<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.4 15.4 20.5 20.5"/>`,
  "filter": `<path d="M3.6 5.6h16.8l-6.5 7.7v5.5l-3.8 2.2v-7.7z"/>`,
  "settings": `<path d="M3.5 8h5M12.5 8h8M3.5 16h9M16.5 16h4"/><circle cx="10.5" cy="8" r="2"/><circle cx="14.5" cy="16" r="2"/>`,
  "sort": `<path d="M6 4.6v14.8M3 16.4l3 3 3-3M18 19.4V4.6M15 7.6l3-3 3 3"/>`,
  "external": `<path d="M13.6 4.6h5.8v5.8M19.4 4.6 11 13"/><path d="M18 13.6v4.4a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V7.5A1.5 1.5 0 0 1 6 6h4.4"/>`,
  "warning": `<path d="M12 4.2 21 19.3H3z"/><path d="M12 9.6v4.2"/><circle cx="12" cy="16.7" r="1.1" fill="currentColor" stroke="none"/>`,
  "success": `<circle cx="12" cy="12" r="8.6"/><path d="M8.3 12.2l2.7 2.7 4.9-5.6"/>`,
  "info": `<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5.4"/><circle cx="12" cy="8.2" r="1.1" fill="currentColor" stroke="none"/>`,
  "refresh": `<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.2V9h-4.8"/>`,
  "clock": `<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.3 2"/>`,
  "copy": `<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M5.5 15.5A1.5 1.5 0 0 1 4 14V6a1.5 1.5 0 0 1 1.5-1.5H14A1.5 1.5 0 0 1 15.5 6"/>`,
  "chevron-right": `<path d="M10 7l5 5-5 5"/>`,
  "chevron-down": `<path d="M7 10l5 5 5-5"/>`,
  "close": `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  "plus": `<path d="M12 5v14M5 12h14"/>`,
  "arrow-right": `<path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5"/>`
};
const iconNames = Object.keys(PATHS);
/** Capitalized alias so the compiled bundle exposes it. */
const IconNames = iconNames;

/** 4lpha icon. 24px geometric grid, 1.75px stroke, currentColor. */
function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  color,
  style,
  className,
  title,
  ...rest
}) {
  const d = PATHS[name];
  if (!d) return null;
  return /*#__PURE__*/React.createElement("svg", _extends({
    className: className,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color || "currentColor",
    strokeWidth: strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": title ? undefined : true,
    role: title ? "img" : undefined,
    style: {
      display: "block",
      flex: "0 0 auto",
      ...style
    },
    dangerouslySetInnerHTML: {
      __html: (title ? `<title>${title}</title>` : "") + d
    }
  }, rest));
}
Object.assign(__ds_scope, { iconNames, IconNames, Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/icons/Icon.jsx", error: String((e && e.message) || e) }); }

// components/agents/PermissionItem.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const MARK = {
  allow: "success",
  deny: "close",
  info: "info"
};

/** A permission written as a sentence a non-crypto user can check. Never shows a hex address. */
function PermissionItem({
  kind = "allow",
  children,
  note,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-perm"
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: `fl-perm__mark fl-perm__mark--${kind}`
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: MARK[kind],
    size: 13
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "fl-perm__text"
  }, children), note && /*#__PURE__*/React.createElement("div", {
    className: "fl-perm__note"
  }, note)));
}
Object.assign(__ds_scope, { PermissionItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agents/PermissionItem.jsx", error: String((e && e.message) || e) }); }

// components/agents/StepIndicator.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Three-step progress for the hire flow. Steps are labelled, never numbered only. */
function StepIndicator({
  steps = [],
  current = 0,
  compact,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-steps"
  }, rest), steps.map((s, i) => {
    const done = i < current,
      active = i === current;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: s
    }, i > 0 && /*#__PURE__*/React.createElement("span", {
      className: "fl-steps__bar"
    }), /*#__PURE__*/React.createElement("span", {
      className: "fl-steps__item"
    }, /*#__PURE__*/React.createElement("span", {
      className: `fl-steps__dot${active ? " fl-steps__dot--active" : ""}${done ? " fl-steps__dot--done" : ""}`
    }, done ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: "success",
      size: 12
    }) : i + 1), (!compact || active) && /*#__PURE__*/React.createElement("span", {
      className: `fl-steps__label${active ? " fl-steps__label--active" : ""}`
    }, s)));
  }));
}
Object.assign(__ds_scope, { StepIndicator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agents/StepIndicator.jsx", error: String((e && e.message) || e) }); }

// components/badges/TierBadge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Provenance of an agent: audited by 4lpha, or discovered in the ERC-8004 registry. */
function TierBadge({
  tier = "verified",
  label,
  ...rest
}) {
  const verified = tier === "verified";
  return /*#__PURE__*/React.createElement("span", _extends({
    className: `fl-tier fl-tier--${verified ? "verified" : "registry"}`
  }, rest), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: verified ? "verified" : "identity",
    size: 12
  }), label || (verified ? "Verified" : "Registry"));
}
Object.assign(__ds_scope, { TierBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/badges/TierBadge.jsx", error: String((e && e.message) || e) }); }

// components/data/ActivityRow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** One on-chain event. Feed variant for agent detail, timeline variant for a hired agent's run log. */
function ActivityRow({
  title,
  detail,
  time,
  icon = "activity",
  tone = "default",
  txHash,
  href,
  timeline,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: `fl-activity${timeline ? " fl-activity--timeline" : ""}`
  }, rest), timeline ? /*#__PURE__*/React.createElement("div", {
    className: "fl-activity__rail"
  }, /*#__PURE__*/React.createElement("span", {
    className: `fl-activity__node${tone !== "default" ? ` fl-activity__node--${tone}` : ""}`
  })) : /*#__PURE__*/React.createElement("span", {
    className: "fl-activity__icon",
    style: tone !== "default" ? {
      color: `var(--${tone})`,
      borderColor: "currentColor"
    } : undefined
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 14
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "fl-activity__title"
  }, title), detail && /*#__PURE__*/React.createElement("div", {
    className: "fl-activity__detail"
  }, detail)), /*#__PURE__*/React.createElement("div", {
    className: "fl-activity__aside"
  }, /*#__PURE__*/React.createElement("span", null, time), txHash && /*#__PURE__*/React.createElement("a", {
    className: "fl-activity__link",
    href: href || "#",
    target: "_blank",
    rel: "noreferrer",
    title: "View on BscScan"
  }, txHash, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "external",
    size: 12
  }))));
}
Object.assign(__ds_scope, { ActivityRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/ActivityRow.jsx", error: String((e && e.message) || e) }); }

// components/data/DenseRow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Dense bordered row — the My Agents dashboard list. Not a card. */
function DenseRow({
  name,
  categoryId,
  status = "live",
  statusLabel,
  statusLine,
  value,
  valueTone = "auto",
  valueSub,
  actions,
  warning,
  onClick,
  ...rest
}) {
  const cat = __ds_scope.category(categoryId);
  return /*#__PURE__*/React.createElement("div", _extends({
    className: `fl-row${warning ? " fl-row--warning" : ""}`,
    onClick: onClick
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "fl-row__main"
  }, /*#__PURE__*/React.createElement(__ds_scope.StatusBadge, {
    status: warning ? "warning" : status,
    label: statusLabel || "",
    "aria-label": status
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: cat.color,
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: cat.icon,
    size: 30
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "fl-row__name"
  }, name), /*#__PURE__*/React.createElement("div", {
    className: "fl-row__sub"
  }, statusLine))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "fl-row__num"
  }, /*#__PURE__*/React.createElement(__ds_scope.Num, {
    value: value,
    tone: valueTone
  })), valueSub && /*#__PURE__*/React.createElement("div", {
    className: "fl-row__num-sub"
  }, valueSub)), /*#__PURE__*/React.createElement("div", {
    className: "fl-row__actions"
  }, actions));
}

/** Column header for a DenseRow list. */
function DenseRowHeader({
  columns = ["Agent", "PnL", ""]
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "fl-row__head"
  }, columns.map((c, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      textAlign: i === 1 ? "right" : "left"
    }
  }, c)));
}
Object.assign(__ds_scope, { DenseRow, DenseRowHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/DenseRow.jsx", error: String((e && e.message) || e) }); }

// components/feedback/EmptyState.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Empty state: always names the next step, never just says "nothing here". */
function EmptyState({
  icon = "wallet",
  title,
  children,
  action,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-empty"
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "fl-empty__icon"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-4)",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "fl-empty__title"
  }, title), children && /*#__PURE__*/React.createElement("p", {
    className: "fl-empty__body"
  }, children)), action);
}
Object.assign(__ds_scope, { EmptyState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/EmptyState.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const ICONS = {
  success: "success",
  warning: "warning",
  danger: "warning",
  info: "info"
};

/** Short confirmation of something that happened on-chain. */
function Toast({
  tone = "success",
  title,
  detail,
  action,
  onClose,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: `fl-toast fl-toast--${tone}`,
    role: "status"
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "fl-toast__icon"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: ICONS[tone],
    size: 16
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "fl-toast__title"
  }, title), detail && /*#__PURE__*/React.createElement("div", {
    className: "fl-toast__detail"
  }, detail)), action, onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "fl-iconbtn fl-iconbtn--sm",
    "aria-label": "Dismiss",
    onClick: onClose
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "close",
    size: 13
  })));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/primitives/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Primary action. Gold is reserved for the single most important action on a screen. */
function Button({
  variant = "primary",
  size = "md",
  block,
  icon,
  iconRight,
  children,
  className = "",
  ...rest
}) {
  const cls = ["fl-btn", `fl-btn--${variant}`, size !== "md" ? `fl-btn--${size}` : "", block ? "fl-btn--block" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    className: cls
  }, rest), icon, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/primitives/Button.jsx", error: String((e && e.message) || e) }); }

// components/protocolLogos.js
try { (() => {
// Maps a protocol/venue display name to its logo asset. Used wherever a
// protocol name would otherwise render as plain text in a meta row.
// The export read these off `window.__resources`; the same bytes ship from
// `public/design/protocols/`, so the src is a plain URL (as in lib/logo.ts).
const PROTOCOL_LOGOS = {
  "PancakeSwap v3": "/design/protocols/pancakeswap.png",
  "PancakeSwap": "/design/protocols/pancakeswap.png",
  "Venus": "/design/protocols/venus.png",
  "Four.meme": "/design/protocols/fourmeme.png",
  "Flap.sh": "/design/protocols/flapsh.png",
  "bStocks": "/design/protocols/bstocks.png",
  "fourmeme": "/design/protocols/fourmeme.png",
  "flapsh": "/design/protocols/flapsh.png",
  "bstocks": "/design/protocols/bstocks.png"
};
Object.assign(__ds_scope, { PROTOCOL_LOGOS });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/protocolLogos.js", error: String((e && e.message) || e) }); }

// components/agents/AgentCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * The marketplace hero component. Answers three questions in one glance:
 * what is this agent, is it good, what does it cost.
 */
function AgentCard({
  name,
  categoryId,
  tagline,
  protocol,
  venues,
  relatedProtocols,
  status = "live",
  tier = "verified",
  metricLabel,
  metricValue,
  metricTone = "auto",
  hiredCount,
  price,
  priceUnit = "per month",
  onHire,
  onOpen,
  disabled,
  id,
  pair,
  dailyCap,
  statusLine,
  series,
  metrics,
  activity,
  value,
  valueSub,
  valueTone,
  warning,
  ...rest
}) {
  const cat = __ds_scope.category(categoryId);
  return /*#__PURE__*/React.createElement("article", _extends({
    className: "fl-card"
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "fl-card__head"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "var(--space-5)",
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "fl-card__glyph",
    style: {
      color: cat.color,
      borderColor: cat.color,
      background: cat.tint
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: cat.icon,
    size: 17
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "fl-card__name"
  }, name), /*#__PURE__*/React.createElement("div", {
    className: "fl-cat",
    style: {
      marginTop: 3
    }
  }, cat.label))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      gap: "var(--space-3)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.TierBadge, {
    tier: "verified"
  }))), /*#__PURE__*/React.createElement("p", {
    className: "fl-card__tagline"
  }, tagline), /*#__PURE__*/React.createElement("div", {
    className: "fl-card__meta"
  }, [protocol, ...(venues || []), ...(relatedProtocols || [])].filter(Boolean).map(v => __ds_scope.PROTOCOL_LOGOS[v] ? /*#__PURE__*/React.createElement("img", {
    key: v,
    src: __ds_scope.PROTOCOL_LOGOS[v],
    alt: v,
    title: v,
    className: "fl-card__protocol-logo"
  }) : /*#__PURE__*/React.createElement("span", {
    key: v
  }, v))), /*#__PURE__*/React.createElement("div", {
    className: "fl-card__headline"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fl-card__headline-label"
  }, metricLabel || cat.metricLabel), /*#__PURE__*/React.createElement("span", {
    className: "fl-card__headline-value"
  }, /*#__PURE__*/React.createElement(__ds_scope.Num, {
    value: metricValue,
    tone: metricTone
  }))), /*#__PURE__*/React.createElement("div", {
    className: "fl-card__foot"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fl-card__price"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fl-card__price-value"
  }, "0 Fees"), /*#__PURE__*/React.createElement("span", {
    className: "fl-card__price-unit"
  }, "this month")), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "primary",
    size: "sm",
    onClick: onHire,
    disabled: disabled
  }, "Hire Now")));
}
Object.assign(__ds_scope, { AgentCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agents/AgentCard.jsx", error: String((e && e.message) || e) }); }

// components/primitives/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Checkbox with a sentence label. `locked` shows a permission the user cannot switch off. */
function Checkbox({
  checked,
  locked,
  onChange,
  children,
  ...rest
}) {
  const on = locked ? true : checked;
  const cls = ["fl-check", on ? "fl-check--checked" : "", locked ? "fl-check--locked" : ""].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("label", _extends({
    className: cls
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "fl-check__box"
  }, on && /*#__PURE__*/React.createElement("svg", {
    width: "11",
    height: "9",
    viewBox: "0 0 12 10",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1.5 5.2L4.5 8.2L10.5 1.5"
  }))), /*#__PURE__*/React.createElement("span", null, children), /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!on,
    disabled: locked,
    onChange: e => onChange && onChange(e.target.checked),
    style: {
      position: "absolute",
      opacity: 0,
      width: 0,
      height: 0
    }
  }));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/primitives/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/primitives/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Square icon-only control for row actions and toolbars. */
function IconButton({
  label,
  size = "md",
  variant = "plain",
  children,
  className = "",
  ...rest
}) {
  const cls = ["fl-iconbtn", size === "sm" ? "fl-iconbtn--sm" : "", variant === "bordered" ? "fl-iconbtn--bordered" : "", variant === "danger" ? "fl-iconbtn--danger" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    className: cls,
    "aria-label": label,
    title: label
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/primitives/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Modal.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Centred modal on desktop; pass `sheet` for the mobile bottom-sheet form of the same content. */
function Modal({
  open = true,
  sheet,
  title,
  header,
  onClose,
  footer,
  children,
  width,
  ...rest
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: `fl-scrim${sheet ? " fl-scrim--sheet" : ""}`,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-modal",
    style: width ? {
      maxWidth: width
    } : undefined,
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
    onClick: e => e.stopPropagation()
  }, rest), sheet && /*#__PURE__*/React.createElement("div", {
    className: "fl-sheet__grip"
  }), /*#__PURE__*/React.createElement("div", {
    className: "fl-modal__head"
  }, header || /*#__PURE__*/React.createElement("span", {
    className: "fl-modal__title"
  }, title), onClose && /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Close",
    onClick: onClose
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "close",
    size: 16
  }))), /*#__PURE__*/React.createElement("div", {
    className: "fl-modal__body"
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    className: "fl-modal__foot"
  }, footer)));
}
Object.assign(__ds_scope, { Modal });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Modal.jsx", error: String((e && e.message) || e) }); }

// components/primitives/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Labelled text input. Numeric values get mono so they line up with the metrics they map to. */
function Input({
  label,
  hint,
  error,
  prefix,
  suffix,
  icon,
  mono,
  id,
  className = "",
  ...rest
}) {
  const inputId = id || (label ? `fl-${label.replace(/\W+/g, "-").toLowerCase()}` : undefined);
  const cls = ["fl-input", mono ? "fl-input--mono" : "", error ? "fl-input--invalid" : "", prefix || icon ? "fl-input--with-prefix" : "", suffix ? "fl-input--with-suffix" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    className: "fl-field"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "fl-field__label",
    htmlFor: inputId
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "fl-input-wrap"
  }, prefix && /*#__PURE__*/React.createElement("span", {
    className: "fl-input__affix fl-input__affix--prefix"
  }, prefix), icon && /*#__PURE__*/React.createElement("span", {
    className: "fl-input__icon"
  }, icon), /*#__PURE__*/React.createElement("input", _extends({
    id: inputId,
    className: cls
  }, rest)), suffix && /*#__PURE__*/React.createElement("span", {
    className: "fl-input__affix fl-input__affix--suffix"
  }, suffix)), (error || hint) && /*#__PURE__*/React.createElement("span", {
    className: `fl-field__hint${error ? " fl-field__hint--error" : ""}`
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/primitives/Input.jsx", error: String((e && e.message) || e) }); }

// components/primitives/SegmentedToggle.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Two-to-three option segmented control. Powers the Live / Paper switch and range pickers. */
function SegmentedToggle({
  options = [],
  value,
  onChange,
  accent,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: "fl-seg",
    role: "tablist"
  }, rest), options.map(o => {
    const opt = typeof o === "string" ? {
      value: o,
      label: o
    } : o;
    const active = opt.value === value;
    const cls = ["fl-seg__opt", active ? "fl-seg__opt--active" : "", active && accent ? "fl-seg__opt--accent" : ""].filter(Boolean).join(" ");
    return /*#__PURE__*/React.createElement("button", {
      key: opt.value,
      type: "button",
      role: "tab",
      "data-seg": opt.value,
      "aria-selected": active,
      className: cls,
      onClick: () => onChange && onChange(opt.value)
    }, opt.icon, opt.label);
  }));
}
Object.assign(__ds_scope, { SegmentedToggle });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/primitives/SegmentedToggle.jsx", error: String((e && e.message) || e) }); }

// components/primitives/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Native select with the 4lpha chevron. Used for sort controls and form pickers. */
function Select({
  label,
  hint,
  options = [],
  id,
  className = "",
  ...rest
}) {
  const selectId = id || (label ? `fl-sel-${label.replace(/\W+/g, "-").toLowerCase()}` : undefined);
  return /*#__PURE__*/React.createElement("div", {
    className: "fl-field"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "fl-field__label",
    htmlFor: selectId
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "fl-select-wrap"
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: selectId,
    className: `fl-select ${className}`
  }, rest), options.map(o => {
    const opt = typeof o === "string" ? {
      value: o,
      label: o
    } : o;
    return /*#__PURE__*/React.createElement("option", {
      key: opt.value,
      value: opt.value
    }, opt.label);
  })), /*#__PURE__*/React.createElement("span", {
    className: "fl-select__chev"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-down",
    size: 15
  }))), hint && /*#__PURE__*/React.createElement("span", {
    className: "fl-field__hint"
  }, hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/primitives/Select.jsx", error: String((e && e.message) || e) }); }

export const AgentCard = __ds_scope.AgentCard;
export const PROTOCOL_LOGOS = __ds_scope.PROTOCOL_LOGOS;
export const PermissionItem = __ds_scope.PermissionItem;
export const StepIndicator = __ds_scope.StepIndicator;
export const FilterChip = __ds_scope.FilterChip;
export const Num = __ds_scope.Num;
export const StatusBadge = __ds_scope.StatusBadge;
export const TierBadge = __ds_scope.TierBadge;
export const CATEGORIES = __ds_scope.CATEGORIES;
export const CATEGORY_LIST = __ds_scope.CATEGORY_LIST;
export const Category = __ds_scope.Category;
export const ActivityRow = __ds_scope.ActivityRow;
export const ChartFrame = __ds_scope.ChartFrame;
export const DenseRow = __ds_scope.DenseRow;
export const DenseRowHeader = __ds_scope.DenseRowHeader;
export const MetricTile = __ds_scope.MetricTile;
export const Skeleton = __ds_scope.Skeleton;
export const SkeletonCard = __ds_scope.SkeletonCard;
export const SkeletonMetric = __ds_scope.SkeletonMetric;
export const EmptyState = __ds_scope.EmptyState;
export const Modal = __ds_scope.Modal;
export const Toast = __ds_scope.Toast;
export const IconNames = __ds_scope.IconNames;
export const Icon = __ds_scope.Icon;
export const Button = __ds_scope.Button;
export const Checkbox = __ds_scope.Checkbox;
export const IconButton = __ds_scope.IconButton;
export const Input = __ds_scope.Input;
export const SegmentedToggle = __ds_scope.SegmentedToggle;
export const Select = __ds_scope.Select;
export const __errors = __ds_ns.__errors;
