export const ROUTES = {
  NAV: {
    PAIRS: '/pairs',
    LIQUIDITY: '/pairs/liquidity',
    ASSETS: '/assets',
    EXPLORER: '/explorer',
    EXPLORER_CHARTS: '/explorer/charts',
    EXPLORER_BEAM: '/explorer/beam',
    EXPLORER_BANS: '/explorer/bans',
    EXPLORER_COUNTDOWN: '/explorer/countdown',
    EXPLORER_HEALTH: '/explorer/health',
    EXPLORER_SUPPLY: '/explorer/supply',
    EXPLORER_BRIDGE: '/explorer/bridge',
    ASSET_INFO: '/asset/:id',
    PAIR_DETAIL: '/pair/:id',
    PRIVACY: '/privacy',
    // Legacy targets kept so existing dex-app components that import them
    // still compile during the strip. Unused at runtime.
    TRADE: '/pairs',
    POOLS: '/pairs',
    POOL: '/pairs',
  },
  POOLS: {
    BASE: '/pairs',
    CREATE_POOL: '/create',
    ADD_LIQUIDITY: '/add_liquidity',
    TRADE_POOL: '/trade_pool/',
    WITHDRAW_POOL: '/withdraw_pool/',
    ACCUMULATOR_REWARDS: '/accumulator_rewards/',
  },
};

export const ROUTES_PATH = {
  NAV: {
    TRADE: '/trade',
    POOLS: '/pools',
    POOL: '/pool',
    ASSET_INFO: '/asset/:id',
  },
  POOLS: {
    BASE: '/trade',
    CREATE_POOL: '/create',
    ADD_LIQUIDITY: '/add_liquidity',
    TRADE_POOL: '/trade_pool/',
    WITHDRAW_POOL: '/withdraw_pool/',
    ACCUMULATOR_REWARDS: '/accumulator_rewards/',
  },
};
