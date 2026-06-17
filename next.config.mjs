/** @type {import('next').NextConfig} */
const nextConfig = {
  // The miner engine lives in a workspace package (spec decision #10); transpile it.
  transpilePackages: ['@memo/miner-core'],
}

export default nextConfig
