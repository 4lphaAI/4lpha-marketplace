"use client";

import React from "react";
import { Icon } from "@/design-system";

export function TradeModelSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly disabledValue: string;
  readonly onChange: (value: string) => void;
}) {
  const id = `fl-sel-${props.label.replace(/\W+/gu, "-").toLowerCase()}`;
  return <div className="fl-field">
    <label className="fl-field__label" htmlFor={id}>{props.label}</label>
    <div className="fl-select-wrap">
      <select id={id} className="fl-select" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => <option key={option} value={option} disabled={option === props.disabledValue}>{option}</option>)}
      </select>
      <span className="fl-select__chev"><Icon name="chevron-down" size={15} /></span>
    </div>
  </div>;
}
