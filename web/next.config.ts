import type { NextConfig } from "next";
import path from "node:path";

/**
 * NEXT_EXPORT=1 时产出纯静态站点（GitHub Pages 用）：
 *   NEXT_EXPORT=1 NEXT_PUBLIC_BASE_PATH=/ashare-trader NEXT_PUBLIC_API_URL=... bun run build
 * 页面全部是客户端渲染（SSE + REST），静态导出零损失；
 * 本地 `next start` 不受影响（不加 NEXT_EXPORT 时走普通构建）。
 */
const isExport = process.env.NEXT_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // The repo root also has a bun.lock; pin the workspace root to this app.
  turbopack: { root: path.resolve(__dirname) },
  ...(isExport ? { output: "export" as const, basePath, images: { unoptimized: true } } : {}),
  trailingSlash: isExport || undefined,
};

export default nextConfig;
