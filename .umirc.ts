import { PRODUCT_NAME } from './back/shared/brand';
import { defineConfig } from '@umijs/max';
const CompressionPlugin = require('compression-webpack-plugin');

const baseUrl = process.env.QlBaseUrl || '/';
export default defineConfig({
  title: PRODUCT_NAME,
  metas: [
    { name: 'application-name', content: PRODUCT_NAME },
    { name: 'apple-mobile-web-app-title', content: PRODUCT_NAME },
    { property: 'og:site_name', content: PRODUCT_NAME },
  ],
  hash: true,
  jsMinifier: 'terser',
  antd: {},
  locale: {
    antd: true,
    title: true,
    // The product language controller resolves navigator.language centrally.
    baseNavigator: false,
  },
  outputPath: 'static/dist',
  fastRefresh: true,
  favicons: ['/favicon.svg'],
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
  proxy: {
    [`${baseUrl}api`]: {
      target: 'http://127.0.0.1:5700/',
      changeOrigin: true,
      ws: true,
      pathRewrite: { [`^${baseUrl}api`]: '/api' },
    },
  },
  chainWebpack: ((config: any) => {
    config.plugin('compression-webpack-plugin').use(
      new CompressionPlugin({
        algorithm: 'gzip',
        test: new RegExp('\\.(js|css)$'),
        threshold: 10240,
        minRatio: 0.6,
      }),
    );
  }) as any,
  headScripts: [`./api/env.js`],
  copy: [
    {
      from: 'node_modules/monaco-editor/min/vs',
      to: 'static/dist/monaco-editor/min/vs',
    },
  ],
  npmClient: 'pnpm',
});
