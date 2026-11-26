import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Type errors must fail the build. (Previously `ignoreBuildErrors: true`
  // hid real errors.)
  reactStrictMode: false,
  // Prisma's engine/adapter must be loaded natively, not bundled by webpack/turbopack.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-libsql", "@libsql/client"],
};

export default nextConfig;
