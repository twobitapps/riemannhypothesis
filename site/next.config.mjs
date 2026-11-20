/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: new URL('.', import.meta.url).pathname,
  images: { unoptimized: true },
};
export default nextConfig;
