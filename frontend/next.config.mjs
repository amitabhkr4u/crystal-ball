const apiTarget = process.env.API_URL ?? "http://localhost:4000";

const nextConfig = {
  reactStrictMode: true,
  compress: true,
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
  }
};

export default nextConfig;
