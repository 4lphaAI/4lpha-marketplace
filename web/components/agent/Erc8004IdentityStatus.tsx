import React from "react";
import { erc8004TokenUrl, parseErc8004Identity, type Erc8004Identity } from "@/lib/exec/erc8004-identity";

export function Erc8004IdentityStatus({ identity }: { readonly identity?: Erc8004Identity }) {
  const checked = parseErc8004Identity(identity);
  if (checked === undefined) return null;
  const url = erc8004TokenUrl(checked);
  return <div role="status" style={{ font: "var(--type-mono-xs)", color: checked.status === "blocked" ? "var(--warning)" : "var(--text-subtle)", overflowWrap: "anywhere" }}>
    {url === null
      ? <span>{checked.status === "blocked" ? "ERC-8004 registration needs attention" : "ERC-8004 registration pending"}</span>
      : <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>ERC-8004 #{"agentId" in checked ? checked.agentId : ""}</a>}
  </div>;
}
