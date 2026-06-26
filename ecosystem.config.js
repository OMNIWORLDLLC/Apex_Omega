module.exports = {
  apps: [
    {
      name: 'apex-engine',
      script: './src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'development',
        // Redis Route Guard – prevents duplicate route execution across worker
        // processes.  Set REDIS_URL and REDIS_PASSWORD to a shared Redis
        // instance when scaling to multiple PM2 instances (instances > 1).
        // Leave unset for single-instance deployments (no-op mode).
        REDIS_URL: process.env.REDIS_URL || '',
        REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
      },
      env_production: {
        NODE_ENV: 'production',
        REDIS_URL: process.env.REDIS_URL || '',
        REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
      }
    }
  ]
};
