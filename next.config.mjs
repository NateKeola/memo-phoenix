/** @type {import('next').NextConfig} */
const nextConfig = {
  // The miner engine lives in a workspace package (spec decision #10); transpile it.
  transpilePackages: ['@memo/miner-core'],
  experimental: {
    serverActions: {
      // The profile avatar upload (uploadAvatar) is a Server Action that carries the
      // image bytes. Next.js defaults the Server Action body limit to 1 MB, so any
      // photo over 1 MB threw "Body exceeded 1 MB limit" (a 413), which surfaced as
      // the /settings "Server Components render error" in production. The avatar cap
      // is 5 MB (client + bucket), so allow headroom above that for the multipart
      // envelope. This is the confirmed fix for that production error.
      bodySizeLimit: '6mb',
    },
  },
}

export default nextConfig
