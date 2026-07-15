const { merge } = require('webpack-merge');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const common = require('./webpack.common.js');

module.exports = merge(common, {
  mode: 'production',
  performance: {
    hints: false,
    maxEntrypointSize: 512000,
    maxAssetSize: 512000,
  },
  devtool: false,
  optimization: {
    minimize: true,
    // '...' keeps webpack's default Terser for JS; CssMinimizer covers the
    // extracted styles.css, which production mode does not minify by itself.
    minimizer: ['...', new CssMinimizerPlugin()],
  },
});
