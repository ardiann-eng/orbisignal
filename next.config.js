/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      'prisma',
      '@prisma/client',
      'pino',
      'pino-pretty',
      'ccxt',
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...config.externals,
        'canvas',
        'chartjs-node-canvas',
      ];
    }
    return config;
  },
}

module.exports = nextConfig
