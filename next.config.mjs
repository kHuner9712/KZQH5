/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdfjs-dist ships ESM that Next.js's default webpack config cannot resolve
  // via deep subpaths (e.g. `pdfjs-dist/legacy/build/pdf.mjs`). Transpiling
  // the package lets webpack bundle the deep import correctly.
  transpilePackages: ["pdfjs-dist"],
  webpack: (config, { isServer }) => {
    // pdfjs-dist references Node built-ins (fs, http, https, url) which we
    // never use in the browser. Mark them as empty modules on the client.
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        http: false,
        https: false,
        url: false,
        canvas: false,
        path2d: false,
      };
    }
    return config;
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
      },
    ],
  },
};

export default nextConfig;
