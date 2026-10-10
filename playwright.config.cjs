const {defineConfig} = require('@playwright/test');
module.exports = defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {baseURL: 'http://127.0.0.1:4173', headless: true},
  webServer: {command: 'node tests/server.cjs', url: 'http://127.0.0.1:4173', reuseExistingServer: false},
});
