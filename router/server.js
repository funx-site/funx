'use strict';
// SCF Web function entry for funx-router. Listens on 9000 as SCF requires.
const http = require('http');
const { createRouter } = require('./router');
const { parseRoutes, ENV_KEY } = require('../lib/routes');

// The map is read once per instance: UpdateFunctionConfiguration recycles instances,
// so a deploy / disable takes effect within seconds.
const routes = parseRoutes(process.env[ENV_KEY] || '');
const accessLog = process.env.FUNX_ACCESS_LOG === '1';

const handler = createRouter({
  routes,
  baseDomain: process.env.FUNX_BASE_DOMAIN || 'funx.run',
  region: process.env.FUNX_REGION || 'ap-hongkong',
  // Minimal access log: site name, status, duration. Nothing else.
  log: accessLog ? (l) => console.log(JSON.stringify(l)) : undefined,
});

http.createServer(handler).listen(Number(process.env.PORT) || 9000, '0.0.0.0');
