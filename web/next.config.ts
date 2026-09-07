import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  agentRules: false,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
