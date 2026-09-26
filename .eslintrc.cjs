module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  overrides: [
    {
      // @netiflyjs/client ships browser-facing code built on the standard
      // WebSocket global, so its source needs browser globals (WebSocket,
      // CloseEvent, MessageEvent, ...) *in addition to* the repo-wide node
      // env above — its own tests still run in Node.
      files: ['packages/client/src/**/*.ts'],
      env: { browser: true },
    },
  ],
};
