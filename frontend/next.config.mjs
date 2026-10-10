/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard is a private tool: keep it out of search engines.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};
export default nextConfig;
